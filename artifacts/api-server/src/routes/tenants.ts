import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  tenantsTable, insertTenantSchema,
  tenantBookingsTable, tenantInvoicesTable, tenantPaymentsTable, mallSitesTable,
  financePaymentEventsTable, tenantUserAccessTable, mallUnitsTable,
} from "@workspace/db/schema";
import { eq, asc, desc, and, inArray, sql, getTableColumns } from "drizzle-orm";
import { requireAnyRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { sseBroker } from "../lib/sse-broker";

const router: IRouter = Router();

router.use("/tenants", requireAnyRole("owner", "admin"));

router.get("/tenants", async (req, res) => {
  try {
    const siteId = req.siteId;
    const tenantColumns = getTableColumns(tenantsTable);

    // Satu round-trip DB saja. Sebelumnya endpoint melakukan:
    // tenants -> booking aktif -> outstanding invoice secara berurutan/bertahap.
    // Pada Hostinger + Supabase network latency antar-query menjadi bagian terbesar
    // dari waktu buka Data Tenant. Scalar subqueries ini dikerjakan PostgreSQL dalam
    // satu statement dan memakai tenant_id sebagai correlation key.
    const rows = await db
      .select({
        ...tenantColumns,
        latestContractStartDate: sql<string | null>`(
          SELECT tb.start_date
          FROM tenant_bookings tb
          WHERE tb.tenant_id = ${tenantsTable.id}
            AND tb.contract_status IN ('active', 'expiring_soon')
            AND tb.booking_status IN ('aktif', 'active', 'confirmed')
          ORDER BY tb.id DESC
          LIMIT 1
        )`,
        latestContractEndDate: sql<string | null>`(
          SELECT tb.end_date
          FROM tenant_bookings tb
          WHERE tb.tenant_id = ${tenantsTable.id}
            AND tb.contract_status IN ('active', 'expiring_soon')
            AND tb.booking_status IN ('aktif', 'active', 'confirmed')
          ORDER BY tb.id DESC
          LIMIT 1
        )`,
        totalOutstanding: sql<number>`COALESCE((
          SELECT SUM(ti.outstanding_amount::numeric)
          FROM tenant_invoices ti
          WHERE ti.tenant_id = ${tenantsTable.id}
            AND ti.status IN ('unpaid', 'overdue', 'partial')
            AND COALESCE(ti.outstanding_amount, 0)::numeric > 0
            AND (ti.period_start IS NULL
              OR ti.period_start::date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date)
        ), 0)::numeric`,
      })
      .from(tenantsTable)
      .where(siteId > 0 ? eq(tenantsTable.siteId, siteId) : undefined)
      .orderBy(asc(tenantsTable.id));

    res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=30");
    res.json(rows.map((t) => ({
      ...t,
      contractStartDate: t.latestContractStartDate ?? t.contractStartDate ?? null,
      contractEndDate: t.latestContractEndDate ?? t.contractEndDate ?? null,
      totalOutstanding: Number(t.totalOutstanding ?? 0),
      latestContractStartDate: undefined,
      latestContractEndDate: undefined,
    })));
  } catch (err) {
    req.log.error(err, "Failed to list tenants");
    res.status(500).json({ error: "Gagal mengambil data tenant" });
  }
});

router.post("/tenants", async (req, res) => {
  const body = req.siteId > 0 ? { ...req.body, siteId: req.siteId } : req.body;
  const parsed = insertTenantSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    // Auto-assign company_id dari site jika belum diset
    let companyId = parsed.data.companyId ?? null;
    if (!companyId && parsed.data.siteId) {
      const rows = await db.execute<{ company_id: number }>(sql`
        SELECT c.id AS company_id
        FROM mall_sites ms
        JOIN companies c ON c.id = ms.company_id
        WHERE ms.id = ${parsed.data.siteId}
        LIMIT 1
      `);
      if (rows.rows?.[0]?.company_id) companyId = rows.rows[0].company_id;
    }
    const [tenant] = await db
      .insert(tenantsTable)
      .values({ ...parsed.data, companyId: companyId ?? parsed.data.companyId })
      .returning();
    logAudit(req, {
      action: "create_tenant",
      entityType: "tenant",
      entityId: tenant.id,
      afterData: tenant,
    });
    sseBroker.publish("tenant_updated", { tenantId: tenant.id, action: "created" });
    res.status(201).json(tenant);
  } catch (err) {
    req.log.error(err, "Failed to create tenant");
    res.status(500).json({ error: "Gagal membuat tenant" });
  }
});

router.get("/tenants/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID tidak valid" });
    return;
  }
  try {
    const siteCondition = req.siteId > 0
      ? and(eq(tenantsTable.id, id), eq(tenantsTable.siteId, req.siteId))
      : eq(tenantsTable.id, id);
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(siteCondition);
    if (!tenant) {
      res.status(404).json({ error: "Tenant tidak ditemukan" });
      return;
    }
    res.json(tenant);
  } catch (err) {
    req.log.error(err, "Failed to get tenant");
    res.status(500).json({ error: "Gagal mengambil tenant" });
  }
});

/**
 * GET /api/tenants/:id/profile
 * Detail lengkap satu tenant: info dasar, booking, invoice, pembayaran, KPI
 */
router.get("/tenants/:id/profile", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    // ── 1. Tenant + site name ─────────────────────────────────────────────────
    const rows = await db
      .select({
        tenant: tenantsTable,
        siteName: mallSitesTable.name,
        siteType: mallSitesTable.type,
      })
      .from(tenantsTable)
      .leftJoin(mallSitesTable, eq(tenantsTable.siteId, mallSitesTable.id))
      .where(eq(tenantsTable.id, id));

    if (!rows.length) { res.status(404).json({ error: "Tenant tidak ditemukan" }); return; }
    const { tenant, siteName, siteType } = rows[0];

    // ── 2. Bookings ───────────────────────────────────────────────────────────
    const bookings = await db
      .select()
      .from(tenantBookingsTable)
      .where(eq(tenantBookingsTable.tenantId, id))
      .orderBy(desc(tenantBookingsTable.startDate));

    // ── 3. Invoices ───────────────────────────────────────────────────────────
    const invoices = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.tenantId, id))
      .orderBy(desc(tenantInvoicesTable.periodStart));

    // ── 4. Payments ───────────────────────────────────────────────────────────
    const payments = await db
      .select()
      .from(tenantPaymentsTable)
      .where(and(
        eq(tenantPaymentsTable.tenantId, id),
        sql`(${tenantPaymentsTable.isVoided} = false OR ${tenantPaymentsTable.isVoided} IS NULL)`,
      ))
      .orderBy(desc(tenantPaymentsTable.paidAt));

    // ── 5. KPI ────────────────────────────────────────────────────────────────
    const todayWib = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const effectiveInvoices = invoices.filter((i) =>
      i.status !== "cancelled" &&
      i.status !== "draft" &&
      (!i.periodStart || i.periodStart <= todayWib)
    );
    const totalBilled      = effectiveInvoices.reduce((s, i) => s + Number(i.totalAmount  ?? 0), 0);
    const totalPaid        = effectiveInvoices.reduce((s, i) => s + Number(i.paidAmount   ?? 0), 0);
    const totalOutstanding = effectiveInvoices
      .filter((i) => ["unpaid", "partial", "overdue"].includes(i.status))
      .reduce((s, i) => s + Math.max(Number(i.outstandingAmount ?? 0), 0), 0);
    const paymentRate      = totalBilled > 0 ? Math.round(totalPaid / totalBilled * 100) : 0;
    const overdueInvoices  = effectiveInvoices.filter(i => i.status === "overdue" && Number(i.outstandingAmount ?? 0) > 0).length;
    const activeBooking    = bookings.find(b => b.contractStatus === "active" || b.bookingStatus === "confirmed");

    res.json({
      tenant: { ...tenant, siteName, siteType },
      bookings,
      invoices,
      payments,
      kpi: { totalBilled, totalPaid, totalOutstanding, paymentRate, overdueInvoices, activeBooking: activeBooking ?? null },
    });
  } catch (err) {
    req.log.error(err, "Failed to get tenant profile");
    res.status(500).json({ error: "Gagal mengambil profil tenant" });
  }
});

router.put("/tenants/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID tidak valid" });
    return;
  }
  const parsed = insertTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [before] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, id));
    const [tenant] = await db
      .update(tenantsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(tenantsTable.id, id))
      .returning();
    if (!tenant) {
      res.status(404).json({ error: "Tenant tidak ditemukan" });
      return;
    }

    // Sync harga sewa ke mall_units jika defaultRentAmount berubah
    const oldRent = Number(before?.defaultRentAmount ?? 0);
    const newRent = Number(parsed.data.defaultRentAmount ?? 0);
    if (newRent > 0 && newRent !== oldRent) {
      try {
        const syncedUnitCodes = new Set<string>();

        // ── Jalur 1 (Utama): sync via booth_number tenant (tanpa perlu booking) ──
        if (tenant.boothNumber) {
          const boothConditions = [eq(mallUnitsTable.unitCode, tenant.boothNumber)];
          if (tenant.siteId && tenant.siteId > 0) {
            boothConditions.push(eq(mallUnitsTable.siteId, tenant.siteId));
          }
          await db
            .update(mallUnitsTable)
            .set({ defaultRentAmount: String(newRent), updatedAt: new Date() })
            .where(and(...boothConditions));
          syncedUnitCodes.add(tenant.boothNumber);
          req.log.info({ unitCode: tenant.boothNumber, newRent }, "Sync harga via booth_number");
        }

        // ── Jalur 2 (Tambahan): sync via booking aktif (jika unit_code berbeda dari booth_number) ──
        const [activeBooking] = await db
          .select({ unitCode: tenantBookingsTable.unitCode, siteId: tenantBookingsTable.siteId })
          .from(tenantBookingsTable)
          .where(
            and(
              eq(tenantBookingsTable.tenantId, id),
              inArray(tenantBookingsTable.contractStatus, ["active", "aktif", "expiring_soon"]),
            ),
          )
          .orderBy(desc(tenantBookingsTable.id))
          .limit(1);

        if (activeBooking?.unitCode && !syncedUnitCodes.has(activeBooking.unitCode)) {
          const unitSiteId = activeBooking.siteId ?? tenant.siteId;
          const bookingConditions = [eq(mallUnitsTable.unitCode, activeBooking.unitCode)];
          if (unitSiteId && unitSiteId > 0) {
            bookingConditions.push(eq(mallUnitsTable.siteId, unitSiteId));
          }
          await db
            .update(mallUnitsTable)
            .set({ defaultRentAmount: String(newRent), updatedAt: new Date() })
            .where(and(...bookingConditions));
          syncedUnitCodes.add(activeBooking.unitCode);
        }

        if (syncedUnitCodes.size > 0) {
          sseBroker.publish("unit_updated", { unitCodes: [...syncedUnitCodes] });
        }
      } catch (syncErr) {
        // Sync gagal tidak membatalkan update tenant
        req.log.warn(syncErr, "Gagal sync harga sewa ke mall_units");
      }
    }

    logAudit(req, {
      action: "update_tenant",
      entityType: "tenant",
      entityId: id,
      beforeData: before,
      afterData: tenant,
    });
    sseBroker.publish("tenant_updated", { tenantId: id, action: "updated" });
    res.json(tenant);
  } catch (err) {
    req.log.error(err, "Failed to update tenant");
    res.status(500).json({ error: "Gagal memperbarui tenant" });
  }
});

// ─── DELETE /api/tenants/bulk — hapus massal (harus sebelum /:id) ────────────
// IDs dikirim via query string (?ids=1,2,3) karena Vite proxy tidak selalu
// meneruskan request body untuk method DELETE.
router.delete("/tenants/bulk", async (req, res) => {
  // Baca IDs dari query string (prioritas) atau body sebagai fallback
  let rawIds: unknown;
  const qIds = req.query.ids;
  if (typeof qIds === "string" && qIds.length > 0) {
    rawIds = qIds.split(",").filter(Boolean);
  } else if (Array.isArray(qIds)) {
    rawIds = qIds;
  } else {
    rawIds = (req.body as { ids?: unknown } | undefined)?.ids;
  }

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    res.status(400).json({ error: "Daftar ID tidak valid atau kosong" });
    return;
  }

  const numIds = (rawIds as unknown[]).map(Number).filter((n) => !isNaN(n) && n > 0);
  if (numIds.length === 0) {
    res.status(400).json({ error: "Tidak ada ID yang valid" });
    return;
  }

  try {
    // Hapus data terkait terlebih dahulu (urutan: child dulu sebelum parent)
    await db.delete(financePaymentEventsTable).where(inArray(financePaymentEventsTable.tenantId, numIds));
    await db.delete(tenantUserAccessTable).where(inArray(tenantUserAccessTable.tenantId, numIds));
    await db.delete(tenantPaymentsTable).where(inArray(tenantPaymentsTable.tenantId, numIds));
    await db.delete(tenantInvoicesTable).where(inArray(tenantInvoicesTable.tenantId, numIds));
    await db.delete(tenantBookingsTable).where(inArray(tenantBookingsTable.tenantId, numIds));

    // Hapus tenant
    const deleted = await db
      .delete(tenantsTable)
      .where(inArray(tenantsTable.id, numIds))
      .returning();

    logAudit(req, {
      action: "bulk_delete_tenant",
      entityType: "tenant",
      entityId: null,
      beforeData: { ids: numIds, count: deleted.length },
    });
    sseBroker.publish("tenant_updated", { action: "bulk_deleted", count: deleted.length });
    res.json({ success: true, deleted: deleted.length });
  } catch (err) {
    req.log.error(err, "Failed to bulk delete tenants");
    res.status(500).json({ error: "Gagal menghapus tenant secara massal" });
  }
});

router.delete("/tenants/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID tidak valid" });
    return;
  }
  try {
    // Ambil data tenant dulu untuk audit log
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1);
    if (!tenant) {
      res.status(404).json({ error: "Tenant tidak ditemukan" });
      return;
    }

    // Hapus data terkait terlebih dahulu (urutan: child dulu sebelum parent)
    await db.delete(financePaymentEventsTable).where(eq(financePaymentEventsTable.tenantId, id));
    await db.delete(tenantUserAccessTable).where(eq(tenantUserAccessTable.tenantId, id));
    await db.delete(tenantPaymentsTable).where(eq(tenantPaymentsTable.tenantId, id));
    await db.delete(tenantInvoicesTable).where(eq(tenantInvoicesTable.tenantId, id));
    await db.delete(tenantBookingsTable).where(eq(tenantBookingsTable.tenantId, id));

    // Hapus tenant
    const [deleted] = await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .returning();

    logAudit(req, {
      action: "delete_tenant",
      entityType: "tenant",
      entityId: id,
      beforeData: deleted,
    });
    sseBroker.publish("tenant_updated", { tenantId: id, action: "deleted" });
    res.json({ success: true, deleted });
  } catch (err) {
    req.log.error(err, "Failed to delete tenant");
    res.status(500).json({ error: "Gagal menghapus tenant" });
  }
});

// ─── PATCH /api/tenants/:id/logo — update logo URL saja ──────────────────────
router.patch("/tenants/:id/logo", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID tidak valid" });
    return;
  }
  const { logoUrl } = req.body as { logoUrl?: unknown };
  const isValidLogoUrl =
    typeof logoUrl === "string" &&
    (logoUrl.startsWith("https://") || logoUrl.startsWith("http://"));
  if (!isValidLogoUrl) {
    res.status(400).json({ error: "logoUrl tidak valid" });
    return;
  }
  try {
    const [tenant] = await db
      .update(tenantsTable)
      .set({ logoUrl, updatedAt: new Date() })
      .where(eq(tenantsTable.id, id))
      .returning();
    if (!tenant) {
      res.status(404).json({ error: "Tenant tidak ditemukan" });
      return;
    }
    logAudit(req, { action: "update_tenant_logo", entityType: "tenant", entityId: id, afterData: { logoUrl } });
    sseBroker.publish("tenant_updated", { tenantId: id, action: "logo_updated" });
    res.json({ success: true, logoUrl: tenant.logoUrl });
  } catch (err) {
    req.log.error(err, "Failed to update tenant logo");
    res.status(500).json({ error: "Gagal memperbarui foto tenant" });
  }
});

router.get("/companies", async (req, res) => {
  try {
    const rows = await db.execute(
      sql`SELECT id, code, name, company_name AS "companyName", company_code AS "companyCode" FROM companies ORDER BY id`
    );
    res.json(rows.rows);
  } catch (err) {
    req.log.error(err, "Failed to fetch companies");
    res.status(500).json({ error: "Gagal mengambil data perusahaan" });
  }
});

export default router;
