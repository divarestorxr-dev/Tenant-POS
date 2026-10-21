import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tenantPaymentsTable, tenantInvoicesTable, tenantsTable, tenantReceiptsTable, mallSitesTable } from "@workspace/db/schema";
import { eq, sql, desc, and, gte, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { LedgerError, recordPayment } from "../lib/payment-ledger";
import { cashierShiftsTable } from "@workspace/db/schema";
import { writePaymentEvent, normalizePaymentMethod } from "../lib/payment-events";
import { postTenantPaymentAccountingEntry } from "../lib/accounting-entry";
import { notifyAdminGroup } from "../lib/whatsapp";
import { logger } from "../lib/logger";
import { requireAnyRole } from "../middlewares/auth";
import { appContextMiddleware } from "../middlewares/app-context";
import {
  downloadFromStorage,
  getPaymentProofBucket,
  getStorageObjectPath,
} from "../lib/supabase-storage";

const router: IRouter = Router();

router.use("/payments", appContextMiddleware);

// POST /payments adalah pencatatan manual — hanya owner, admin, finance.
// Kasir menggunakan /tenant-pos/payments (alur POS dengan shift).
router.use("/payments", (req, res, next) => {
  if (req.method === "POST") {
    return requireAnyRole("owner", "admin", "finance")(req, res, next);
  }
  return next();
});

const createPaymentSchema = z.object({
  invoiceId: z.number().int().positive(),
  amount: z.number().positive("Jumlah harus lebih dari 0"),
  paymentMethod: z.enum(["tunai", "transfer", "qris", "edc", "other"]).default("tunai"),
  referenceId: z.string().min(1).optional(),
  sourceType: z.enum(["pos", "ocr", "bank", "manual"]).default("manual"),
  referenceNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  shiftId: z.number().int().positive().optional().nullable(),
  paidAt: z.string().datetime().optional().nullable(),
});

// ─── POST /api/payments ────────────────────────────────────────────────────────
// Endpoint terpadu untuk mencatat pembayaran invoice. Mendukung idempotency via
// referenceId dan validasi anti-overpayment.
router.post("/payments", async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", detail: parsed.error.issues });
    return;
  }

  const {
    invoiceId, amount, paymentMethod, referenceId, sourceType,
    referenceNumber, notes, shiftId, paidAt,
  } = parsed.data;

  try {
    const requestContext = req.appContext!;
    if (
      req.siteId === 0
      && !requestContext.ownerCompanyId
      && !["owner", "admin"].includes(requestContext.role)
    ) {
      res.status(403).json({ error: "Pilih company untuk mencatat pembayaran semua site" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [invoice] = await tx
        .select({
          id: tenantInvoicesTable.id,
          tenantId: tenantInvoicesTable.tenantId,
          bookingId: tenantInvoicesTable.bookingId,
          siteId: tenantInvoicesTable.siteId,
          invoiceCompanyId: tenantInvoicesTable.companyId,
          tenantSiteId: tenantsTable.siteId,
          tenantCompanyId: tenantsTable.companyId,
          siteCompanyId: mallSitesTable.companyId,
          status: tenantInvoicesTable.status,
        })
        .from(tenantInvoicesTable)
        .innerJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
        .leftJoin(
          mallSitesTable,
          eq(mallSitesTable.id, sql<number>`coalesce(${tenantInvoicesTable.siteId}, ${tenantsTable.siteId})`),
        )
        .where(eq(tenantInvoicesTable.id, invoiceId))
        .for("update");

      if (!invoice) {
        throw Object.assign(new Error("Invoice tidak ditemukan"), { status: 404 });
      }
      const ctx = req.appContext!;
      const invoiceSiteId = invoice.siteId ?? invoice.tenantSiteId;
      const invoiceCompanyId = invoice.invoiceCompanyId ?? invoice.tenantCompanyId ?? invoice.siteCompanyId;
      if (
        (req.siteId > 0 && invoiceSiteId !== req.siteId)
        || (ctx.ownerCompanyId != null && invoiceCompanyId !== ctx.ownerCompanyId)
        || (ctx.ownerTenantId != null && invoice.tenantId !== ctx.ownerTenantId)
      ) {
        // Use 404 so callers cannot enumerate invoices outside their context.
        throw Object.assign(new Error("Invoice tidak ditemukan"), { status: 404 });
      }
      if (invoice.status === "cancelled") {
        throw Object.assign(new Error("Invoice telah dibatalkan"), { status: 409 });
      }
      if (invoice.status === "paid") {
        throw Object.assign(new Error("Invoice sudah lunas"), { status: 409 });
      }

      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const prefix = `PAY-${datePart}-`;
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tenantPaymentsTable)
        .where(sql`receipt_number LIKE ${prefix + "%"}`);
      const seq = ((countRow?.count ?? 0) + 1).toString().padStart(4, "0");
      const receiptNumber = `${prefix}${seq}`;

      return await recordPayment(tx, {
        invoiceId,
        amount,
        paymentMethod,
        sourceType,
        receiptNumber,
        referenceId: referenceId ?? null,
        referenceNumber: referenceNumber ?? null,
        notes: notes ?? null,
        shiftId: shiftId ?? null,
        paidAt: paidAt ? new Date(paidAt) : null,
        tenantId: invoice.tenantId ?? null,
        bookingId: invoice.bookingId ?? null,
        siteId: invoice.siteId ?? null,
      });
    });

    logAudit(req, {
      action: "create_payment",
      entityType: "tenant_payments",
      entityId: result.ledgerEntryId,
      afterData: {
        paymentId: result.ledgerEntryId,
        invoiceId,
        amount,
        paymentMethod,
        sourceType,
        referenceId: referenceId ?? null,
        invoiceStatus: result.invoiceStatus,
      },
    });

    // Generate receipt + accounting journal + payment event — fire-and-forget
    void (async () => {
      try {
        const [inv] = await db
          .select({
            invoiceNumber: tenantInvoicesTable.invoiceNumber,
            tenantId: tenantInvoicesTable.tenantId,
            siteId: tenantInvoicesTable.siteId,
          })
          .from(tenantInvoicesTable)
          .where(eq(tenantInvoicesTable.id, invoiceId));

        const tenantRow = inv?.tenantId
          ? await db
              .select({ ownerName: tenantsTable.ownerName, businessName: tenantsTable.businessName })
              .from(tenantsTable)
              .where(eq(tenantsTable.id, inv.tenantId))
              .then((r) => r[0])
          : null;

        // 1. Receipt entry → tenant_receipts (official table)
        await db.insert(tenantReceiptsTable).values({
          paymentId: result.ledgerEntryId,
          invoiceId,
          tenantId: inv?.tenantId ?? 0,
          siteId: inv?.siteId ?? null,
          receiptNumber: result.receiptNumber,
          fileUrl: "",
          invoiceNumber: inv?.invoiceNumber ?? null,
          businessName: tenantRow?.businessName ?? null,
          ownerName: tenantRow?.ownerName ?? null,
          amountPaid: String(amount),
          taxAmount: "0",
          netAmount: String(amount),
          paymentMethod,
          kasirName: req.user?.name ?? "Admin",
          waStatus: "skipped",
        }).onConflictDoNothing();

        // 2. Tenant invoice accounting entry. POS journals are reserved for the
        // Sport Center POS domain and must not compete for this payment ID.
        await postTenantPaymentAccountingEntry({
          paymentId: result.ledgerEntryId,
          siteId: inv?.siteId ?? null,
          invoiceNumber: inv?.invoiceNumber ?? null,
          businessName: tenantRow?.businessName ?? null,
          amountPaid: amount,
          paymentMethod,
          transactionDate: paidAt ? new Date(paidAt) : new Date(),
          receiptNumber: result.receiptNumber,
          sourceModule: "tenant_rent_payment",
        });

        // 3. Finance payment event (idempotent)
        await writePaymentEvent({
          sourceApp: "tenant_management",
          ownerApp: "tenant_management",
          sourceModule: "invoice_payment",
          sourceTable: "tenant_payments",
          sourceId: result.ledgerEntryId,
          tenantId: inv?.tenantId ?? null,
          siteId: inv?.siteId ?? null,
          invoiceId,
          amount,
          direction: "IN",
          paymentMethod: normalizePaymentMethod(paymentMethod),
          paymentReference: referenceId ?? null,
          paymentStatus: "confirmed",
        });

        // 4. Notifikasi ke WA Group admin
        notifyAdminGroup({
          eventType: "pos_kasir",
          businessName: tenantRow?.businessName ?? "Tenant",
          ownerName: tenantRow?.ownerName ?? "-",
          receiptNumber: result.receiptNumber,
          invoiceNumber: inv?.invoiceNumber ?? null,
          amount,
          paymentMethod,
          kasirName: req.user?.name ?? "Admin",
        }).catch(() => {});
      } catch (err) {
        logger.error({ err, invoiceId, paymentMethod }, "[POST /payments] post-commit side-effects gagal — jurnal/receipt/event mungkin tidak tercatat");
      }
    })();

    res.status(201).json({
      success: true,
      ledgerId: result.ledgerEntryId,
      invoiceStatus: result.invoiceStatus,
      paidAmount: result.paidAmount,
      remaining: result.remaining,
      remainingBalanceAfter: result.remainingBalanceAfter,
      receiptId: result.receiptNumber,
    });
  } catch (err) {
    if (err instanceof LedgerError) {
      const httpCode = err.code === "OVERPAYMENT" ? 400 : 409;
      res.status(httpCode).json({ error: err.message, code: err.code });
      return;
    }
    const e = err as Error & { status?: number };
    if (e.status) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    logger.error({ err }, "[POST /payments] gagal catat pembayaran");
    res.status(500).json({ error: "Gagal mencatat pembayaran" });
  }
});

// ─── GET /api/payments?invoiceId=X ────────────────────────────────────────────
// Daftar semua entri ledger untuk satu invoice, dengan pagination & filter.
router.get("/payments", async (req, res) => {
  const invoiceId = parseInt(String(req.query.invoiceId ?? ""), 10);
  if (isNaN(invoiceId) || invoiceId <= 0) {
    res.status(400).json({ error: "Parameter invoiceId wajib diisi" });
    return;
  }

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const sourceType = String(req.query.sourceType ?? "").trim() || null;
  const dateFrom = String(req.query.dateFrom ?? "").trim() || null;
  const dateTo = String(req.query.dateTo ?? "").trim() || null;

  try {
    const ctx = req.appContext!;
    if (req.siteId === 0 && !ctx.ownerCompanyId && !["owner", "admin"].includes(ctx.role)) {
      res.status(403).json({ error: "Pilih company untuk melihat pembayaran semua site" });
      return;
    }

    const linkedSiteId = sql<number>`coalesce(${tenantInvoicesTable.siteId}, ${tenantsTable.siteId}, ${tenantPaymentsTable.siteId})`;
    const linkedCompanyId = sql<number>`coalesce(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId}, ${mallSitesTable.companyId})`;
    const conditions = [
      eq(tenantPaymentsTable.invoiceId, invoiceId),
      eq(tenantPaymentsTable.isVoided, false),
    ] as SQL[];

    if (req.siteId > 0) conditions.push(eq(linkedSiteId, req.siteId));
    if (ctx.ownerCompanyId != null) conditions.push(eq(linkedCompanyId, ctx.ownerCompanyId));
    if (ctx.ownerTenantId != null) conditions.push(eq(tenantInvoicesTable.tenantId, ctx.ownerTenantId));

    if (sourceType) conditions.push(eq(tenantPaymentsTable.sourceType, sourceType));
    if (dateFrom) conditions.push(gte(tenantPaymentsTable.createdAt, new Date(dateFrom)));
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      conditions.push(lte(tenantPaymentsTable.createdAt, to));
    }

    const whereClause = and(...conditions);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(tenantPaymentsTable)
        .leftJoin(tenantInvoicesTable, eq(tenantPaymentsTable.invoiceId, tenantInvoicesTable.id))
        .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
      .leftJoin(mallSitesTable, eq(mallSitesTable.id, linkedSiteId))
      .where(whereClause);

    const rows = await db
      .select({
        id: tenantPaymentsTable.id,
        invoiceId: tenantPaymentsTable.invoiceId,
        tenantId: tenantPaymentsTable.tenantId,
        duplicateOfPaymentId: tenantPaymentsTable.duplicateOfPaymentId,
        amount: tenantPaymentsTable.amount,
        paymentMethod: tenantPaymentsTable.paymentMethod,
        sourceType: tenantPaymentsTable.sourceType,
        approvalStatus: tenantPaymentsTable.approvalStatus,
        receiptNumber: tenantPaymentsTable.receiptNumber,
        referenceId: tenantPaymentsTable.referenceId,
        referenceNumber: tenantPaymentsTable.referenceNumber,
        notes: tenantPaymentsTable.notes,
        paidAt: tenantPaymentsTable.paidAt,
        isVoided: tenantPaymentsTable.isVoided,
        remainingBalanceAfter: tenantPaymentsTable.remainingBalanceAfter,
        proofUrl: tenantPaymentsTable.proofUrl,
        proofImageUrl: tenantPaymentsTable.proofImageUrl,
        createdAt: tenantPaymentsTable.createdAt,
        kasirName: cashierShiftsTable.cashierName,
      })
      .from(tenantPaymentsTable)
      .leftJoin(tenantInvoicesTable, eq(tenantPaymentsTable.invoiceId, tenantInvoicesTable.id))
      .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
      .leftJoin(mallSitesTable, eq(mallSitesTable.id, linkedSiteId))
      .leftJoin(cashierShiftsTable, eq(tenantPaymentsTable.shiftId, cashierShiftsTable.id))
      .where(whereClause)
      .orderBy(desc(tenantPaymentsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      success: true,
      data: rows.map(({ proofImageUrl, ...row }) => ({
        ...row,
        proofUrl: row.proofUrl || proofImageUrl
          ? `/api/payments/${row.id}/proof`
          : null,
      })),
      pagination: {
        total: countRow?.total ?? 0,
        limit,
        offset,
        hasMore: offset + rows.length < (countRow?.total ?? 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "[GET /payments]");
    res.status(500).json({ error: "Gagal mengambil riwayat pembayaran" });
  }
});

// ─── GET /api/payments/:id ─────────────────────────────────────────────────────
router.get("/payments/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const ctx = req.appContext!;
    if (req.siteId === 0 && !ctx.ownerCompanyId && !["owner", "admin"].includes(ctx.role)) {
      res.status(403).json({ error: "Pilih company untuk melihat pembayaran semua site" });
      return;
    }

    const linkedSiteId = sql<number>`coalesce(${tenantInvoicesTable.siteId}, ${tenantsTable.siteId}, ${tenantPaymentsTable.siteId})`;
    const linkedCompanyId = sql<number>`coalesce(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId}, ${mallSitesTable.companyId})`;
    const conditions: SQL[] = [eq(tenantPaymentsTable.id, id)];
    if (req.siteId > 0) conditions.push(eq(linkedSiteId, req.siteId));
    if (ctx.ownerCompanyId != null) conditions.push(eq(linkedCompanyId, ctx.ownerCompanyId));
    if (ctx.ownerTenantId != null) conditions.push(eq(tenantPaymentsTable.tenantId, ctx.ownerTenantId));

    const [payment] = await db
      .select({
        id: tenantPaymentsTable.id,
        invoiceId: tenantPaymentsTable.invoiceId,
        tenantId: tenantPaymentsTable.tenantId,
        paymentNumber: tenantPaymentsTable.paymentNumber,
        amount: tenantPaymentsTable.amount,
        paymentMethod: tenantPaymentsTable.paymentMethod,
        paymentStatus: tenantPaymentsTable.paymentStatus,
        approvalStatus: tenantPaymentsTable.approvalStatus,
        receiptNumber: tenantPaymentsTable.receiptNumber,
        referenceId: tenantPaymentsTable.referenceId,
        referenceNumber: tenantPaymentsTable.referenceNumber,
        sourceType: tenantPaymentsTable.sourceType,
        notes: tenantPaymentsTable.notes,
        paidAt: tenantPaymentsTable.paidAt,
        proofUrl: tenantPaymentsTable.proofUrl,
        proofImageUrl: tenantPaymentsTable.proofImageUrl,
        isVoided: tenantPaymentsTable.isVoided,
        duplicateOfPaymentId: tenantPaymentsTable.duplicateOfPaymentId,
        createdAt: tenantPaymentsTable.createdAt,
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        businessName: tenantsTable.businessName,
        ownerName: tenantsTable.ownerName,
      })
      .from(tenantPaymentsTable)
        .leftJoin(tenantInvoicesTable, eq(tenantPaymentsTable.invoiceId, tenantInvoicesTable.id))
        .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
      .leftJoin(mallSitesTable, eq(mallSitesTable.id, linkedSiteId))
      .where(and(...conditions));

    if (!payment) {
      res.status(404).json({ error: "Pembayaran tidak ditemukan" });
      return;
    }

    const { proofImageUrl, ...paymentData } = payment;
    res.json({
      ...paymentData,
      proofUrl: payment.proofUrl || proofImageUrl
        ? `/api/payments/${payment.id}/proof`
        : null,
    });
  } catch (err) {
    logger.error({ err }, "[GET /payments/:id]");
    res.status(500).json({ error: "Gagal mengambil data pembayaran" });
  }
});

const editPaymentDateSchema = z.object({
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal pembayaran tidak valid")
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
    }, "Tanggal pembayaran tidak valid"),
});

// ─── PUT /api/payments/:id/date ──────────────────────────────────────────────
// Mengubah tanggal tampil/payment date saja. Tidak mengubah nominal, status,
// invoice paid amount, atau lifecycle pembayaran.
router.put(
  "/payments/:id/date",
  requireAnyRole("owner", "admin", "finance"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID pembayaran tidak valid" });
      return;
    }

    const parsed = editPaymentDateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Tanggal pembayaran tidak valid" });
      return;
    }

    try {
      const ctx = req.appContext!;
      const linkedSiteId = sql<number>`coalesce(${tenantInvoicesTable.siteId}, ${tenantsTable.siteId}, ${tenantPaymentsTable.siteId})`;
      const linkedCompanyId = sql<number>`coalesce(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId}, ${tenantPaymentsTable.companyId}, ${mallSitesTable.companyId})`;
      const conditions: SQL[] = [eq(tenantPaymentsTable.id, id)];
       if (req.siteId > 0) conditions.push(eq(linkedSiteId, req.siteId));
      if (ctx.ownerCompanyId != null) conditions.push(eq(linkedCompanyId, ctx.ownerCompanyId));
      if (ctx.ownerTenantId != null) conditions.push(eq(tenantPaymentsTable.tenantId, ctx.ownerTenantId));

    const [payment] = await db
        .select({
          id: tenantPaymentsTable.id,
          paidAt: tenantPaymentsTable.paidAt,
          isVoided: tenantPaymentsTable.isVoided,
          invoiceId: tenantPaymentsTable.invoiceId,
        })
        .from(tenantPaymentsTable)
      .leftJoin(tenantInvoicesTable, eq(tenantPaymentsTable.invoiceId, tenantInvoicesTable.id))
      .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
        .leftJoin(mallSitesTable, eq(mallSitesTable.id, linkedSiteId))
        .where(and(...conditions));

      if (!payment) {
        res.status(404).json({ error: "Pembayaran tidak ditemukan" });
        return;
      }
      if (payment.isVoided) {
        res.status(409).json({ error: "Pembayaran sudah dibatalkan, tanggal tidak dapat diedit" });
        return;
      }

      const paidAt = new Date(`${parsed.data.paymentDate}T00:00:00.000Z`);
      const [updated] = await db
        .update(tenantPaymentsTable)
        .set({ paidAt })
        .where(eq(tenantPaymentsTable.id, id))
        .returning({ id: tenantPaymentsTable.id, paidAt: tenantPaymentsTable.paidAt });

      logAudit(req, {
        action: "edit_payment_date",
        entityType: "payment",
        entityId: id,
        beforeData: { paidAt: payment.paidAt },
        afterData: { paidAt, invoiceId: payment.invoiceId },
      });

      res.json({ success: true, payment: updated });
    } catch (err) {
      logger.error({ err }, "[PUT /payments/:id/date]");
      res.status(500).json({ error: "Gagal mengubah tanggal pembayaran" });
    }
  },
);

// ─── GET /api/payments/:id/proof ─────────────────────────────────────────────
// Bukti pembayaran berada di bucket private; browser hanya menerima stream
// setelah authorization dan scope payment lolos.
router.get(
  "/payments/:id/proof",
  requireAnyRole("owner", "admin", "finance", "cashier"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID pembayaran tidak valid" });
      return;
    }

    try {
      const ctx = req.appContext!;
      const linkedSiteId = sql<number>`coalesce(${tenantInvoicesTable.siteId}, ${tenantsTable.siteId}, ${tenantPaymentsTable.siteId})`;
      const linkedCompanyId = sql<number>`coalesce(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId}, ${tenantPaymentsTable.companyId}, ${mallSitesTable.companyId})`;
      const conditions: SQL[] = [eq(tenantPaymentsTable.id, id)];
      // Owner is explicitly full-access in AppContext. Do not re-scope the
      // proof lookup to the currently selected site/company: the history row
      // has already been returned to the owner and a stale/mixed site header
      // must not turn an existing proof into a false 404.
      if (!ctx.isFullAccess) {
        if (req.siteId > 0) conditions.push(eq(linkedSiteId, req.siteId));
        if (req.siteId <= 0 && ctx.ownerCompanyId != null) conditions.push(eq(linkedCompanyId, ctx.ownerCompanyId));
        if (ctx.ownerTenantId != null) conditions.push(eq(tenantPaymentsTable.tenantId, ctx.ownerTenantId));
      }

      const [payment] = await db
        .select({
          id: tenantPaymentsTable.id,
          proofUrl: tenantPaymentsTable.proofUrl,
          proofImageUrl: tenantPaymentsTable.proofImageUrl,
        })
        .from(tenantPaymentsTable)
        .leftJoin(tenantInvoicesTable, eq(tenantPaymentsTable.invoiceId, tenantInvoicesTable.id))
        .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
        .leftJoin(mallSitesTable, eq(mallSitesTable.id, linkedSiteId))
        .where(and(...conditions));

      if (!payment) {
        res.status(404).json({ error: "Pembayaran tidak ditemukan pada konteks akses ini" });
        return;
      }

      const storedUrl = payment.proofUrl || payment.proofImageUrl;
      if (!storedUrl) {
        res.status(404).json({ error: "Referensi bukti pembayaran kosong" });
        return;
      }

      const bucket = getPaymentProofBucket();
      const filePath = getStorageObjectPath(storedUrl, bucket);
      if (!filePath) {
        res.status(422).json({ error: "Lokasi bukti pembayaran tidak valid", code: "STORAGE_OBJECT_INVALID" });
        return;
      }

      const file = await downloadFromStorage(bucket, filePath);
      const safeFilename = (filePath.split("/").pop() ?? "bukti-bayar")
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${safeFilename}"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(file.buffer);
    } catch (err) {
      logger.error({ err, paymentId: id }, "[GET /payments/:id/proof]");
      res.status(502).json({ error: "Bukti pembayaran gagal dimuat dari storage", code: "STORAGE_DOWNLOAD_FAILED" });
    }
  },
);

export default router;
