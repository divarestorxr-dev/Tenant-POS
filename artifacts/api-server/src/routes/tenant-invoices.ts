import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sseBroker } from "../lib/sse-broker";
import {
  tenantInvoicesTable,
  tenantBookingsTable,
  tenantsTable,
  tenantPaymentsTable,
  mallSitesTable,
} from "@workspace/db/schema";
import { eq, and, sql, desc, ilike, or, lte, gte, notInArray, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAnyRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { getBaseUrl } from "../lib/app-url";
import { writePaymentEvent, normalizePaymentMethod } from "../lib/payment-events";
import { sendInvoiceNotification, sendPaymentConfirmation, sendAdminPosPaymentAlert, notifyAdminGroup, getSiteCompanyName, getAdminNotifyPhones, sendWaWithFile } from "../lib/whatsapp";
import { getPaymentProofBucket, uploadToStorage } from "../lib/supabase-storage";
import { postTenantPaymentAccountingEntry } from "../lib/accounting-entry";
import multer from "multer";

const uploadPdfMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router: IRouter = Router();
router.use("/tenant-invoices", requireAnyRole("owner", "admin", "finance"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mengambil inisial nama perusahaan dari format "PT NAMA PERUSAHAAN".
 * Contoh:
 *   "PT ELIMIRA RATU ABADI"      → "ERA"
 *   "PT CAHAYA SEJATI TEKNOLOGI" → "CST"
 *   "Manajemen Gedung Utama"     → "MGU"
 */
export function getCompanyInitials(companyName: string): string {
  const cleaned = companyName
    .trim()
    .toUpperCase()
    .replace(/^PT\.?\s+/i, ""); // hapus "PT " atau "PT. " di awal
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "INV";
  return words.map((w) => w[0]).join("");
}

/** Cache sederhana siteId → prefix agar tidak query DB setiap generate */
const prefixCache = new Map<number, string>();

async function getSiteInvoicePrefix(siteId: number): Promise<string> {
  if (prefixCache.has(siteId)) return prefixCache.get(siteId)!;
  try {
    const [site] = await db
      .select({ companyName: mallSitesTable.companyName, invoicePrefix: mallSitesTable.invoicePrefix })
      .from(mallSitesTable)
      .where(eq(mallSitesTable.id, siteId))
      .limit(1);
    if (site) {
      // Prioritas: derive dari companyName → fallback ke invoicePrefix di DB → fallback "INV"
      const derived = site.companyName ? getCompanyInitials(site.companyName) : null;
      const prefix = derived ?? site.invoicePrefix ?? "INV";
      prefixCache.set(siteId, prefix);
      return prefix;
    }
  } catch {
    // ignore — gunakan fallback
  }
  return "INV";
}

/**
 * Generate invoice number format: {INISIAL_PT}/{YYYYMM}/{NNNNN}
 * Contoh: ERA/202506/00001, CST/202506/00001
 *
 * Menggunakan MAX sequence (bukan COUNT) agar tidak bentrok ketika ada gap
 * (invoice dihapus) atau pemanggilan bersamaan. Caller yang melakukan INSERT
 * harus menangkap unique constraint violation (code "23505") dan memanggil
 * ulang fungsi ini sekali lagi — lihat insertInvoiceSafe().
 */
async function generateInvoiceNumber(siteId?: number): Promise<string> {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const initials = siteId ? await getSiteInvoicePrefix(siteId) : "INV";
  const prefix = `${initials}/${yyyymm}/`;

  // Gunakan SUBSTR(str, pos) — sintaks posisional eksplisit.
  // SUBSTRING(str FROM n) di PostgreSQL diinterpretasikan sebagai regex extraction,
  // bukan positional, sehingga selalu NULL jika n berupa angka yang tidak cocok sebagai regex.
  const prefixLen = prefix.length;
  const [row] = await db
    .select({
      maxSeq: sql<number | null>`COALESCE(MAX(CAST(SUBSTR(invoice_number, ${prefixLen + 1}) AS INTEGER)), 0)`,
    })
    .from(tenantInvoicesTable)
    .where(
      sql`invoice_number LIKE ${prefix + "%"} AND LENGTH(invoice_number) = ${prefixLen + 5}`,
    );

  const next = (row?.maxSeq ?? 0) + 1;
  return `${prefix}${next.toString().padStart(5, "0")}`;
}

/**
 * INSERT invoice dengan retry otomatis jika invoice_number duplicate
 * (unique constraint violation PostgreSQL = SQLSTATE 23505).
 * Menghindari 500 akibat race condition pada generateInvoiceNumber.
 */
async function insertInvoiceSafe(
  values: any,
  siteId?: number,
  maxRetries = 3,
): Promise<typeof tenantInvoicesTable.$inferSelect> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const invoiceNumber = await generateInvoiceNumber(siteId);

    try {
      const [inserted] = await db
        .insert(tenantInvoicesTable)
        .values({ ...values, invoiceNumber })
        .returning();
      return inserted;
    } catch (err) {
      // DrizzleQueryError membungkus PG error asli di .cause — periksa keduanya
      const code =
        (err as any)?.code ??
        (err as any)?.cause?.code ??
        (err as any)?.cause?.routine;
      const isUniqueViolation = code === "23505" || (err as any)?.cause?.code === "23505";
      if (isUniqueViolation && attempt < maxRetries) {
        // Coba lagi dengan sequence berikutnya
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Gagal generate invoice number setelah ${maxRetries + 1} percobaan`);
}

const PPN_RATE = 0.11; // 11%

function calcAmounts(data: {
  rentAmount?: string | number | null;
  serviceChargeAmount?: string | number | null;
  electricityChargeAmount?: string | number | null;
  waterChargeAmount?: string | number | null;
  otherChargeAmount?: string | number | null;
  trashChargeAmount?: string | number | null;
  discountAmount?: string | number | null;
  penaltyAmount?: string | number | null;
  paidAmount?: string | number | null;
  usePpn?: boolean | null;
}) {
  const rent = Number(data.rentAmount ?? 0);
  const service = Number(data.serviceChargeAmount ?? 0);
  const elec = Number(data.electricityChargeAmount ?? 0);
  const water = Number(data.waterChargeAmount ?? 0);
  const other = Number(data.otherChargeAmount ?? 0);
  const trash = Number(data.trashChargeAmount ?? 0);
  const discount = Number(data.discountAmount ?? 0);
  const penalty = Number(data.penaltyAmount ?? 0);
  const paid = Number(data.paidAmount ?? 0);

  const subtotal = rent + service + elec + water + other + trash - discount + penalty;
  // Harga sewa sudah TERMASUK PPN (tax-inclusive).
  // PPN diekstrak dari dalam harga sewa: PPN = rent * 11/111
  // Iuran sampah, listrik, air, lain-lain TIDAK kena PPN.
  // Total tagihan = subtotal (PPN sudah di dalam rent, tidak ditambah lagi).
  const taxAmt = (data.usePpn !== false) ? Math.round(rent * PPN_RATE / (1 + PPN_RATE)) : 0;
  const total = subtotal;
  const outstanding = Math.max(total - paid, 0);

  return {
    subtotal: String(subtotal),
    taxAmount: String(taxAmt),
    totalAmount: String(total),
    outstandingAmount: String(outstanding),
  };
}

function resolveStatus(totalAmount: number, paidAmount: number, dueDate?: string | null): string {
  if (paidAmount <= 0) {
    if (dueDate && new Date(dueDate) < new Date()) return "overdue";
    return "unpaid";
  }
  if (paidAmount >= totalAmount) return "paid";
  return "partial";
}

const invoiceSelect = {
  id: tenantInvoicesTable.id,
  invoiceNumber: tenantInvoicesTable.invoiceNumber,
  siteId: tenantInvoicesTable.siteId,
  tenantId: tenantInvoicesTable.tenantId,
  bookingId: tenantInvoicesTable.bookingId,
  unitCode: tenantInvoicesTable.unitCode,
  periodStart: tenantInvoicesTable.periodStart,
  periodEnd: tenantInvoicesTable.periodEnd,
  dueDate: tenantInvoicesTable.dueDate,
  rentAmount: tenantInvoicesTable.rentAmount,
  serviceChargeAmount: tenantInvoicesTable.serviceChargeAmount,
  electricityChargeAmount: tenantInvoicesTable.electricityChargeAmount,
  waterChargeAmount: tenantInvoicesTable.waterChargeAmount,
  otherChargeAmount: tenantInvoicesTable.otherChargeAmount,
  trashChargeAmount: tenantInvoicesTable.trashChargeAmount,
  discountAmount: tenantInvoicesTable.discountAmount,
  penaltyAmount: tenantInvoicesTable.penaltyAmount,
  usePpn: tenantInvoicesTable.usePpn,
  subtotal: tenantInvoicesTable.subtotal,
  taxAmount: tenantInvoicesTable.taxAmount,
  totalAmount: tenantInvoicesTable.totalAmount,
  paidAmount: tenantInvoicesTable.paidAmount,
  outstandingAmount: tenantInvoicesTable.outstandingAmount,
  status: tenantInvoicesTable.status,
  notes: tenantInvoicesTable.notes,
  paymentToken: tenantInvoicesTable.paymentToken,
  invoiceNotifiedAt: tenantInvoicesTable.invoiceNotifiedAt,
  createdAt: tenantInvoicesTable.createdAt,
  updatedAt: tenantInvoicesTable.updatedAt,
  tenantName: tenantsTable.businessName,
  ownerName: tenantsTable.ownerName,
  boothNumber: tenantsTable.boothNumber,
  areaName: tenantsTable.areaName,
  email: tenantsTable.email,
  phone: tenantsTable.phone,
  companyId: tenantsTable.companyId,
  companyName: sql<string | null>`(SELECT company_name FROM companies WHERE id = ${tenantsTable.companyId} LIMIT 1)`,
} as const;

// ─── GET /api/tenant-invoices/ppn-report ─────────────────────────────────────
router.get("/tenant-invoices/ppn-report", async (req, res) => {
  try {
    const { from, to } = req.query; // format: YYYY-MM

    const fromMonth = from ? String(from) : new Date().toISOString().slice(0, 7);
    const toMonth   = to   ? String(to)   : fromMonth;

    // Konversi YYYY-MM ke range tanggal
    const fromDate = `${fromMonth}-01`;
    const [toYear, toMon] = toMonth.split("-").map(Number);
    const lastDay = new Date(toYear, toMon, 0).getDate();
    const toDate  = `${toMonth}-${String(lastDay).padStart(2, "0")}`;

    // siteFilter tanpa alias (untuk query tunggal) dan dengan alias ti (untuk join)
    const siteFilter   = req.siteId > 0 ? sql`AND site_id = ${req.siteId}`    : sql``;
    const siteFilterTi = req.siteId > 0 ? sql`AND ti.site_id = ${req.siteId}` : sql``;

    // Summary per bulan — dikelompokkan berdasarkan tanggal penerbitan invoice (created_at)
    const rows = await db.execute(sql`
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM') AS bulan,
        COUNT(*)::int                         AS jumlah_invoice,
        SUM(subtotal::numeric)                AS total_subtotal,
        SUM(tax_amount::numeric)              AS total_ppn,
        SUM(total_amount::numeric)            AS total_tagihan,
        SUM(paid_amount::numeric)             AS total_terbayar
      FROM tenant_invoices
      WHERE status NOT IN ('cancelled', 'draft')
        AND created_at::date BETWEEN ${fromDate}::date AND ${toDate}::date
        ${siteFilter}
      GROUP BY TO_CHAR(created_at::date, 'YYYY-MM')
      ORDER BY bulan ASC
    `);

    // Grand total
    const totals = await db.execute(sql`
      SELECT
        COUNT(*)::int              AS jumlah_invoice,
        SUM(subtotal::numeric)     AS total_subtotal,
        SUM(tax_amount::numeric)   AS total_ppn,
        SUM(total_amount::numeric) AS total_tagihan,
        SUM(paid_amount::numeric)  AS total_terbayar
      FROM tenant_invoices
      WHERE status NOT IN ('cancelled', 'draft')
        AND created_at::date BETWEEN ${fromDate}::date AND ${toDate}::date
        ${siteFilter}
    `);

    // Rekap per tenant — pakai alias ti.site_id agar tidak ambigu dengan tenants.site_id
    const byTenant = await db.execute(sql`
      SELECT
        ti.tenant_id,
        t.business_name                                  AS nama_tenant,
        t.owner_name                                     AS nama_pemilik,
        COALESCE(ti.unit_code, t.booth_number, '-')      AS unit,
        COUNT(*)::int                                    AS jumlah_invoice,
        SUM(ti.subtotal::numeric)                        AS total_subtotal,
        SUM(ti.tax_amount::numeric)                      AS total_ppn,
        SUM(ti.total_amount::numeric)                    AS total_tagihan,
        SUM(ti.paid_amount::numeric)                     AS total_terbayar
      FROM tenant_invoices ti
      LEFT JOIN tenants t ON t.id = ti.tenant_id
      WHERE ti.status NOT IN ('cancelled', 'draft')
        AND ti.created_at::date BETWEEN ${fromDate}::date AND ${toDate}::date
        ${siteFilterTi}
      GROUP BY ti.tenant_id, t.business_name, t.owner_name, COALESCE(ti.unit_code, t.booth_number, '-')
      ORDER BY SUM(ti.tax_amount::numeric) DESC
    `);

    res.json({
      from: fromMonth,
      to: toMonth,
      rows: rows.rows,
      totals: totals.rows[0] ?? {},
      byTenant: byTenant.rows,
    });
  } catch (err) {
    req.log.error(err, "Failed to get PPN report");
    res.status(500).json({ error: "Gagal mengambil laporan PPN" });
  }
});

// ─── GET /api/tenant-invoices/upcoming ───────────────────────────────────────
// Invoice yang akan jatuh tempo dalam 7 hari ke depan + yang sudah overdue
router.get("/tenant-invoices/upcoming", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const in7 = new Date(today);
    in7.setDate(in7.getDate() + 7);

    const todayStr = today.toISOString().slice(0, 10);
    const in7Str = in7.toISOString().slice(0, 10);

    const siteFilter = req.siteId > 0
      ? eq(tenantInvoicesTable.siteId, req.siteId)
      : undefined;

    const rows = await db
      .select({
        id: tenantInvoicesTable.id,
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        dueDate: tenantInvoicesTable.dueDate,
        outstandingAmount: tenantInvoicesTable.outstandingAmount,
        status: tenantInvoicesTable.status,
        tenantName: tenantsTable.businessName,
        ownerName: tenantsTable.ownerName,
      })
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(
        and(
          notInArray(tenantInvoicesTable.status, ["paid", "cancelled"]),
          // Future contract invoices are pre-generated but must not be treated as
          // current debt/upcoming collection until their billing period starts.
          sql`(${tenantInvoicesTable.periodStart} IS NULL OR ${tenantInvoicesTable.periodStart}::date <= ${todayStr}::date)`,
          lte(tenantInvoicesTable.dueDate, in7Str),
          siteFilter,
        )
      )
      .orderBy(tenantInvoicesTable.dueDate);

    const overdueItems = rows.filter(r => r.dueDate && r.dueDate < todayStr);
    const upcomingItems = rows.filter(r => r.dueDate && r.dueDate >= todayStr);

    res.json({
      count: rows.length,
      overdueCount: overdueItems.length,
      upcomingCount: upcomingItems.length,
      overdue: overdueItems,
      upcoming: upcomingItems,
    });
  } catch (err) {
    req.log.error(err, "Failed to get upcoming invoices");
    res.status(500).json({ error: "Gagal mengambil data invoice upcoming" });
  }
});

// ─── GET /api/tenant-invoices ─────────────────────────────────────────────────
router.get("/tenant-invoices", async (req, res) => {
  try {
    const { status, tenantId, search, companyId } = req.query;

    let query = db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .$dynamic();

    const conditions = [];
    if (req.siteId > 0) {
      conditions.push(eq(tenantInvoicesTable.siteId, req.siteId));
    }
    if (status && status !== "all") {
      conditions.push(eq(tenantInvoicesTable.status, String(status)));
    }
    if (tenantId && !isNaN(Number(tenantId))) {
      conditions.push(eq(tenantInvoicesTable.tenantId, Number(tenantId)));
    }
    if (companyId && companyId !== "all" && !isNaN(Number(companyId))) {
      conditions.push(eq(tenantsTable.companyId, Number(companyId)));
    }
    if (search) {
      const s = `%${String(search)}%`;
      conditions.push(
        or(
          ilike(tenantInvoicesTable.invoiceNumber, s),
          ilike(tenantsTable.businessName, s),
          ilike(tenantInvoicesTable.unitCode, s),
        )!
      );
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query.orderBy(desc(tenantInvoicesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error(err, "Failed to list invoices");
    res.status(500).json({ error: "Gagal mengambil data invoice" });
  }
});

// ─── GET /api/tenant-invoices/:id ─────────────────────────────────────────────
router.get("/tenant-invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [invoice] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, id));

    if (!invoice) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }

    const payments = await db
      .select()
      .from(tenantPaymentsTable)
      .where(eq(tenantPaymentsTable.invoiceId, id))
      .orderBy(desc(tenantPaymentsTable.paidAt));

    res.json({
      ...invoice,
      payments: payments.map(({ proofUrl, proofImageUrl, ...payment }) => {
        const hasProof = Boolean(proofUrl || proofImageUrl);
        return {
          ...payment,
          proofUrl: hasProof ? `/api/payments/${payment.id}/proof` : null,
          proofImageUrl: hasProof ? `/api/payments/${payment.id}/proof` : null,
        };
      }),
    });
  } catch (err) {
    req.log.error(err, "Failed to get invoice");
    res.status(500).json({ error: "Gagal mengambil invoice" });
  }
});

// ─── GET /api/tenant-invoices/:id/payment-link ────────────────────────────────
router.get("/tenant-invoices/:id/payment-link", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [row] = await db
      .select({
        id: tenantInvoicesTable.id,
        paymentToken: tenantInvoicesTable.paymentToken,
        status: tenantInvoicesTable.status,
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
      })
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, id));

    if (!row) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }
    if (row.status === "cancelled") {
      res.status(409).json({ error: "Invoice yang dibatalkan tidak memiliki piutang aktif atau link pembayaran" });
      return;
    }
    if (row.status === "paid") {
      res.status(409).json({ error: "Invoice sudah lunas dan tidak memerlukan link pembayaran" });
      return;
    }

    if (!row.paymentToken) {
      res.status(422).json({ error: "Invoice ini belum memiliki token pembayaran. Coba kirim link WA terlebih dahulu untuk membuat token." });
      return;
    }

    const base = await getBaseUrl();
    if (!base) {
      res.status(422).json({ error: "Domain pembayaran belum dikonfigurasi. Isi di Pengaturan → Domain Link Pembayaran." });
      return;
    }

    res.json({
      invoiceNumber: row.invoiceNumber,
      status: row.status,
      link: `${base}/bayar/${row.paymentToken}`,
    });
  } catch (err) {
    req.log.error(err, "Failed to get payment link");
    res.status(500).json({ error: "Gagal mengambil link pembayaran" });
  }
});

// ─── POST /api/tenant-invoices/bulk ──────────────────────────────────────────
const bulkInvoiceItemSchema = z.object({
  tenantId: z.number().int().positive({ message: "Tenant wajib dipilih" }),
  unitCode: z.string().optional().nullable(),
  periodStart: z.string().optional().nullable(),
  periodEnd: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  rentAmount: z.union([z.string(), z.number()]).optional().nullable(),
  serviceChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  electricityChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  waterChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  otherChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  trashChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  discountAmount: z.union([z.string(), z.number()]).optional().nullable(),
  penaltyAmount: z.union([z.string(), z.number()]).optional().nullable(),
  taxAmount: z.union([z.string(), z.number()]).optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(["draft", "unpaid", "partial", "paid", "overdue", "cancelled"]).optional(),
});

router.post("/tenant-invoices/bulk", async (req, res) => {
  const parsed = z.array(bulkInvoiceItemSchema).min(1, "Minimal 1 invoice").safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg });
    return;
  }

  const results: { tenantId: number; invoiceNumber: string; success: boolean; error?: string }[] = [];

  for (const item of parsed.data) {
    try {
      // Cek duplikat: jika sudah ada invoice untuk tenant + periode yang sama, skip
      if (item.periodStart && item.periodEnd) {
        const startDate = new Date(item.periodStart);
        const endDate = new Date(item.periodEnd);
        const existing = await db
          .select({ id: tenantInvoicesTable.id, invoiceNumber: tenantInvoicesTable.invoiceNumber })
          .from(tenantInvoicesTable)
          .where(
            and(
              eq(tenantInvoicesTable.tenantId, item.tenantId),
              sql`DATE(${tenantInvoicesTable.periodStart}) = DATE(${startDate.toISOString()})`,
              sql`DATE(${tenantInvoicesTable.periodEnd}) = DATE(${endDate.toISOString()})`,
            )
          )
          .limit(1);
        if (existing.length > 0) {
          results.push({
            tenantId: item.tenantId,
            invoiceNumber: existing[0].invoiceNumber,
            success: false,
            error: `Invoice ${existing[0].invoiceNumber} sudah ada untuk periode ini`,
          });
          continue;
        }
      }

      const { subtotal, taxAmount: calcedTax, totalAmount, outstandingAmount } = calcAmounts(item);
      const status = item.status ?? resolveStatus(Number(totalAmount), 0, item.dueDate ?? null);

      const invoice = await insertInvoiceSafe(
        {
          ...(req.siteId > 0 ? { siteId: req.siteId } : {}),
          tenantId: item.tenantId,
          unitCode: item.unitCode ?? null,
          periodStart: item.periodStart ?? null,
          periodEnd: item.periodEnd ?? null,
          dueDate: item.dueDate ?? null,
          rentAmount: String(item.rentAmount ?? "0"),
          serviceChargeAmount: String(item.serviceChargeAmount ?? "0"),
          electricityChargeAmount: String(item.electricityChargeAmount ?? "0"),
          waterChargeAmount: String(item.waterChargeAmount ?? "0"),
          otherChargeAmount: String(item.otherChargeAmount ?? "0"),
          trashChargeAmount: String(item.trashChargeAmount ?? "0"),
          discountAmount: String(item.discountAmount ?? "0"),
          penaltyAmount: String(item.penaltyAmount ?? "0"),
          taxAmount: calcedTax,
          subtotal,
          totalAmount,
          paidAmount: "0",
          outstandingAmount,
          status,
          notes: item.notes ?? null,
        },
        req.siteId > 0 ? req.siteId : undefined,
      );

      logAudit(req, {
        action: "create_invoice",
        entityType: "invoice",
        entityId: invoice.id,
        afterData: { ...invoice, bulk: true },
      });

      results.push({ tenantId: item.tenantId, invoiceNumber: invoice.invoiceNumber, success: true });
    } catch (err) {
      req.log.error(err, `Failed to create bulk invoice for tenant ${item.tenantId}`);
      results.push({ tenantId: item.tenantId, invoiceNumber: "", success: false, error: (err as Error).message });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  res.status(succeeded > 0 ? 201 : 500).json({ results, succeeded, failed });
});

// ─── POST /api/tenant-invoices ─────────────────────────────────────────────────
const optionalPositiveInt = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.coerce.number().int().positive().nullable(),
);

const createInvoiceSchema = z.object({
  tenantId: z.coerce.number().int().positive({ message: "Tenant wajib dipilih" }),
  bookingId: optionalPositiveInt.optional(),
  unitCode: z.string().optional().nullable(),
  periodStart: z.string().optional().nullable(),
  periodEnd: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  rentAmount: z.union([z.string(), z.number()]).optional().nullable(),
  serviceChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  electricityChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  waterChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  otherChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  trashChargeAmount: z.union([z.string(), z.number()]).optional().nullable(),
  discountAmount: z.union([z.string(), z.number()]).optional().nullable(),
  penaltyAmount: z.union([z.string(), z.number()]).optional().nullable(),
  taxAmount: z.union([z.string(), z.number()]).optional().nullable(),
  usePpn: z.boolean().optional(),
  notes: z.string().optional().nullable(),
  status: z.enum(["draft", "unpaid", "partial", "paid", "overdue", "cancelled"]).optional(),
});

router.post("/tenant-invoices", async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg });
    return;
  }

  const data = parsed.data;
  const usePpn = data.usePpn !== false;
  const { subtotal, taxAmount: calcedTax, totalAmount, outstandingAmount } = calcAmounts({ ...data, usePpn });

  const status = data.status ?? resolveStatus(
    Number(totalAmount),
    0,
    data.dueDate ?? null,
  );

  try {
    // Manual invoice yang ditautkan ke booking tidak boleh membuat duplikat
    // untuk booking + period_start yang sama. Database production memiliki
    // guard idempotency untuk pasangan ini; tanpa pre-check error 23505
    // sebelumnya berubah menjadi HTTP 500 generik.
    if (data.bookingId && data.periodStart) {
      const [existing] = await db
        .select({
          id: tenantInvoicesTable.id,
          invoiceNumber: tenantInvoicesTable.invoiceNumber,
          status: tenantInvoicesTable.status,
        })
        .from(tenantInvoicesTable)
        .where(
          and(
            eq(tenantInvoicesTable.bookingId, data.bookingId),
            eq(tenantInvoicesTable.periodStart, data.periodStart),
          ),
        )
        .limit(1);

      if (existing) {
        res.status(409).json({
          error: `Invoice ${existing.invoiceNumber} sudah ada untuk booking dan periode tersebut. Buka invoice yang sudah ada atau pilih periode lain.`,
          existingInvoiceId: existing.id,
          existingInvoiceNumber: existing.invoiceNumber,
        });
        return;
      }
    }

    const invoice = await insertInvoiceSafe(
      {
        ...(req.siteId > 0 ? { siteId: req.siteId } : {}),
        tenantId: data.tenantId,
        bookingId: data.bookingId ?? null,
        unitCode: data.unitCode ?? null,
        periodStart: data.periodStart ?? null,
        periodEnd: data.periodEnd ?? null,
        dueDate: data.dueDate ?? null,
        rentAmount: String(data.rentAmount ?? "0"),
        serviceChargeAmount: String(data.serviceChargeAmount ?? "0"),
        electricityChargeAmount: String(data.electricityChargeAmount ?? "0"),
        waterChargeAmount: String(data.waterChargeAmount ?? "0"),
        otherChargeAmount: String(data.otherChargeAmount ?? "0"),
        trashChargeAmount: String(data.trashChargeAmount ?? "0"),
        discountAmount: String(data.discountAmount ?? "0"),
        penaltyAmount: String(data.penaltyAmount ?? "0"),
        usePpn,
        taxAmount: calcedTax,
        subtotal,
        totalAmount,
        paidAmount: "0",
        outstandingAmount,
        status,
        notes: data.notes ?? null,
      },
      req.siteId > 0 ? req.siteId : undefined,
    );

    const [withTenant] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, invoice.id));

    logAudit(req, {
      action: "create_invoice",
      entityType: "invoice",
      entityId: withTenant?.id,
      afterData: withTenant,
    });
    res.status(201).json(withTenant);
  } catch (err) {
    req.log.error(err, "Failed to create invoice");

    const dbCode =
      (err as any)?.code ??
      (err as any)?.cause?.code;

    if (dbCode === "23505") {
      res.status(409).json({
        error: "Invoice duplikat terdeteksi. Periksa booking/periode atau nomor invoice lalu coba lagi.",
      });
      return;
    }

    if (dbCode === "23503") {
      res.status(400).json({
        error: "Tenant atau booking yang dipilih sudah tidak valid. Muat ulang halaman lalu pilih kembali.",
      });
      return;
    }

    if (dbCode === "23502") {
      res.status(400).json({
        error: "Data invoice belum lengkap. Muat ulang halaman lalu lengkapi field wajib.",
      });
      return;
    }

    res.status(500).json({ error: "Gagal membuat invoice. Silakan muat ulang halaman dan coba lagi." });
  }
});

// ─── PATCH /api/tenant-invoices/:id ──────────────────────────────────────────
router.patch("/tenant-invoices/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const parsed = createInvoiceSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, id));

    if (!existing) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "Invoice yang dibatalkan tidak dapat diubah" });
      return;
    }

    const merged = { ...existing, ...parsed.data };
    const mergedUsePpn = parsed.data.usePpn !== undefined ? parsed.data.usePpn : (existing.usePpn ?? true);
    const { subtotal, taxAmount: calcedTax, totalAmount, outstandingAmount } = calcAmounts({
      ...merged,
      paidAmount: existing.paidAmount,
      usePpn: mergedUsePpn,
    });

    const status = parsed.data.status ?? resolveStatus(
      Number(totalAmount),
      Number(existing.paidAmount),
      merged.dueDate ?? null,
    );

    const [updated] = await db
      .update(tenantInvoicesTable)
      .set({
        unitCode: merged.unitCode ?? null,
        periodStart: merged.periodStart ?? null,
        periodEnd: merged.periodEnd ?? null,
        dueDate: merged.dueDate ?? null,
        rentAmount: String(merged.rentAmount ?? "0"),
        serviceChargeAmount: String(merged.serviceChargeAmount ?? "0"),
        electricityChargeAmount: String(merged.electricityChargeAmount ?? "0"),
        waterChargeAmount: String(merged.waterChargeAmount ?? "0"),
        otherChargeAmount: String(merged.otherChargeAmount ?? "0"),
        trashChargeAmount: String(merged.trashChargeAmount ?? "0"),
        discountAmount: String(merged.discountAmount ?? "0"),
        penaltyAmount: String(merged.penaltyAmount ?? "0"),
        usePpn: mergedUsePpn,
        taxAmount: calcedTax,
        subtotal,
        totalAmount,
        outstandingAmount,
        status,
        notes: merged.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tenantInvoicesTable.id, id))
      .returning();

    const [withTenant] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, updated.id));

    sseBroker.publish("invoice_updated", { invoiceId: id });
    res.json(withTenant);
  } catch (err) {
    req.log.error(err, "Failed to update invoice");
    res.status(500).json({ error: "Gagal memperbarui invoice" });
  }
});

// ─── POST /api/tenant-invoices/:id/recalculate ───────────────────────────────
// Hitung ulang tax_amount, total_amount, outstanding_amount berdasarkan
// subtotal yang sudah tersimpan. Berguna untuk invoice lama yang dibuat
// sebelum PPN 11% diimplementasikan (tax_amount = 0).
router.post("/tenant-invoices/:id/recalculate", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [inv] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, id));

    if (!inv) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }
    if (inv.status === "cancelled") {
      res.status(409).json({ error: "Invoice yang dibatalkan tidak dapat dihitung ulang" });
      return;
    }

    // Harga sewa sudah TERMASUK PPN (tax-inclusive).
    // PPN diekstrak dari dalam rentAmount: PPN = rent * 11/111
    // Iuran sampah, listrik, dll TIDAK kena PPN.
    // Total = subtotal (PPN sudah di dalam rent, tidak ditambah lagi).
    const rentNum     = Number(inv.rentAmount ?? 0);
    const subtotalNum = Number(inv.subtotal);
    const paidNum     = Number(inv.paidAmount);
    const taxAmt      = (inv.usePpn !== false) ? Math.round(rentNum * PPN_RATE / (1 + PPN_RATE)) : 0;
    const totalNum    = subtotalNum;
    const outstanding = Math.max(totalNum - paidNum, 0);
    const status      = resolveStatus(totalNum, paidNum, inv.dueDate);

    const [updated] = await db
      .update(tenantInvoicesTable)
      .set({
        taxAmount:         String(taxAmt),
        totalAmount:       String(totalNum),
        outstandingAmount: String(outstanding),
        status,
        updatedAt:         new Date(),
      })
      .where(eq(tenantInvoicesTable.id, id))
      .returning();

    const [withTenant] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, updated.id));

    logAudit(req, {
      action:     "recalculate_invoice",
      entityType: "invoice",
      entityId:   id,
      afterData:  withTenant,
    });

    sseBroker.publish("invoice_updated", { invoiceId: id });
    res.json(withTenant);
  } catch (err) {
    req.log.error(err, "Failed to recalculate invoice");
    res.status(500).json({ error: "Gagal menghitung ulang invoice" });
  }
});

// ─── POST /api/tenant-invoices/generate-from-booking/:bookingId ───────────────
router.post("/tenant-invoices/generate-from-booking/:bookingId", async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (isNaN(bookingId)) { res.status(400).json({ error: "ID booking tidak valid" }); return; }

  try {
    const [booking] = await db
      .select()
      .from(tenantBookingsTable)
      .where(eq(tenantBookingsTable.id, bookingId));

    if (!booking) { res.status(404).json({ error: "Booking tidak ditemukan" }); return; }

    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, booking.tenantId));

    if (!tenant) { res.status(404).json({ error: "Tenant tidak ditemukan" }); return; }

    if (!booking.tenantId) {
      res.status(400).json({ error: "Booking tidak memiliki tenant_id yang valid" });
      return;
    }

    const billingCycle = booking.billingCycle ?? "monthly";
    const startDate = booking.startDate ? new Date(booking.startDate) : new Date();
    const now = new Date();

    let periodStart: Date;
    let periodEnd: Date;
    let dueDate: Date;

    if (billingCycle === "monthly") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      dueDate = new Date(now.getFullYear(), now.getMonth() + 1, 5);
    } else if (billingCycle === "quarterly") {
      const q = Math.floor(now.getMonth() / 3);
      periodStart = new Date(now.getFullYear(), q * 3, 1);
      periodEnd = new Date(now.getFullYear(), q * 3 + 3, 0);
      dueDate = new Date(periodEnd);
      dueDate.setDate(dueDate.getDate() + 5);
    } else if (billingCycle === "yearly") {
      periodStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      periodEnd = new Date(startDate.getFullYear() + 1, startDate.getMonth(), 0);
      dueDate = new Date(periodEnd);
      dueDate.setDate(dueDate.getDate() + 14);
    } else {
      periodStart = startDate;
      periodEnd = booking.endDate
        ? new Date(booking.endDate)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0);
      dueDate = new Date(periodEnd);
      dueDate.setDate(dueDate.getDate() + 5);
    }

    const toDateStr = (d: Date) => d.toISOString().slice(0, 10);

    const periodStartStr = toDateStr(periodStart);
    const periodEndStr = toDateStr(periodEnd);
    const dueDateStr = toDateStr(dueDate);

    // ── Idempotency: jika invoice untuk booking+periode ini sudah ada, kembalikan
    const [existingInvoice] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(
        and(
          eq(tenantInvoicesTable.bookingId, bookingId),
          eq(tenantInvoicesTable.periodStart, periodStartStr),
          eq(tenantInvoicesTable.periodEnd, periodEndStr),
        ),
      );

    if (existingInvoice) {
      req.log.info(
        { invoiceId: existingInvoice.id, bookingId },
        "Invoice untuk periode ini sudah ada, dikembalikan",
      );
      res.status(409).json({
        error: "Invoice untuk booking dan periode ini sudah dibuat sebelumnya",
        invoice: existingInvoice,
      });
      return;
    }

    const rent = Number(booking.rentAmount ?? 0);
    const service = Number(booking.serviceChargeAmount ?? 0);
    const elec = Number(booking.electricityChargeAmount ?? 0);
    const water = Number(booking.waterChargeAmount ?? 0);

    const { subtotal: subtotalStr, taxAmount: calcedTax, totalAmount: totalStr, outstandingAmount: outstandingStr } = calcAmounts({
      rentAmount: rent,
      serviceChargeAmount: service,
      electricityChargeAmount: elec,
      waterChargeAmount: water,
    });

    // Gunakan insertInvoiceSafe agar tidak 500 jika ada race condition pada invoice number
    const invoice = await insertInvoiceSafe(
      {
        ...(req.siteId > 0 ? { siteId: req.siteId } : {}),
        tenantId: booking.tenantId,
        bookingId,
        unitCode: booking.unitCode ?? null,
        periodStart: periodStartStr,
        periodEnd: periodEndStr,
        dueDate: dueDateStr,
        rentAmount: String(rent),
        serviceChargeAmount: String(service),
        electricityChargeAmount: String(elec),
        waterChargeAmount: String(water),
        otherChargeAmount: "0",
        discountAmount: "0",
        penaltyAmount: "0",
        taxAmount: calcedTax,
        subtotal: subtotalStr,
        totalAmount: totalStr,
        paidAmount: "0",
        outstandingAmount: outstandingStr,
        status: new Date(dueDateStr) < now ? "overdue" : "unpaid",
        notes: (req.body as Record<string, unknown>).notes as string ?? null,
      },
      req.siteId > 0 ? req.siteId : undefined,
    );

    const [withTenant] = await db
      .select(invoiceSelect)
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, invoice.id));

    req.log.info(
      { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, bookingId },
      "Invoice berhasil dibuat dari booking",
    );

    logAudit(req, {
      action: "create_invoice",
      entityType: "invoice",
      entityId: invoice.id,
      afterData: withTenant,
    });
    res.status(201).json(withTenant);

    // ── Kirim WA notifikasi tagihan baru ke tenant (fire-and-forget) ──────────
    void (async () => {
      try {
        const phone = withTenant?.phone as string | null | undefined;
        if (!phone) return;

        const companyName = await getSiteCompanyName(req.siteId > 0 ? req.siteId : null).catch(() => undefined);
        const baseUrl = await getBaseUrl().catch(() => undefined);
        const paymentToken = (withTenant as unknown as Record<string, unknown>)?.paymentToken as string | null | undefined;
        const paymentLink = baseUrl && paymentToken
          ? `${baseUrl}/bayar/${paymentToken}`
          : undefined;

        // Format periode label: "Januari 2026"
        const periodStartStr = withTenant?.periodStart as string | undefined;
        const periodLabel = periodStartStr
          ? new Date(periodStartStr).toLocaleDateString("id-ID", { month: "long", year: "numeric" })
          : "-";

        const dueDateStr = withTenant?.dueDate as string | undefined;
        const dueDateLabel = dueDateStr
          ? new Date(dueDateStr).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })
          : "-";

        await sendInvoiceNotification({
          ownerName: (withTenant?.ownerName as string | null | undefined) ?? "Tenant",
          businessName: (withTenant?.tenantName as string | null | undefined) ?? "",
          invoiceNumber: (withTenant?.invoiceNumber as string | undefined) ?? invoice.invoiceNumber,
          periodLabel,
          totalAmount: withTenant?.totalAmount ?? "0",
          dueDate: dueDateLabel,
          phone,
          paymentLink: paymentLink && paymentLink.endsWith("/") ? undefined : paymentLink,
          companyName,
        });
        void notifyAdminGroup({
          eventType: "invoice_sent",
          businessName: (withTenant?.tenantName as string | null | undefined) ?? "",
          ownerName: (withTenant?.ownerName as string | null | undefined) ?? "Tenant",
          invoiceNumber: (withTenant?.invoiceNumber as string | undefined) ?? invoice.invoiceNumber,
          amount: withTenant?.totalAmount ?? "0",
          periodLabel,
          dueDate: dueDateLabel,
          siteName: companyName,
          paymentLink: paymentLink && paymentLink.endsWith("/") ? undefined : paymentLink,
        }).catch(() => {});
      } catch { /* tidak perlu throw */ }
    })();
  } catch (err) {
    req.log.error({ err, bookingId }, "Gagal membuat invoice dari booking");
    res.status(500).json({ error: "Gagal membuat invoice dari booking" });
  }
});

// ─── POST /api/tenant-invoices/:id/cancel ────────────────────────────────────
router.post("/tenant-invoices/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [existing] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, id));

    if (!existing) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }
    if (existing.status === "cancelled") {
      res.json(existing);
      return;
    }
    if (existing.status === "paid") {
      res.status(409).json({ error: "Invoice yang sudah lunas tidak dapat dibatalkan" });
      return;
    }

    const [existingPayment] = await db
      .select({ id: tenantPaymentsTable.id })
      .from(tenantPaymentsTable)
      .where(eq(tenantPaymentsTable.invoiceId, id))
      .limit(1);

    if (Number(existing.paidAmount ?? 0) > 0 || existingPayment) {
      res.status(409).json({
        error: "Invoice yang sudah memiliki pembayaran tidak dapat dibatalkan. Lakukan koreksi/refund sesuai prosedur pembayaran.",
      });
      return;
    }

    const [updated] = await db
      .update(tenantInvoicesTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(tenantInvoicesTable.id, id))
      .returning();

    logAudit(req, {
      action: "cancel_invoice",
      entityType: "invoice",
      entityId: id,
      beforeData: existing,
      afterData: updated,
    });
    res.json(updated);
  } catch (err) {
    req.log.error(err, "Failed to cancel invoice");
    res.status(500).json({ error: "Gagal membatalkan invoice" });
  }
});

// ─── POST /api/tenant-invoices/:id/payment ────────────────────────────────────
const invoicePaymentProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)) {
      cb(new Error("Format bukti pembayaran tidak didukung (JPG, PNG, WebP, PDF)"));
      return;
    }
    cb(null, true);
  },
});

const invoicePaymentSchema = z.object({
  amountPaid: z.coerce.number().positive({ message: "Jumlah bayar harus lebih dari 0" }),
  paymentMethod: z.enum(["tunai", "transfer", "qris", "edc", "other"]).default("tunai"),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal pembayaran harus YYYY-MM-DD").optional(),
  notes: z.string().optional().nullable(),
});

router.post("/tenant-invoices/:id/payment", (req, res, next) => {
  invoicePaymentProofUpload.single("proof")(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Berkas bukti pembayaran tidak valid" });
      return;
    }
    next();
  });
}, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const parsed = invoicePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg });
    return;
  }

  const { amountPaid, paymentMethod, paymentDate, notes } = parsed.data;
  // Tanggal transaksi dan waktu input admin adalah dua fakta berbeda.
  const todayWib = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (paymentDate && (Number.isNaN(Date.parse(paymentDate + "T12:00:00+07:00")) || new Date(paymentDate + "T12:00:00+07:00").toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }) !== paymentDate)) {
    res.status(400).json({ error: "Tanggal pembayaran tidak valid" }); return;
  }
  if (paymentDate && paymentDate > todayWib) {
    res.status(400).json({ error: "Tanggal pembayaran tidak boleh di masa depan" }); return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(tenantInvoicesTable)
        .where(eq(tenantInvoicesTable.id, id))
        .for("update");

      if (!invoice) throw Object.assign(new Error("Invoice tidak ditemukan"), { status: 404 });
      if (invoice.status === "cancelled") throw Object.assign(new Error("Invoice telah dibatalkan"), { status: 409 });
      if (invoice.status === "paid") throw Object.assign(new Error("Invoice ini sudah lunas"), { status: 409 });

      // Blokir pembayaran jika period_start invoice belum dimulai (invoice bulan depan/lusa).
      // Mencegah admin tidak sengaja mencatat bayar pada invoice yang belum jatuh tempo bulannya.
      if (invoice.periodStart) {
        const periodStart = new Date(invoice.periodStart + "T00:00:00Z");
        // Gunakan tanggal WIB: UTC+7
        const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const todayWib = new Date(
          `${nowWib.getUTCFullYear()}-${String(nowWib.getUTCMonth() + 1).padStart(2, "0")}-${String(nowWib.getUTCDate()).padStart(2, "0")}T00:00:00Z`
        );
        if (periodStart > todayWib) {
          const periodeLabel = periodStart.toLocaleDateString("id-ID", { month: "long", year: "numeric" });
          throw Object.assign(
            new Error(
              `Invoice periode ${periodeLabel} belum bisa dibayar — periode sewa belum dimulai. ` +
              `Pembayaran hanya dapat dicatat setelah tanggal ${periodStart.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}.`
            ),
            { status: 409 },
          );
        }
      }

      // Blokir pembayaran langsung jika ada bukti yang masih pending_review.
      // Admin harus memproses bukti tersebut terlebih dahulu di halaman Tinjau Pembayaran
      // agar tidak terjadi pembayaran ganda.
      const [pendingProof] = await tx
        .select({ id: tenantPaymentsTable.id, receiptNumber: tenantPaymentsTable.receiptNumber })
        .from(tenantPaymentsTable)
        .where(and(
          eq(tenantPaymentsTable.invoiceId, id),
          eq(tenantPaymentsTable.approvalStatus, "pending_review"),
          eq(tenantPaymentsTable.isVoided, false),
        ))
        .limit(1);

      if (pendingProof) {
        throw Object.assign(
          new Error(
            `Invoice ini memiliki bukti pembayaran yang sedang menunggu verifikasi (${pendingProof.receiptNumber}). ` +
            `Setujui atau tolak bukti tersebut di halaman Tinjau Pembayaran sebelum mencatat pembayaran baru.`
          ),
          { status: 409 },
        );
      }

      const total = Number(invoice.totalAmount);
      const currentPaid = Number(invoice.paidAmount ?? 0);
      const currentOutstanding = Math.max(total - currentPaid, 0);

      const [site] = invoice.siteId
        ? await tx
            .select({ type: mallSitesTable.type })
            .from(mallSitesTable)
            .where(eq(mallSitesTable.id, invoice.siteId))
            .limit(1)
        : [null];

      const isSportCenter = site?.type === "sport_center";
      const invoiceAllocationAmount =
        isSportCenter ? Math.min(amountPaid, currentOutstanding) : amountPaid;
      const surchargeAllocationAmount =
        isSportCenter ? Math.max(amountPaid - invoiceAllocationAmount, 0) : 0;

      if (!isSportCenter && amountPaid > currentOutstanding * 1.001) {
        throw Object.assign(
          new Error(`Pembayaran melebihi sisa invoice Rp ${currentOutstanding.toLocaleString("id-ID")}`),
          { status: 400 },
        );
      }

      const newPaidAmount = currentPaid + invoiceAllocationAmount;
      const outstanding = Math.max(total - newPaidAmount, 0);

      let newStatus: string;
      if (newPaidAmount >= total) newStatus = "paid";
      else if (newPaidAmount > 0) newStatus = "partial";
      else newStatus = invoice.dueDate && new Date(invoice.dueDate) < new Date() ? "overdue" : "unpaid";

      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const prefix = `INV-PAY-${datePart}-`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`);
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tenantPaymentsTable)
        .where(sql`receipt_number LIKE ${prefix + "%"}`);
      const seq = ((countRow?.count ?? 0) + 1).toString().padStart(4, "0");
      const receiptNumber = `${prefix}${seq}`;

      const paidAt = paymentDate ? new Date(paymentDate + "T12:00:00+07:00") : new Date();
      let proofUrl: string | null = null;
      if (req.file) {
        const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
        if (!allowed.includes(req.file.mimetype)) throw Object.assign(new Error("Format bukti harus JPG, PNG, WebP, atau PDF"), { status: 400 });
        const extension = req.file.mimetype === "application/pdf" ? "pdf" : req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
        const filename = `invoice-payment-${id}-${crypto.randomUUID()}.${extension}`;
        try { proofUrl = await uploadToStorage(getPaymentProofBucket(), filename, req.file.buffer, req.file.mimetype, false); }
        catch { throw Object.assign(new Error("Gagal menyimpan bukti pembayaran; transaksi belum dicatat"), { status: 502 }); }
      }

      const [payment] = await tx
        .insert(tenantPaymentsTable)
        .values({
          ...(req.siteId > 0 ? { siteId: req.siteId } : {}),
          siteId: req.siteId > 0 ? req.siteId : undefined,
          invoiceId: id,
          tenantId: invoice.tenantId,
          bookingId: invoice.bookingId ?? null,
          tenantBookingId: invoice.bookingId ?? null,
          amount: String(amountPaid),
          invoiceAllocationAmount: String(invoiceAllocationAmount),
          surchargeAllocationAmount: String(surchargeAllocationAmount),
          discountAmount: "0",
          penaltyAmount: "0",
          paymentMethod,
          paymentStatus: "PAID",
          receiptNumber,
          notes: notes ?? null,
          paidAt,
          proofUrl,
          proofImageUrl: proofUrl,
        })
        .returning();

      const [updatedInvoice] = await tx
        .update(tenantInvoicesTable)
        .set({
          paidAmount: String(newPaidAmount),
          outstandingAmount: String(outstanding),
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(tenantInvoicesTable.id, id))
        .returning();

      return { payment, invoice: updatedInvoice, receiptNumber, newStatus, newPaidAmount, outstanding, invoiceAllocationAmount, surchargeAllocationAmount };
    });

    logAudit(req, {
      action: "create_payment",
      entityType: "payment",
      entityId: result.payment.id,
      afterData: {
        paymentId: result.payment.id,
        invoiceId: id,
        amountPaid,
        paymentMethod,
        paymentDate: result.payment.paidAt?.toISOString(),
        recordedAt: result.payment.createdAt?.toISOString(),
        hasProof: Boolean(result.payment.proofUrl),
        receiptNumber: result.receiptNumber,
        invoiceStatus: result.newStatus,
        invoiceAllocationAmount: result.invoiceAllocationAmount,
        surchargeAllocationAmount: result.surchargeAllocationAmount,
      },
    });
    sseBroker.publish("payment_created", { paymentId: result.payment.id, invoiceId: id });

    writePaymentEvent({
      sourceApp: "tenant_management",
      ownerApp: "tenant_management",
      sourceModule: "tenant_invoice",
      sourceTable: "tenant_payments",
      sourceId: result.payment.id,
      tenantId: result.payment.tenantId ?? null,
      siteId: result.payment.siteId ?? null,
      invoiceId: id,
      amount: amountPaid,
      direction: "IN",
      paymentMethod: normalizePaymentMethod(paymentMethod),
      paymentStatus: "confirmed",
      metadata: {
        receiptNumber: result.receiptNumber,
        invoiceStatus: result.newStatus,
        source: "direct_invoice_payment",
        grossAmount: amountPaid,
        invoiceAllocationAmount: result.invoiceAllocationAmount,
        surchargeAllocationAmount: result.surchargeAllocationAmount,
      },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      payment: result.payment,
      receiptNumber: result.receiptNumber,
      invoiceStatus: result.newStatus,
      paidAmount: result.newPaidAmount,
      outstandingAmount: result.outstanding,
      allocation: { invoiceAmount: result.invoiceAllocationAmount, surchargeAmount: result.surchargeAllocationAmount },
    });

    // ── Fire-and-forget: Accounting journal + tax entry ──────────────────────
    void (async () => {
      const p = result.payment;
      const inv = result.invoice;
      const siteId = p.siteId ?? req.siteId ?? null;

      // Ambil businessName dari tenant
      const [tenantRow] = p.tenantId
        ? await db
            .select({ businessName: tenantsTable.businessName })
            .from(tenantsTable)
            .where(eq(tenantsTable.id, p.tenantId))
        : [];

      // Accounting entry double-entry (accounting_entries + lines)
      try {
        await postTenantPaymentAccountingEntry({
          paymentId: p.id,
          siteId,
          invoiceNumber: inv.invoiceNumber ?? null,
          businessName: tenantRow?.businessName ?? null,
          amountPaid: result.invoiceAllocationAmount,
          surchargeAmount: result.surchargeAllocationAmount,
          paymentMethod: p.paymentMethod ?? paymentMethod,
          transactionDate: p.paidAt ?? new Date(),
          receiptNumber: p.receiptNumber ?? result.receiptNumber,
          sourceModule: "direct_invoice_payment",
        });
      } catch (err) {
        req.log?.error({ err }, "[invoice-pay] postTenantPaymentAccountingEntry gagal — non-fatal");
      }
    })();

    // ── Fire-and-forget: Kirim WA ke tenant + admin setelah pembayaran invoice ──
    void (async () => {
      try {
        const invoice = result.invoice;
        const paymentId = result.payment.id;
        const siteId = (result.payment.siteId as number | null) ?? req.siteId ?? null;
        const invoiceNumber = invoice.invoiceNumber ?? `INV-${id}`;

        // Ambil data tenant (nama + nomor HP)
        const [tenant] = await db
          .select({ businessName: tenantsTable.businessName, ownerName: tenantsTable.ownerName, phone: tenantsTable.phone })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, invoice.tenantId!))
          .limit(1);

        const companyName = await getSiteCompanyName(siteId);

        // 1. Kirim WA konfirmasi pembayaran ke tenant
        if (tenant?.phone) {
          try {
            await sendPaymentConfirmation({
              ownerName: tenant.ownerName ?? "Tenant",
              businessName: tenant.businessName ?? "Tenant",
              invoiceNumber,
              amountPaid,
              paymentMethod,
              phone: tenant.phone,
              companyName,
            });
          } catch (waErr) {
            req.log.error({ err: waErr, paymentId }, "[invoice-pay] Gagal kirim WA ke tenant — non-fatal");
          }
        }

        // 2. Kirim WA notifikasi ke admin/owner
        const adminPhones = await getAdminNotifyPhones();
        // Filter group JID — notifikasi grup ditangani sendiri oleh notifyAdminGroup
        const individualAdmins = adminPhones.filter((a) => !a.phone.includes("@"));

        const kasirName = (req.user as { name?: string } | undefined)?.name ?? "Admin";
        await Promise.allSettled(
          individualAdmins.map((admin) =>
            sendAdminPosPaymentAlert({
              adminName: admin.name,
              adminPhone: admin.phone,
              businessName: tenant?.businessName ?? "Tenant",
              ownerName: tenant?.ownerName ?? "-",
              receiptNumber: result.receiptNumber,
              invoiceNumber,
              amountPaid,
              paymentMethod,
              kasirName,
              siteName: companyName ?? null,
            }),
          ),
        );
        // Notifikasi ke WA Group admin
        notifyAdminGroup({
          eventType: "pos_kasir",
          businessName: tenant?.businessName ?? "Tenant",
          ownerName: tenant?.ownerName ?? "-",
          receiptNumber: result.receiptNumber,
          invoiceNumber,
          amount: amountPaid,
          paymentMethod,
          kasirName,
          siteName: companyName ?? null,
        }).catch(() => {});
      } catch (postErr) {
        req.log.error({ err: postErr }, "[invoice-pay] Gagal kirim WA — pembayaran tetap sukses");
      }
    })();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status) {
      res.status(e.status).json({ error: e.message });
    } else {
      req.log.error(err, "Failed to record invoice payment");
      res.status(500).json({ error: "Gagal memproses pembayaran invoice" });
    }
  }
});

// ─── DELETE /api/tenant-invoices/:id ─────────────────────────────────────────
router.delete("/tenant-invoices/:id", requireAnyRole("owner", "admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  try {
    const [existing] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, id));

    if (!existing) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }

    if (existing.status === "paid") {
      res.status(409).json({ error: "Invoice yang sudah lunas tidak dapat dihapus" });
      return;
    }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "Invoice yang dibatalkan dipertahankan sebagai histori audit dan tidak dapat dihapus" });
      return;
    }

    const relatedPayments = await db
      .select()
      .from(tenantPaymentsTable)
      .where(eq(tenantPaymentsTable.invoiceId, id));

    if (relatedPayments.length > 0) {
      res.status(409).json({ error: "Invoice yang sudah memiliki pembayaran tidak dapat dihapus" });
      return;
    }

    await db.delete(tenantInvoicesTable).where(eq(tenantInvoicesTable.id, id));

    logAudit(req, {
      action: "delete_invoice",
      entityType: "invoice",
      entityId: id,
      beforeData: existing,
    });

    res.json({ success: true, message: "Invoice berhasil dihapus" });
  } catch (err) {
    req.log.error(err, "Failed to delete invoice");
    res.status(500).json({ error: "Gagal menghapus invoice" });
  }
});

// ─── GET /api/tenant-invoices/export ────────────────────────────────────────
router.get("/tenant-invoices/export", async (req, res) => {
  try {
    const { from, to, tenant_id, status, unit_code } = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (req.siteId > 0) conditions.push(eq(tenantInvoicesTable.siteId, req.siteId));
    if (tenant_id) conditions.push(eq(tenantInvoicesTable.tenantId, Number(tenant_id)));
    if (status) conditions.push(eq(tenantInvoicesTable.status, status));
    if (unit_code) conditions.push(ilike(tenantInvoicesTable.unitCode, `%${unit_code}%`));
    if (from) conditions.push(sql`${tenantInvoicesTable.createdAt} >= ${new Date(from).toISOString()}`);
    if (to)   conditions.push(sql`${tenantInvoicesTable.createdAt} <  ${new Date(new Date(to).getTime() + 86400000).toISOString()}`);

    const rows = await db
      .select({
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        tenantName: tenantsTable.businessName,
        ownerName: tenantsTable.ownerName,
        unitCode: tenantInvoicesTable.unitCode,
        boothNumber: tenantsTable.boothNumber,
        periodStart: tenantInvoicesTable.periodStart,
        periodEnd: tenantInvoicesTable.periodEnd,
        dueDate: tenantInvoicesTable.dueDate,
        rentAmount: tenantInvoicesTable.rentAmount,
        serviceChargeAmount: tenantInvoicesTable.serviceChargeAmount,
        electricityChargeAmount: tenantInvoicesTable.electricityChargeAmount,
        waterChargeAmount: tenantInvoicesTable.waterChargeAmount,
        otherChargeAmount: tenantInvoicesTable.otherChargeAmount,
        trashChargeAmount: tenantInvoicesTable.trashChargeAmount,
        discountAmount: tenantInvoicesTable.discountAmount,
        penaltyAmount: tenantInvoicesTable.penaltyAmount,
        usePpn: tenantInvoicesTable.usePpn,
        subtotal: tenantInvoicesTable.subtotal,
        taxAmount: tenantInvoicesTable.taxAmount,
        totalAmount: tenantInvoicesTable.totalAmount,
        paidAmount: tenantInvoicesTable.paidAmount,
        outstandingAmount: tenantInvoicesTable.outstandingAmount,
        status: tenantInvoicesTable.status,
        notes: tenantInvoicesTable.notes,
        createdAt: tenantInvoicesTable.createdAt,
      })
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(tenantInvoicesTable.createdAt);

    const STATUS_ID: Record<string, string> = {
      draft: "Draft", unpaid: "Belum Bayar", partial: "Sebagian",
      paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan",
    };
    const esc = (v: string | number | null | undefined) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString("id-ID") : "";

    const headers = [
      "No. Invoice", "Tenant", "Pemilik", "Booth", "Kode Unit",
      "Periode Mulai", "Periode Selesai", "Jatuh Tempo",
      "Sewa (Rp)", "Service Charge (Rp)", "Listrik (Rp)", "Air (Rp)", "Lainnya (Rp)", "Sampah (Rp)",
      "Diskon (Rp)", "Gunakan PPN", "PPN 11% (Rp)",
      "Subtotal (Rp)", "Total (Rp)", "Terbayar (Rp)", "Sisa (Rp)",
      "Status", "Catatan", "Dibuat",
    ];

    const lines = [
      "\uFEFF" + headers.join(","),
      ...rows.map((r) => [
        esc(r.invoiceNumber),
        esc(r.tenantName),
        esc(r.ownerName),
        esc(r.boothNumber),
        esc(r.unitCode),
        esc(fmtDate(r.periodStart)),
        esc(fmtDate(r.periodEnd)),
        esc(fmtDate(r.dueDate)),
        Number(r.rentAmount ?? 0),
        Number(r.serviceChargeAmount ?? 0),
        Number(r.electricityChargeAmount ?? 0),
        Number(r.waterChargeAmount ?? 0),
        Number(r.otherChargeAmount ?? 0),
        Number(r.trashChargeAmount ?? 0),
        Number(r.discountAmount ?? 0),
        r.usePpn ? "Ya" : "Tidak",
        Number(r.taxAmount ?? 0),
        Number(r.subtotal ?? 0),
        Number(r.totalAmount ?? 0),
        Number(r.paidAmount ?? 0),
        r.status === "cancelled" ? 0 : Number(r.outstandingAmount ?? 0),
        esc(STATUS_ID[r.status] ?? r.status),
        esc(r.notes),
        esc(fmtDate(r.createdAt?.toISOString())),
      ].join(",")),
    ];

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-tenant-${stamp}.csv"`);
    res.send(lines.join("\r\n"));
  } catch (err) {
    req.log.error(err, "Failed to export invoices");
    res.status(500).json({ error: "Gagal mengekspor data invoice" });
  }
});

// ─── POST /api/tenant-invoices/:id/send-pdf ──────────────────────────────────
router.post("/tenant-invoices/:id/send-pdf", uploadPdfMemory.single("pdf"), async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID tidak valid" }); return; }
  if (!req.file) { res.status(400).json({ error: "File PDF wajib disertakan" }); return; }

  try {
    const [invoice] = await db
      .select({
        id: tenantInvoicesTable.id,
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        tenantId: tenantInvoicesTable.tenantId,
        siteId: tenantInvoicesTable.siteId,
        totalAmount: tenantInvoicesTable.totalAmount,
        status: tenantInvoicesTable.status,
        dueDate: tenantInvoicesTable.dueDate,
        ownerName: tenantsTable.ownerName,
        businessName: tenantsTable.businessName,
        phone: tenantsTable.phone,
      })
      .from(tenantInvoicesTable)
      .innerJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, id));

    if (!invoice) { res.status(404).json({ error: "Invoice tidak ditemukan" }); return; }
    if (invoice.status === "cancelled") {
      res.status(409).json({ error: "Invoice yang dibatalkan tidak dapat dikirim sebagai tagihan" });
      return;
    }
    if (!invoice.phone) { res.status(400).json({ error: "Nomor HP tenant tidak terdaftar" }); return; }

    const filename = `invoice-${invoice.invoiceNumber}-${Date.now()}.pdf`;
    const publicUrl = await uploadToStorage("invoice-pdfs", filename, req.file.buffer, "application/pdf", true);

    const companyName = await getSiteCompanyName(invoice.siteId ?? req.siteId);
    const totalStr = "Rp " + Number(invoice.totalAmount).toLocaleString("id-ID");
    const dueStr = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })
      : "-";

    const message = [
      `📄 *Invoice ${invoice.invoiceNumber}*`,
      ``,
      `Yth. ${invoice.ownerName ?? invoice.businessName},`,
      ``,
      `Berikut kami kirimkan invoice tagihan sewa untuk *${invoice.businessName}*.`,
      ``,
      `📅 Jatuh Tempo: ${dueStr}`,
      `💰 Total Tagihan: *${totalStr}*`,
      ``,
      `Silakan buka file PDF terlampir untuk detail lengkap invoice.`,
      ``,
      `Hormat kami,`,
      companyName,
    ].join("\n");

    const result = await sendWaWithFile(invoice.phone, message, publicUrl);

    if (result.skipped) {
      res.json({ ok: true, skipped: true, pdfUrl: publicUrl, message: "FONNTE_TOKEN / FONNTE_API_KEY belum dikonfigurasi. PDF berhasil diupload namun WA tidak terkirim." });
      return;
    }
    if (!result.ok) {
      res.json({ ok: false, error: result.error ?? "Gagal kirim WA", pdfUrl: publicUrl });
      return;
    }

    res.json({ ok: true, message: `Invoice PDF berhasil dikirim ke WhatsApp ${invoice.phone}`, pdfUrl: publicUrl });
  } catch (err) {
    req.log.error(err, "[send-pdf] Gagal kirim invoice PDF");
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

export default router;