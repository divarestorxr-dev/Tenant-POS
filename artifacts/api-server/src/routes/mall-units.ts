import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sseBroker } from "../lib/sse-broker";
import {
  mallUnitsTable,
  mallSitesTable,
  tenantBookingsTable,
  tenantInvoicesTable,
  tenantsTable,
  insertMallUnitSchema,
  UNIT_STATUSES,
  UNIT_TYPES,
  type UnitStatus,
} from "@workspace/db/schema";
import { eq, and, or, sql, desc, inArray } from "drizzle-orm";
import { requireAnyRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();

router.use("/mall-units", requireAnyRole("owner", "admin", "finance", "cashier"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

function computeUnitStatus(opts: {
  storedStatus: string;
  bookingContractStatus: string | null;
  bookingPaymentStatus: string | null;
  bookingStartDate: string | null;
  bookingEndDate: string | null;
  bookingDueDate: string | null;
  hasBooking: boolean;
  hasTenant: boolean;
  /** Status invoice terbaru — selalu akurat karena diupdate saat pembayaran diproses.
   *  Dipakai sebagai sinyal utama; bookingPaymentStatus sebagai fallback. */
  latestInvoiceStatus?: string | null;
  latestInvoiceDueDate?: string | null;
}): UnitStatus {
  const { storedStatus, hasBooking, hasTenant, bookingContractStatus, bookingPaymentStatus, bookingEndDate, bookingDueDate, latestInvoiceStatus, latestInvoiceDueDate } = opts;
  const todayStr = today();

  if (storedStatus === "maintenance") return "maintenance";
  // Jika admin secara eksplisit menandai unit sebagai "Kosong" (available),
  // override ini dihormati — sama seperti "maintenance". Booking yang ada tetap
  // tercatat di DB, hanya tampilan status unit yang berubah.
  if (storedStatus === "available") return "available";
  if (!hasBooking) {
    if (storedStatus === "occupied") return "occupied";
    if (hasTenant) return "occupied"; // tenant aktif di unit ini (via booth_number)
    return "available";
  }

  const endDate = bookingEndDate ?? "";
  const dueDate = bookingDueDate ?? "";

  if (endDate && endDate < todayStr) return "expired";
  if (bookingContractStatus === "terminated" || bookingContractStatus === "expired") return "expired";

  // Gunakan status invoice terbaru sebagai sinyal utama (selalu sinkron dengan pembayaran).
  // Fallback ke bookingPaymentStatus jika belum ada invoice.
  const invoiceStatus = (latestInvoiceStatus ?? "").toLowerCase();
  const effectiveDue = latestInvoiceDueDate ?? dueDate;

  let ps: string;
  if (invoiceStatus === "paid") {
    ps = "PAID";
  } else if (invoiceStatus === "overdue") {
    ps = "OVERDUE";
  } else if (invoiceStatus === "partial") {
    ps = "PARTIAL";
  } else if (invoiceStatus === "unpaid") {
    ps = "UNPAID";
  } else {
    // Tidak ada invoice — pakai paymentStatus dari booking
    ps = (bookingPaymentStatus ?? "").toUpperCase();
  }

  if (ps === "OVERDUE") return "overdue";
  if ((ps === "UNPAID" || ps === "PARTIAL") && effectiveDue && effectiveDue < todayStr) return "overdue";
  if (bookingContractStatus === "draft") return "booked";
  if (ps === "PAID" || ps === "PARTIAL") return "occupied";

  return "occupied";
}

// ─── GET /api/mall-units ──────────────────────────────────────────────────────
router.get("/mall-units", async (req, res) => {
  try {
    const siteId = req.siteId;
    const unitSiteFilter = siteId > 0 ? eq(mallUnitsTable.siteId, siteId) : undefined;
    const todayStr = today();

    const bookingConditions: any[] = [
      sql`${tenantBookingsTable.contractStatus} NOT IN ('terminated')`,
      sql`${tenantBookingsTable.endDate} >= ${todayStr} OR ${tenantBookingsTable.endDate} IS NULL`,
    ];
    if (siteId > 0) bookingConditions.push(eq(tenantBookingsTable.siteId, siteId));

    const tenantSiteFilter = siteId > 0 ? eq(tenantsTable.siteId, siteId) : undefined;
    const invoiceSiteFilter = siteId > 0 ? eq(tenantInvoicesTable.siteId, siteId) : undefined;

    // Keempat dataset tidak saling bergantung. Jalankan paralel agar latency
    // endpoint mengikuti query paling lambat, bukan total empat DB round-trip.
    const [units, bookings, tenants, invoices] = await Promise.all([
      db.select().from(mallUnitsTable)
        .where(unitSiteFilter)
        .orderBy(mallUnitsTable.positionY, mallUnitsTable.positionX),
      db
        .select({
          id: tenantBookingsTable.id,
          unitCode: tenantBookingsTable.unitCode,
          tenantId: tenantBookingsTable.tenantId,
          contractStatus: tenantBookingsTable.contractStatus,
          paymentStatus: tenantBookingsTable.paymentStatus,
          startDate: tenantBookingsTable.startDate,
          endDate: tenantBookingsTable.endDate,
          dueDate: tenantBookingsTable.dueDate,
          periodLabel: tenantBookingsTable.periodLabel,
          totalAmount: tenantBookingsTable.totalAmount,
          paidAmount: tenantBookingsTable.paidAmount,
          remainingAmount: tenantBookingsTable.remainingAmount,
        })
        .from(tenantBookingsTable)
        .where(and(...bookingConditions)),
      db.select().from(tenantsTable).where(tenantSiteFilter),
      db
        .select({
          bookingId: tenantInvoicesTable.bookingId,
          id: tenantInvoicesTable.id,
          status: tenantInvoicesTable.status,
          totalAmount: tenantInvoicesTable.totalAmount,
          outstandingAmount: tenantInvoicesTable.outstandingAmount,
          dueDate: tenantInvoicesTable.dueDate,
        })
        .from(tenantInvoicesTable)
        .where(invoiceSiteFilter)
        .orderBy(desc(tenantInvoicesTable.createdAt)),
    ]);

    const bookingByUnit = new Map<string, typeof bookings[number]>();
    for (const b of bookings) {
      if (!b.unitCode) continue;
      const existing = bookingByUnit.get(b.unitCode);
      if (!existing) {
        bookingByUnit.set(b.unitCode, b);
      } else {
        const existingActive = existing.contractStatus === "active" || existing.contractStatus === "expiring_soon";
        const newActive = b.contractStatus === "active" || b.contractStatus === "expiring_soon";
        if (!existingActive && newActive) bookingByUnit.set(b.unitCode, b);
      }
    }

    const tenantMap = new Map(tenants.map(t => [t.id, t]));
    // Index tenant juga berdasarkan booth_number → bisa lookup langsung tanpa booking
    const tenantByBooth = new Map(tenants.filter(t => t.boothNumber).map(t => [t.boothNumber!, t]));

    const latestInvoiceByBooking = new Map<number, typeof invoices[number]>();
    for (const inv of invoices) {
      if (inv.bookingId && !latestInvoiceByBooking.has(inv.bookingId)) {
        latestInvoiceByBooking.set(inv.bookingId, inv);
      }
    }

    const result = units.map((u) => {
      const booking = bookingByUnit.get(u.unitCode) ?? null;
      // Prioritas: tenant via booking → tenant via booth_number langsung
      const tenant = booking?.tenantId
        ? (tenantMap.get(booking.tenantId) ?? tenantByBooth.get(u.unitCode) ?? null)
        : (tenantByBooth.get(u.unitCode) ?? null);
      const invoice = booking?.id ? latestInvoiceByBooking.get(booking.id) : null;

      const computedStatus = computeUnitStatus({
        storedStatus: u.status,
        hasBooking: !!booking,
        hasTenant: !!tenant,
        bookingContractStatus: booking?.contractStatus ?? null,
        bookingPaymentStatus: booking?.paymentStatus ?? null,
        bookingStartDate: booking?.startDate ?? null,
        bookingEndDate: booking?.endDate ?? null,
        bookingDueDate: booking?.dueDate ?? null,
        latestInvoiceStatus: invoice?.status ?? null,
        latestInvoiceDueDate: invoice?.dueDate ?? null,
      });

      return {
        id: u.id,
        siteId: u.siteId,
        unitCode: u.unitCode,
        floor: u.floor,
        zone: u.zone,
        areaKantin: u.areaKantin,
        unitType: u.unitType,
        sizeM2: u.sizeM2,
        defaultRentAmount: u.defaultRentAmount,
        storedStatus: u.status,
        status: computedStatus,
        positionX: u.positionX,
        positionY: u.positionY,
        width: u.width,
        height: u.height,
        notes: u.notes,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        bookingId: booking?.id ?? null,
        tenantId: tenant?.id ?? booking?.tenantId ?? null,
        businessName: tenant?.businessName ?? null,
        ownerName: tenant?.ownerName ?? null,
        phone: tenant?.phone ?? null,
        email: tenant?.email ?? null,
        category: tenant?.category ?? tenant?.businessCategory ?? null,
        boothNumber: tenant?.boothNumber ?? u.unitCode,
        startDate: booking?.startDate ?? tenant?.contractStartDate ?? null,
        endDate: booking?.endDate ?? tenant?.contractEndDate ?? null,
        totalAmount: Number(booking?.totalAmount ?? 0),
        paidAmount: Number(booking?.paidAmount ?? 0),
        remainingAmount: Number(booking?.remainingAmount ?? 0),
        paymentStatus: booking?.paymentStatus ?? null,
        periodLabel: booking?.periodLabel ?? null,
        dueDate: booking?.dueDate ?? null,
        latestInvoiceId: invoice?.id ?? null,
        latestInvoiceStatus: invoice?.status ?? null,
        latestInvoiceAmount: invoice?.totalAmount ? Number(invoice.totalAmount) : null,
        latestInvoiceDueDate: invoice?.dueDate ?? null,
        latestInvoiceOutstanding: invoice?.outstandingAmount ? Number(invoice.outstandingAmount) : null,
      };
    });

    res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=30");
    res.json(result);
  } catch (err) {
    req.log.error(err, "Failed to get mall units");
    res.status(500).json({ error: "Gagal mengambil data unit" });
  }
});

// ─── GET /api/mall-units/areas ────────────────────────────────────────────────
router.get("/mall-units/areas", async (req, res) => {
  try {
    const siteFilter = req.siteId > 0 ? eq(mallUnitsTable.siteId, req.siteId) : undefined;
    const rows = await db
      .selectDistinct({ area: mallUnitsTable.areaKantin })
      .from(mallUnitsTable)
      .where(siteFilter);
    res.json(rows.map(r => r.area).filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil daftar area" });
  }
});

// ─── GET /api/mall-units/floors ───────────────────────────────────────────────
router.get("/mall-units/floors", async (req, res) => {
  try {
    const siteFilter = req.siteId > 0 ? eq(mallUnitsTable.siteId, req.siteId) : undefined;
    const rows = await db
      .selectDistinct({ floor: mallUnitsTable.floor })
      .from(mallUnitsTable)
      .where(siteFilter)
      .orderBy(mallUnitsTable.floor);
    res.json(rows.map(r => r.floor));
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil daftar lantai" });
  }
});

// ─── GET /api/mall-units/:id ──────────────────────────────────────────────────
router.get("/mall-units/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }
  try {
    const [unit] = await db.select().from(mallUnitsTable).where(eq(mallUnitsTable.id, id));
    if (!unit) { res.status(404).json({ error: "Unit tidak ditemukan" }); return; }
    res.json(unit);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil unit" });
  }
});

// ─── POST /api/mall-units ─────────────────────────────────────────────────────
router.post("/mall-units", requireAnyRole("owner", "admin"), async (req, res) => {
  const siteId = req.siteId > 0 ? req.siteId : req.body.siteId;

  if (req.body.unitCode && siteId) {
    const [existing] = await db
      .select({ id: mallUnitsTable.id })
      .from(mallUnitsTable)
      .where(and(
        eq(mallUnitsTable.unitCode, String(req.body.unitCode)),
        eq(mallUnitsTable.siteId, Number(siteId)),
      ));
    if (existing) {
      res.status(409).json({ error: `Kode unit '${req.body.unitCode}' sudah digunakan di lokasi ini` });
      return;
    }
  }

  const bodyWithDefaults = {
    floor: "Main",
    ...req.body,
    siteId,
    unitType: req.body.unitType ?? "other",
  };
  const parsed = insertMallUnitSchema.safeParse(bodyWithDefaults);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", detail: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const [unit] = await db.insert(mallUnitsTable).values(parsed.data).returning();
    logAudit(req, {
      action: "create_unit",
      entityType: "mall_unit",
      entityId: unit.id,
      afterData: unit,
    });
    res.status(201).json(unit);
  } catch (err: any) {
    if (err?.cause?.code === "23505" || err?.code === "23505") {
      res.status(409).json({ error: `Kode unit '${req.body.unitCode}' sudah digunakan di lokasi ini` });
      return;
    }
    req.log.error(err, "Failed to create mall unit");
    res.status(500).json({ error: "Gagal membuat unit" });
  }
});

// ─── PATCH /api/mall-units/bulk-status ───────────────────────────────────────
router.patch("/mall-units/bulk-status", requireAnyRole("owner", "admin"), async (req, res) => {
  const { ids, status } = req.body as { ids: unknown; status: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids harus berupa array tidak kosong" }); return;
  }
  if (typeof status !== "string" || !UNIT_STATUSES.includes(status as UnitStatus)) {
    res.status(400).json({ error: "Status tidak valid" }); return;
  }
  const numericIds = ids.map(Number).filter(n => !isNaN(n));
  if (numericIds.length === 0) {
    res.status(400).json({ error: "IDs tidak valid" }); return;
  }
  try {
    const siteId = req.siteId;
    const whereClause = siteId > 0
      ? and(inArray(mallUnitsTable.id, numericIds), eq(mallUnitsTable.siteId, siteId))
      : inArray(mallUnitsTable.id, numericIds);
    const updated = await db
      .update(mallUnitsTable)
      .set({ status: status as UnitStatus, updatedAt: new Date() })
      .where(whereClause)
      .returning({ id: mallUnitsTable.id, unitCode: mallUnitsTable.unitCode });
    logAudit(req, {
      action: "bulk_update_unit_status",
      entityType: "mall_unit",
      entityId: 0,
      afterData: { ids: numericIds, status, updatedCount: updated.length },
    });
    sseBroker.publish("unit_updated", { unitIds: numericIds });
    res.json({ ok: true, updatedCount: updated.length, units: updated });
  } catch (err) {
    req.log.error(err, "Failed to bulk update mall unit status");
    res.status(500).json({ error: "Gagal update status unit secara massal" });
  }
});

// ─── POST /api/mall-units/sync-from-bookings ──────────────────────────────────
router.post("/mall-units/sync-from-bookings", requireAnyRole("owner", "admin"), async (req, res) => {
  const siteId = req.siteId;
  try {
    const unitFilter = siteId > 0 ? eq(mallUnitsTable.siteId, siteId) : undefined;
    const units = await db.select().from(mallUnitsTable).where(unitFilter);

    const todayStr = new Date().toISOString().slice(0, 10);
    const bookingConditions: any[] = [
      sql`${tenantBookingsTable.contractStatus} NOT IN ('terminated','expired')`,
      or(
        sql`${tenantBookingsTable.endDate} >= ${todayStr}`,
        sql`${tenantBookingsTable.endDate} IS NULL`,
      ),
    ];
    if (siteId > 0) bookingConditions.push(eq(tenantBookingsTable.siteId, siteId));

    const bookings = await db
      .select({ unitCode: tenantBookingsTable.unitCode, contractStatus: tenantBookingsTable.contractStatus })
      .from(tenantBookingsTable)
      .where(and(...bookingConditions));

    const activeUnitCodes = new Set(bookings.map(b => b.unitCode).filter(Boolean) as string[]);

    const toOccupied: number[] = [];
    const toAvailable: number[] = [];

    for (const u of units) {
      if (u.status === "maintenance") continue;
      const hasActiveBooking = activeUnitCodes.has(u.unitCode);
      if (hasActiveBooking && u.status !== "occupied") toOccupied.push(u.id);
      if (!hasActiveBooking && u.status === "occupied") toAvailable.push(u.id);
    }

    if (toOccupied.length > 0) {
      await db.update(mallUnitsTable)
        .set({ status: "occupied", updatedAt: new Date() })
        .where(inArray(mallUnitsTable.id, toOccupied));
    }
    if (toAvailable.length > 0) {
      await db.update(mallUnitsTable)
        .set({ status: "available", updatedAt: new Date() })
        .where(inArray(mallUnitsTable.id, toAvailable));
    }

    const totalChanged = toOccupied.length + toAvailable.length;
    logAudit(req, {
      action: "sync_units_from_bookings",
      entityType: "mall_unit",
      entityId: 0,
      afterData: { toOccupied: toOccupied.length, toAvailable: toAvailable.length, siteId },
    });
    sseBroker.publish("unit_updated", { synced: true });
    res.json({
      ok: true,
      totalChanged,
      toOccupied: toOccupied.length,
      toAvailable: toAvailable.length,
      message: totalChanged === 0
        ? "Semua status unit sudah sinkron dengan data booking"
        : `${totalChanged} unit berhasil disinkronkan (${toOccupied.length} → Terisi, ${toAvailable.length} → Kosong)`,
    });
  } catch (err) {
    req.log.error(err, "Failed to sync unit status from bookings");
    res.status(500).json({ error: "Gagal sinkronisasi status unit dari booking" });
  }
});

// ─── PATCH /api/mall-units/:id ────────────────────────────────────────────────
router.patch("/mall-units/:id", requireAnyRole("owner", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const parsed = insertMallUnitSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", detail: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const [before] = await db.select().from(mallUnitsTable).where(eq(mallUnitsTable.id, id));
    if (!before) { res.status(404).json({ error: "Unit tidak ditemukan" }); return; }

    const isStatusOnly = Object.keys(req.body).length === 1 && "status" in req.body;
    const auditAction = isStatusOnly ? "update_unit_status" : "update_unit";

    const { siteId: _omit, ...safeUpdate } = parsed.data as any;
    const [updated] = await db
      .update(mallUnitsTable)
      .set({ ...safeUpdate, updatedAt: new Date() })
      .where(eq(mallUnitsTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "Unit tidak ditemukan" }); return; }

    // ── Sync harga sewa ke tenant jika defaultRentAmount unit berubah ──
    const oldUnitRent = Number(before.defaultRentAmount ?? 0);
    const newUnitRent = Number(updated.defaultRentAmount ?? 0);
    if (newUnitRent > 0 && newUnitRent !== oldUnitRent) {
      try {
        // Cari tenant yang booth_number-nya cocok dengan unit_code ini
        const tenantConditions = [eq(tenantsTable.boothNumber, updated.unitCode)];
        if (updated.siteId && updated.siteId > 0) {
          tenantConditions.push(eq(tenantsTable.siteId, updated.siteId));
        }
        const syncedTenants = await db
          .update(tenantsTable)
          .set({ defaultRentAmount: String(newUnitRent), updatedAt: new Date() })
          .where(and(...tenantConditions))
          .returning({ id: tenantsTable.id });

        if (syncedTenants.length > 0) {
          sseBroker.publish("tenant_updated", { tenantIds: syncedTenants.map(t => t.id), action: "rent_synced" });
        }
      } catch (syncErr) {
        req.log.warn(syncErr, "Gagal sync harga sewa ke tenant dari unit");
      }
    }

    logAudit(req, {
      action: auditAction,
      entityType: "mall_unit",
      entityId: id,
      beforeData: before,
      afterData: updated,
    });
    sseBroker.publish("unit_updated", { unitId: id });
    res.json(updated);
  } catch (err: any) {
    if (err?.cause?.code === "23505" || err?.code === "23505") {
      res.status(409).json({ error: "Kode unit sudah digunakan di lokasi ini" });
      return;
    }
    req.log.error(err, "Failed to update mall unit");
    res.status(500).json({ error: "Gagal memperbarui unit" });
  }
});

// ─── DELETE /api/mall-units/:id ───────────────────────────────────────────────
router.delete("/mall-units/:id", requireAnyRole("owner", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [unit] = await db.select().from(mallUnitsTable).where(eq(mallUnitsTable.id, id));
    if (!unit) { res.status(404).json({ error: "Unit tidak ditemukan" }); return; }

    const activeBookings = await db
      .select({ id: tenantBookingsTable.id })
      .from(tenantBookingsTable)
      .where(and(
        eq(tenantBookingsTable.unitCode, unit.unitCode),
        inArray(tenantBookingsTable.contractStatus, ["active", "expiring_soon", "draft"]),
      ));

    if (activeBookings.length > 0) {
      res.status(409).json({
        error: "Unit tidak dapat dihapus karena masih memiliki booking aktif. Ubah status menjadi maintenance terlebih dahulu.",
      });
      return;
    }

    const [deleted] = await db
      .delete(mallUnitsTable)
      .where(eq(mallUnitsTable.id, id))
      .returning();

    logAudit(req, {
      action: "delete_unit",
      entityType: "mall_unit",
      entityId: id,
      beforeData: deleted,
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    req.log.error(err, "Failed to delete mall unit");
    res.status(500).json({ error: "Gagal menghapus unit" });
  }
});

// ─── POST /api/mall-units/seed-kantin (dev only) ──────────────────────────────
if (process.env.NODE_ENV !== "production") {
  router.post("/mall-units/seed-kantin", requireAnyRole("owner", "admin"), async (req, res) => {
    try {
      const sites = await db
        .select({ id: mallSitesTable.id, code: mallSitesTable.code })
        .from(mallSitesTable)
        .where(inArray(mallSitesTable.code, ["KANTIN_SPORT_CENTER", "KANTIN_TOD_M1"]));

      const scSite = sites.find(s => s.code === "KANTIN_SPORT_CENTER");
      const todSite = sites.find(s => s.code === "KANTIN_TOD_M1");

      let inserted = 0;

      if (scSite) {
        const existing = await db.select({ id: mallUnitsTable.id }).from(mallUnitsTable)
          .where(eq(mallUnitsTable.siteId, scSite.id)).limit(1);
        if (existing.length === 0) {
          const scUnits = [
            { unitCode: "SC-KTN-01", unitType: "food_booth",      areaKantin: "Area Kantin",   floor: "Main", sizeM2: "12", positionX: 0, positionY: 0, width: 3, height: 2, status: "available", siteId: scSite.id },
            { unitCode: "SC-KTN-02", unitType: "beverage_booth",  areaKantin: "Area Kantin",   floor: "Main", sizeM2: "10", positionX: 3, positionY: 0, width: 3, height: 2, status: "available", siteId: scSite.id },
            { unitCode: "SC-KTN-03", unitType: "storage",         areaKantin: "Area Belakang", floor: "Main", sizeM2: "8",  positionX: 6, positionY: 0, width: 2, height: 2, status: "available", siteId: scSite.id },
          ];
          const rows = await db.insert(mallUnitsTable).values(scUnits).returning();
          inserted += rows.length;
        }
      }

      if (todSite) {
        const existing = await db.select({ id: mallUnitsTable.id }).from(mallUnitsTable)
          .where(eq(mallUnitsTable.siteId, todSite.id)).limit(1);
        if (existing.length === 0) {
          const todUnits = [
            { unitCode: "TOD-KTN-01", unitType: "food_booth",     areaKantin: "Area Kantin",   floor: "Main", sizeM2: "12", positionX: 0, positionY: 0, width: 3, height: 2, status: "available", siteId: todSite.id },
            { unitCode: "TOD-KTN-02", unitType: "beverage_booth", areaKantin: "Area Kantin",   floor: "Main", sizeM2: "10", positionX: 3, positionY: 0, width: 3, height: 2, status: "available", siteId: todSite.id },
            { unitCode: "TOD-KTN-03", unitType: "storage",        areaKantin: "Area Belakang", floor: "Main", sizeM2: "8",  positionX: 6, positionY: 0, width: 2, height: 2, status: "available", siteId: todSite.id },
          ];
          const rows = await db.insert(mallUnitsTable).values(todUnits).returning();
          inserted += rows.length;
        }
      }

      res.json({ ok: true, message: `${inserted} unit kantin berhasil diseed`, count: inserted });
    } catch (err) {
      req.log.error(err, "Failed to seed kantin units");
      res.status(500).json({ error: "Gagal seed data unit kantin" });
    }
  });

  router.post("/mall-units/seed", requireAnyRole("owner", "admin"), async (req, res) => {
    try {
      const existing = await db.select({ id: mallUnitsTable.id }).from(mallUnitsTable).limit(1);
      if (existing.length > 0) {
        res.json({ ok: true, message: "Data unit sudah ada, seed dilewati", count: 0 });
        return;
      }
      const siteId = req.siteId;
      const seedData = [
        { unitCode: "A-01", floor: "1", zone: "Food & Beverage", sizeM2: "24", positionX: 0, positionY: 0, width: 3, height: 2, status: "available" },
        { unitCode: "A-02", floor: "1", zone: "Food & Beverage", sizeM2: "18", positionX: 3, positionY: 0, width: 2, height: 2, status: "available" },
        { unitCode: "A-03", floor: "1", zone: "Food & Beverage", sizeM2: "30", positionX: 5, positionY: 0, width: 3, height: 2, status: "available" },
        { unitCode: "B-01", floor: "1", zone: "Retail", sizeM2: "45", positionX: 9, positionY: 0, width: 3, height: 2, status: "available" },
        { unitCode: "B-02", floor: "1", zone: "Retail", sizeM2: "30", positionX: 12, positionY: 0, width: 2, height: 2, status: "available" },
        { unitCode: "C-01", floor: "2", zone: "Fashion", sizeM2: "60", positionX: 0, positionY: 0, width: 4, height: 3, status: "available" },
        { unitCode: "D-01", floor: "2", zone: "Electronics", sizeM2: "80", positionX: 10, positionY: 0, width: 5, height: 3, status: "available" },
        { unitCode: "E-01", floor: "2", zone: "Entertainment", sizeM2: "120", positionX: 0, positionY: 5, width: 8, height: 4, status: "available" },
      ];
      const seedWithSite = siteId > 0 ? seedData.map(d => ({ ...d, siteId })) : seedData;
      const inserted = await db.insert(mallUnitsTable).values(seedWithSite).returning();
      res.json({ ok: true, message: `${inserted.length} unit berhasil diseed`, count: inserted.length });
    } catch (err) {
      req.log.error(err, "Failed to seed mall units");
      res.status(500).json({ error: "Gagal seed data unit" });
    }
  });
}

export default router;
