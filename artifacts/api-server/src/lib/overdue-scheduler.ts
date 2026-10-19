import { db } from "@workspace/db";
import { tenantInvoicesTable, tenantsTable, bankMutationsTable, waLogsTable } from "@workspace/db/schema";
import { and, inArray, isNull, eq, sql } from "drizzle-orm";
import { createAllInvoicesForBooking, countContractBillingPeriods } from "./auto-invoice";
import { sendInvoiceNotification, sendOverdueReminder, sendDueReminder, getAdminNotifyPhones, getSiteCompanyName, notifyAdminGroup } from "./whatsapp";
import { logger } from "./logger";
import { getBaseUrl } from "./app-url";
import { getBackgroundWorkMode, type BackgroundWorkMode } from "./background-work-policy";

let _started = false;

// Jam eksekusi scheduler (dalam WIB = UTC+7, diperhitungkan sbg UTC)
// Eksekusi rutin sekali sehari pukul 08:00 WIB (01:00 UTC).
const SCHEDULE_HOURS_UTC = [1];

let _lastRunDateKey = ""; // format: "YYYY-MM-DD-HH"

// ─── Status tracker (diakses oleh route /blast-tagihan/status) ────────────────

export interface BlastRun {
  runAt: string;
  label: string;
  invoicesCreated: number;
  invoicesSent: number;
  reminderH7: number;
  reminderH3: number;
  reminderH1: number;
  overdueSent: number;
}

export interface BlastStatus {
  backgroundMode: BackgroundWorkMode;
  lastRunAt: string | null;
  lastRunLabel: string | null;
  lastResult: {
    invoicesCreated: number;
    invoiceSent: number;
    reminderH7: number;
    reminderH3: number;
    reminderH1: number;
    overdueSent: number;
  } | null;
  nextScheduledHoursUtc: number[];
  isRunning: boolean;
}

let _blastStatus: Omit<BlastStatus, "backgroundMode"> = {
  lastRunAt: null,
  lastRunLabel: null,
  lastResult: null,
  nextScheduledHoursUtc: SCHEDULE_HOURS_UTC,
  isRunning: false,
};

let _blastHistory: BlastRun[] = [];

export function getBlastStatus(): BlastStatus {
  const backgroundMode = getBackgroundWorkMode();
  return {
    ..._blastStatus,
    backgroundMode,
    nextScheduledHoursUtc: backgroundMode === "scheduled" ? [...SCHEDULE_HOURS_UTC] : [],
  };
}

export function getBlastHistory(): BlastRun[] {
  return [..._blastHistory];
}

async function recordSchedulerWa(params: {
  siteId?: number | null;
  tenantId?: number | null;
  invoiceId?: number | null;
  phone: string;
  messageType: "invoice_scheduler" | "due_reminder" | "overdue_reminder";
  status: "accepted" | "queued" | "failed" | "skipped";
  errorMessage?: string | null;
}): Promise<void> {
  try {
    await db.insert(waLogsTable).values({
      siteId: params.siteId ?? null,
      tenantId: params.tenantId ?? null,
      invoiceId: params.invoiceId ?? null,
      phone: params.phone,
      messageType: params.messageType,
      status: params.status,
      errorMessage: params.errorMessage ?? null,
      sentBy: "scheduler",
    });
  } catch (err) {
    // Logging delivery tidak boleh menggagalkan notifikasi utama.
    logger.warn({ err, invoiceId: params.invoiceId }, "[scheduler] Gagal menyimpan WA delivery log");
  }
}

async function releaseInvoiceNotificationClaim(invoiceId: number, claimedAt: Date): Promise<void> {
  await db
    .update(tenantInvoicesTable)
    .set({ invoiceNotifiedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(tenantInvoicesTable.id, invoiceId),
        eq(tenantInvoicesTable.invoiceNotifiedAt, claimedAt),
      ),
    );
}

async function releasePaymentReminderClaim(invoiceId: number, claimedAt: Date): Promise<void> {
  await db
    .update(tenantInvoicesTable)
    .set({ lastPaymentReminderAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(tenantInvoicesTable.id, invoiceId),
        eq(tenantInvoicesTable.lastPaymentReminderAt, claimedAt),
      ),
    );
}

async function releaseOverdueReminderClaim(invoiceId: number, claimedAt: Date): Promise<void> {
  await db
    .update(tenantInvoicesTable)
    .set({ lastOverdueReminderAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(tenantInvoicesTable.id, invoiceId),
        eq(tenantInvoicesTable.lastOverdueReminderAt, claimedAt),
      ),
    );
}

async function runAllChecks(label: string, includeOverdue = true): Promise<void> {
  if (_blastStatus.isRunning) {
    logger.info("[scheduler] Pengecekan sedang berjalan, dilewati");
    return;
  }
  _blastStatus.isRunning = true;
  const runAt = new Date().toISOString();
  logger.info(`[scheduler] Menjalankan semua pengecekan (${label})...`);
  try {
    // 1. Buat invoice bulanan terlebih dahulu (idempotent)
    const invoicesCreated = await runMonthlyInvoiceGeneration().catch((err) => {
      logger.warn({ err }, "[scheduler] Pembuatan invoice bulanan gagal");
      return 0;
    });

    // 2. Kirim notifikasi WA secara paralel
    const [invoicesSent, dueResult, overdueSent] = await Promise.all([
      runInvoiceNotificationCheck().catch((err) => {
        logger.warn({ err }, "[scheduler] Cek kirim tagihan gagal");
        return 0;
      }),
      runMonthlyDailyReminderCheck().catch((err) => {
        logger.warn({ err }, "[scheduler] Cek pengingat harian gagal");
        return { h7: 0, h3: 0, h1: 0 };
      }),
      includeOverdue
        ? runOverdueCheck().catch((err) => {
            logger.warn({ err }, "[scheduler] Cek overdue gagal");
            return 0;
          })
        : Promise.resolve(0),
    ]);


    const result = {
      invoicesCreated,
      invoiceSent: invoicesSent,
      reminderH7: dueResult.h7,
      reminderH3: dueResult.h3,
      reminderH1: dueResult.h1,
      overdueSent,
    };

    _blastStatus.lastRunAt = runAt;
    _blastStatus.lastRunLabel = label;
    _blastStatus.lastResult = result;

    // Simpan ke history (maks 20 entri)
    _blastHistory.unshift({
      runAt,
      label,
      invoicesCreated,
      invoicesSent,
      reminderH7: dueResult.h7,
      reminderH3: dueResult.h3,
      reminderH1: dueResult.h1,
      overdueSent,
    });
    if (_blastHistory.length > 20) _blastHistory.pop();
  } finally {
    _blastStatus.isRunning = false;
  }
}

/**
 * Trigger blast tagihan manual (dari API endpoint).
 * Menjalankan runInvoiceNotificationCheck + runDueReminderCheck + runOverdueCheck.
 */
export async function runManualBlast(label: string): Promise<void> {
  await runAllChecks(label);
}

export function startOverdueScheduler(): void {
  if (_started) return;
  if (getBackgroundWorkMode() === "on-demand") {
    logger.info("[scheduler] Mode on-demand aktif — menunggu permintaan blast terautentikasi");
    return;
  }
  _started = true;

  // Startup catch-up: jika service baru hidup setelah jadwal 08:00 WIB,
  // jalankan pengecekan harian sekali pada hari yang sama. Seluruh jalur WA
  // memakai claim/idempotency di database, sehingga invoice/reminder yang
  // sudah diproses hari ini tidak akan terkirim dua kali.
  setTimeout(async () => {
    try {
      const now = new Date();
      const wibMs = 7 * 60 * 60 * 1000;
      const nowWib = new Date(now.getTime() + wibMs);
      const hourWib = nowWib.getUTCHours();
      if (hourWib >= 8) {
        logger.info(
          { hourWib },
          "[scheduler] Startup setelah jadwal 08:00 WIB — menjalankan catch-up harian...",
        );
        await runAllChecks("startup catch-up after 08:00 WIB", true);
      } else {
        logger.info(
          { hourWib },
          "[scheduler] Startup sebelum 08:00 WIB — invoice generation only",
        );
        const created = await runMonthlyInvoiceGeneration();
        logger.info({ created }, "[scheduler] Startup invoice generation selesai");
      }
    } catch (err) {
      logger.warn({ err }, "[scheduler] Startup catch-up gagal");
    }
  }, 30_000);

  // Cron sederhana: cek setiap 5 menit, eksekusi jika jam-nya tepat.
  // Satu window terjadwal: 01 UTC = 08:00 WIB.
  setInterval(async () => {
    const now = new Date();
    const hourUtc = now.getUTCHours();
    const dateKey = `${now.toISOString().slice(0, 10)}-${hourUtc}`;

    const isRegularWindow = SCHEDULE_HOURS_UTC.includes(hourUtc);

    // Eksekusi hanya pada window rutin 08:00 WIB dan belum dijalankan pada jam ini.
    // Date key diklaim sebelum await supaya dua tick dalam window yang sama
    // tidak bisa memulai blast kedua saat blast pertama masih berjalan.
    if (isRegularWindow && dateKey !== _lastRunDateKey) {
      _lastRunDateKey = dateKey;
      try {
        const label = `cron ${hourUtc}:00 UTC`;
        await runAllChecks(label, true);
      } catch (err) {
        logger.warn({ err }, "[scheduler] Cron blast gagal");
      }
    }
  }, 5 * 60 * 1000); // setiap 5 menit

  logger.info(
    "[scheduler] Scheduler aktif — cron harian 08:00 WIB (01 UTC). " +
    "Invoice, reminder, dan overdue ditargetkan pukul 08:00 WIB; restart setelah 08:00 menjalankan catch-up harian yang idempotent.",
  );
}

// getAdminPhones → pakai getAdminNotifyPhones() dari whatsapp.ts (sudah handle ADMIN_WA_GROUP)

// ─── Helper: bangun payment link ─────────────────────────────────────────────

async function buildPaymentLink(token: string | null | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  const base = await getBaseUrl();
  return base ? `${base}/bayar/${token}` : undefined;
}

// ─── Helper: format label periode ────────────────────────────────────────────

function formatPeriodLabel(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): string {
  if (!periodStart && !periodEnd) return "-";
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  if (periodStart && periodEnd) return `${fmt(periodStart)} – ${fmt(periodEnd)}`;
  return fmt((periodStart ?? periodEnd)!);
}

// ─── Pembuatan invoice bulanan otomatis ──────────────────────────────────────

/**
 * Buat invoice bulanan untuk semua booking aktif yang belum punya invoice bulan ini.
 * Fungsi ini idempotent — aman dipanggil setiap hari karena createAllInvoicesForBooking
 * menggunakan ON CONFLICT DO NOTHING (tidak duplikat invoice yang sudah ada).
 * @returns Jumlah invoice baru yang berhasil dibuat.
 */
async function runMonthlyInvoiceGeneration(): Promise<number> {
  logger.info("[scheduler] Menjalankan pembuatan invoice bulanan otomatis...");

  const result = await db.execute(sql`
    SELECT
      b.id,
      b.site_id,
      b.tenant_id,
      b.unit_code,
      b.start_date,
      b.end_date,
      b.duration_months,
      b.rent_amount
    FROM tenant_bookings b
    WHERE
      b.booking_status IN ('aktif', 'active')
      AND b.contract_status NOT IN ('expired', 'terminated')
      AND COALESCE(b.rent_amount::numeric, 0) > 0
      AND (b.start_date IS NULL OR b.start_date::date <= CURRENT_DATE)
      AND (
        b.end_date IS NULL
        OR b.end_date::date >= DATE_TRUNC('month', CURRENT_DATE)::date
      )
  `);

  const rows = (result as unknown as {
    rows: Array<{
      id: number;
      site_id: number;
      tenant_id: number;
      unit_code: string | null;
      start_date: string | null;
      end_date: string | null;
      duration_months: number | null;
      rent_amount: string | null;
    }>;
  }).rows;

  logger.info({ count: rows.length }, "[scheduler] Booking aktif ditemukan untuk pembuatan invoice");

  let totalCreated = 0;

  for (const b of rows) {
    if (!b.start_date) continue;

    const endDatePeriods = b.end_date
      ? countContractBillingPeriods(b.start_date, b.end_date)
      : null;
    let durationMonths = Number(b.duration_months ?? 0);
    if (durationMonths > 0 && endDatePeriods) {
      durationMonths = Math.min(durationMonths, endDatePeriods);
    } else if (!durationMonths && endDatePeriods) {
      durationMonths = endDatePeriods;
    }
    if (durationMonths <= 0) continue;

    const rentAmount = Number(b.rent_amount ?? 0);
    if (rentAmount <= 0) continue;

    try {
      const ids = await createAllInvoicesForBooking({
        bookingId: b.id,
        siteId: b.site_id,
        tenantId: b.tenant_id,
        unitCode: b.unit_code ?? null,
        rentAmount,
        startDate: b.start_date,
        endDate: b.end_date,
        durationMonths,
      });
      totalCreated += ids.length;
    } catch (err) {
      logger.warn({ err, bookingId: b.id }, "[scheduler] Gagal buat invoice untuk booking");
    }
  }

  logger.info(
    { bookings: rows.length, newInvoices: totalCreated },
    "[scheduler] Pembuatan invoice bulanan selesai",
  );

  return totalCreated;
}

// ─── Kirim tagihan di awal periode sewa ──────────────────────────────────────

/**
 * Kirim WA tagihan baru ke tenant di awal setiap periode sewa.
 * Invoice yang period_start-nya hari ini atau sudah lewat (maks 3 hari lalu)
 * dan belum pernah dikirimkan notifikasinya (invoice_notified_at IS NULL)
 * akan dikirim sekarang.
 */
export async function runInvoiceNotificationCheck(): Promise<number> {
  logger.info("[scheduler] Menjalankan cek kirim tagihan awal periode...");

  const invoices = await db
    .select({
      id: tenantInvoicesTable.id,
      invoiceNumber: tenantInvoicesTable.invoiceNumber,
      siteId: tenantInvoicesTable.siteId,
      tenantId: tenantInvoicesTable.tenantId,
      periodStart: tenantInvoicesTable.periodStart,
      periodEnd: tenantInvoicesTable.periodEnd,
      dueDate: tenantInvoicesTable.dueDate,
      totalAmount: tenantInvoicesTable.totalAmount,
      paymentToken: tenantInvoicesTable.paymentToken,
      ownerName: tenantsTable.ownerName,
      businessName: tenantsTable.businessName,
      phone: tenantsTable.phone,
    })
    .from(tenantInvoicesTable)
    .innerJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
    .where(
      and(
        sql`${tenantsTable.status} IN ('aktif', 'active')`,
        inArray(tenantInvoicesTable.status, ["unpaid", "partial"]),
        isNull(tenantInvoicesTable.invoiceNotifiedAt),
        // Kirim semua invoice yang periodenya sudah mulai (sudah atau hari ini)
        // Batas BAWAH dihapus agar invoice lama yang terlewat tetap terkirim.
        // Idempotency dijaga oleh invoice_notified_at IS NULL (tidak dobel kirim).
        sql`"period_start" <= CURRENT_DATE`,
      ),
    );

  logger.info({ count: invoices.length }, "[scheduler] Invoice baru perlu dikirim ke tenant");

  let sent = 0;

  for (const invoice of invoices) {
    const now = new Date();

    // Atomic claim: UPDATE hanya jika invoiceNotifiedAt masih NULL.
    // Jika proses lain sudah claim (multi-instance atau restart bersamaan),
    // RETURNING akan kosong dan kita skip — mencegah WA dobel.
    const claimed = await db
      .update(tenantInvoicesTable)
      .set({ invoiceNotifiedAt: now, updatedAt: now })
      .where(and(
        eq(tenantInvoicesTable.id, invoice.id),
        isNull(tenantInvoicesTable.invoiceNotifiedAt),
        sql`EXISTS (
          SELECT 1 FROM tenants AS active_tenant
          WHERE active_tenant.id = ${tenantInvoicesTable.tenantId}
            AND active_tenant.status IN ('aktif', 'active')
        )`,
      ))
      .returning({ id: tenantInvoicesTable.id });

    if (claimed.length === 0) {
      logger.info({ invoiceId: invoice.id }, "[scheduler] Invoice sudah di-claim proses lain, dilewati");
      continue;
    }

    if (!invoice.phone) {
      // Tidak ada tujuan pengiriman. Lepaskan claim supaya invoice dapat
      // diproses setelah nomor tenant dilengkapi.
      await releaseInvoiceNotificationClaim(invoice.id, now);
      logger.warn({ invoiceId: invoice.id }, "[scheduler] Invoice tidak punya nomor WA tenant");
      continue;
    }

    const dueStr = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString("id-ID", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "-";

    const companyName = await getSiteCompanyName(invoice.siteId);
    const paymentLink = await buildPaymentLink(invoice.paymentToken);

    try {
      const result = await sendInvoiceNotification({
        ownerName: invoice.ownerName,
        businessName: invoice.businessName,
        invoiceNumber: invoice.invoiceNumber,
        periodLabel: formatPeriodLabel(invoice.periodStart, invoice.periodEnd),
        totalAmount: invoice.totalAmount,
        dueDate: dueStr,
        phone: invoice.phone,
        paymentLink,
        companyName,
      });

      if (result.ok && !result.skipped) {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "invoice_scheduler",
          status: result.pending ? "queued" : "accepted",
          errorMessage: result.pending ? "CST WA Gateway queued" : null,
        });

        // CST WA Gateway process=pending berarti request sudah diterima provider dan
        // masuk antrean. Anggap sebagai queued delivery: pertahankan claim agar
        // scheduler tidak membanjiri nomor yang sama setiap restart/manual blast.
        // Admin group tetap harus menerima event pada percobaan yang sama.
        if (result.pending) {
          logger.warn(
            { invoiceId: invoice.id },
            "[scheduler] Invoice diterima CST WA Gateway sebagai queued/pending — claim dipertahankan",
          );
        }

        sent++;
        await notifyAdminGroup({
          eventType: "invoice_sent",
          businessName: invoice.businessName,
          ownerName: invoice.ownerName,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.totalAmount,
          periodLabel: formatPeriodLabel(invoice.periodStart, invoice.periodEnd),
          dueDate: dueStr,
          siteName: companyName,
          paymentLink,
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
        }).catch((err) =>
          logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Notifikasi group admin gagal"),
        );
      } else {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "invoice_scheduler",
          status: result.skipped ? "skipped" : "failed",
          errorMessage: result.error ?? null,
        });
        await releaseInvoiceNotificationClaim(invoice.id, now);
        logger.warn(
          { invoiceId: invoice.id, skipped: result.skipped, error: result.error },
          "[scheduler] Pengiriman invoice gagal/dilewati — akan dicoba lagi",
        );
      }
    } catch (err) {
      await recordSchedulerWa({
        siteId: invoice.siteId,
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        phone: invoice.phone,
        messageType: "invoice_scheduler",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await releaseInvoiceNotificationClaim(invoice.id, now).catch(() => {});
      logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Pengiriman invoice error — akan dicoba lagi");
    }
  }

  logger.info({ sent, total: invoices.length }, "[scheduler] Pengiriman tagihan awal periode selesai");
  return sent;
}

// ─── Reminder harian periode aktif sampai jatuh tempo ─────────────────────────

/**
 * Kirim WA reminder setiap hari pukul 08:00 WIB sejak periode invoice mulai
 * sampai tanggal jatuh tempo, selama invoice masih unpaid/partial.
 *
 * Hari pertama periode ditangani oleh runInvoiceNotificationCheck() agar tenant
 * menerima tagihan awal, bukan dua pesan pada hari yang sama. Mulai hari
 * berikutnya reminder dikirim sekali per hari. Setelah melewati jatuh tempo,
 * pengiriman harian ditangani eksklusif oleh runOverdueCheck().
 */
export async function runMonthlyDailyReminderCheck(): Promise<{ h7: number; h3: number; h1: number }> {
  const nowUtc = new Date();
  const wibMs = 7 * 60 * 60 * 1000;
  const nowWib = new Date(nowUtc.getTime() + wibMs);
  const yearWib = nowWib.getUTCFullYear();
  const monthWib = nowWib.getUTCMonth();
  const dayWib = nowWib.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayWibStr = `${yearWib}-${pad(monthWib + 1)}-${pad(dayWib)}`;

  logger.info({ todayWibStr }, "[scheduler] Menjalankan reminder harian periode aktif...");

  const invoices = await db
    .select({
      id: tenantInvoicesTable.id,
      invoiceNumber: tenantInvoicesTable.invoiceNumber,
      siteId: tenantInvoicesTable.siteId,
      tenantId: tenantInvoicesTable.tenantId,
      dueDate: tenantInvoicesTable.dueDate,
      periodStart: tenantInvoicesTable.periodStart,
      periodEnd: tenantInvoicesTable.periodEnd,
      totalAmount: tenantInvoicesTable.totalAmount,
      outstandingAmount: tenantInvoicesTable.outstandingAmount,
      paymentToken: tenantInvoicesTable.paymentToken,
      ownerName: tenantsTable.ownerName,
      businessName: tenantsTable.businessName,
      phone: tenantsTable.phone,
    })
    .from(tenantInvoicesTable)
    .innerJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
    .where(
      and(
        sql`${tenantsTable.status} IN ('aktif', 'active')`,
        inArray(tenantInvoicesTable.status, ["unpaid", "partial"]),
        sql`${tenantInvoicesTable.periodStart}::date <= ${todayWibStr}::date`,
        sql`${tenantInvoicesTable.dueDate} IS NOT NULL`,
        sql`${tenantInvoicesTable.dueDate}::date >= ${todayWibStr}::date`,
        sql`${tenantInvoicesTable.invoiceNotifiedAt} IS NOT NULL`,
        sql`DATE(${tenantInvoicesTable.invoiceNotifiedAt} AT TIME ZONE 'Asia/Jakarta') < ${todayWibStr}::date`,
        sql`COALESCE(${tenantInvoicesTable.outstandingAmount}, 0)::numeric > 0`,
        sql`(
          last_payment_reminder_at IS NULL
          OR DATE(last_payment_reminder_at AT TIME ZONE 'Asia/Jakarta') < ${todayWibStr}::date
        )`,
      ),
    );

  logger.info({ count: invoices.length }, "[scheduler] Invoice perlu reminder harian");

  const counts = { h7: 0, h3: 0, h1: 0 };

  for (const invoice of invoices) {
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate + "T00:00:00Z") : null;
    if (!dueDate) continue;

    const todayDate = new Date(todayWibStr + "T00:00:00Z");
    const daysUntilDue = Math.round((dueDate.getTime() - todayDate.getTime()) / 86400000);
    if (daysUntilDue < 0) continue;

    const claimedAt = new Date();
    const claimed = await db
      .update(tenantInvoicesTable)
      .set({ lastPaymentReminderAt: claimedAt, updatedAt: claimedAt })
      .where(
        and(
          eq(tenantInvoicesTable.id, invoice.id),
          sql`EXISTS (
            SELECT 1 FROM tenants AS active_tenant
            WHERE active_tenant.id = ${tenantInvoicesTable.tenantId}
              AND active_tenant.status IN ('aktif', 'active')
          )`,
          inArray(tenantInvoicesTable.status, ["unpaid", "partial"]),
          sql`${tenantInvoicesTable.periodStart}::date <= ${todayWibStr}::date`,
          sql`${tenantInvoicesTable.dueDate}::date >= ${todayWibStr}::date`,
          sql`${tenantInvoicesTable.invoiceNotifiedAt} IS NOT NULL`,
          sql`DATE(${tenantInvoicesTable.invoiceNotifiedAt} AT TIME ZONE 'Asia/Jakarta') < ${todayWibStr}::date`,
          sql`COALESCE(${tenantInvoicesTable.outstandingAmount}, 0)::numeric > 0`,
          sql`(
            last_payment_reminder_at IS NULL
            OR DATE(last_payment_reminder_at AT TIME ZONE 'Asia/Jakarta') < ${todayWibStr}::date
          )`,
        ),
      )
      .returning({ id: tenantInvoicesTable.id });

    if (claimed.length === 0) continue;

    if (!invoice.phone) {
      await releasePaymentReminderClaim(invoice.id, claimedAt);
      logger.warn({ invoiceId: invoice.id }, "[scheduler] Reminder tidak punya nomor WA tenant");
      continue;
    }

    const dueStr = dueDate.toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const companyName = await getSiteCompanyName(invoice.siteId ?? 0);
    const paymentLink = await buildPaymentLink(invoice.paymentToken);

    try {
      const result = await sendDueReminder({
        ownerName: invoice.ownerName,
        businessName: invoice.businessName,
        invoiceNumber: invoice.invoiceNumber,
        periodLabel: formatPeriodLabel(invoice.periodStart, invoice.periodEnd),
        totalAmount: invoice.totalAmount,
        outstandingAmount: invoice.outstandingAmount,
        dueDate: dueStr,
        daysUntilDue,
        phone: invoice.phone,
        paymentLink,
      });

      if (result.ok && !result.skipped) {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "due_reminder",
          status: result.pending ? "queued" : "accepted",
          errorMessage: result.pending ? "CST WA Gateway queued" : null,
        });

        if (result.pending) {
          logger.warn(
            { invoiceId: invoice.id, daysUntilDue },
            "[scheduler] Due reminder diterima CST WA Gateway sebagai queued/pending — claim dipertahankan",
          );
        }

        if (daysUntilDue === 7) counts.h7++;
        if (daysUntilDue === 3) counts.h3++;
        if (daysUntilDue === 1) counts.h1++;

        await notifyAdminGroup({
          eventType: "reminder",
          businessName: invoice.businessName,
          ownerName: invoice.ownerName,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.outstandingAmount ?? invoice.totalAmount,
          daysUntilDue,
          dueDate: dueStr,
          siteName: companyName,
          paymentLink,
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
        }).catch((err) =>
          logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Notifikasi group admin gagal"),
        );
      } else {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "due_reminder",
          status: result.skipped ? "skipped" : "failed",
          errorMessage: result.error ?? null,
        });
        await releasePaymentReminderClaim(invoice.id, claimedAt);
        logger.warn(
          { invoiceId: invoice.id, skipped: result.skipped, error: result.error },
          "[scheduler] Reminder jatuh tempo gagal/dilewati — akan dicoba lagi",
        );
      }
    } catch (err) {
      await recordSchedulerWa({
        siteId: invoice.siteId,
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        phone: invoice.phone,
        messageType: "due_reminder",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await releasePaymentReminderClaim(invoice.id, claimedAt).catch(() => {});
      logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Pengiriman reminder jatuh tempo error");
    }
  }

  logger.info({ ...counts }, "[scheduler] Reminder harian periode aktif selesai");
  return counts;
}

// ─── Overdue Reminder (sudah melewati jatuh tempo) ───────────────────────────

export async function runOverdueCheck(): Promise<number> {
  logger.info("[scheduler] Menjalankan cek invoice jatuh tempo...");

  const overdueInvoices = await db
    .select({
      id: tenantInvoicesTable.id,
      invoiceNumber: tenantInvoicesTable.invoiceNumber,
      siteId: tenantInvoicesTable.siteId,
      tenantId: tenantInvoicesTable.tenantId,
      dueDate: tenantInvoicesTable.dueDate,
      totalAmount: tenantInvoicesTable.totalAmount,
      outstandingAmount: tenantInvoicesTable.outstandingAmount,
      paymentToken: tenantInvoicesTable.paymentToken,
      ownerName: tenantsTable.ownerName,
      businessName: tenantsTable.businessName,
      phone: tenantsTable.phone,
    })
    .from(tenantInvoicesTable)
    .innerJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
    .where(
      and(
        sql`${tenantsTable.status} IN ('aktif', 'active')`,
        inArray(tenantInvoicesTable.status, ["unpaid", "partial", "overdue"]),
        // Semua invoice yang sudah melewati jatuh tempo diproses, termasuk
        // tunggakan bulan sebelumnya. Kirim maksimal sekali per hari pukul
        // 08:00 WIB sampai invoice lunas.
        sql`${tenantInvoicesTable.periodStart}::date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`,
        sql`"due_date" < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`,
        sql`COALESCE(${tenantInvoicesTable.outstandingAmount}, 0)::numeric > 0`,
        sql`(
          last_overdue_reminder_at IS NULL
          OR DATE(last_overdue_reminder_at AT TIME ZONE 'Asia/Jakarta')
             < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date
        )`,
      ),
    );

  if (overdueInvoices.length === 0) {
    logger.info("[scheduler] Tidak ada invoice baru yang jatuh tempo");
    return 0;
  }

  logger.info(
    { count: overdueInvoices.length },
    "[scheduler] Ditemukan invoice baru jatuh tempo",
  );

  let sent = 0;

  for (const invoice of overdueInvoices) {
    const claimedAt = new Date();
    const claimed = await db
      .update(tenantInvoicesTable)
      .set({
        status: "overdue",
        lastOverdueReminderAt: claimedAt,
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(tenantInvoicesTable.id, invoice.id),
          sql`EXISTS (
            SELECT 1
            FROM tenants AS active_tenant
            WHERE active_tenant.id = ${tenantInvoicesTable.tenantId}
              AND active_tenant.status IN ('aktif', 'active')
          )`,
          inArray(tenantInvoicesTable.status, ["unpaid", "partial", "overdue"]),
            sql`${tenantInvoicesTable.periodStart}::date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`,
          sql`${tenantInvoicesTable.dueDate} < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`,
          sql`COALESCE(${tenantInvoicesTable.outstandingAmount}, 0)::numeric > 0`,
          sql`(
            last_overdue_reminder_at IS NULL
            OR DATE(last_overdue_reminder_at AT TIME ZONE 'Asia/Jakarta')
               < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date
          )`,
        ),
      )
      .returning({ id: tenantInvoicesTable.id });

    if (claimed.length === 0) continue;

    if (!invoice.phone) {
      await releaseOverdueReminderClaim(invoice.id, claimedAt);
      logger.warn({ invoiceId: invoice.id }, "[scheduler] Overdue tidak punya nomor WA tenant");
      continue;
    }

    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
    const daysOverdue = dueDate
      ? Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86400000))
      : 0;
    const paymentLink = await buildPaymentLink(invoice.paymentToken);

    try {
      const result = await sendOverdueReminder({
        ownerName: invoice.ownerName,
        businessName: invoice.businessName,
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: invoice.totalAmount,
        outstandingAmount: invoice.outstandingAmount ?? invoice.totalAmount,
        daysOverdue,
        phone: invoice.phone,
        paymentLink,
      });

      if (result.ok && !result.skipped) {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "overdue_reminder",
          status: result.pending ? "queued" : "accepted",
          errorMessage: result.pending ? "CST WA Gateway queued" : null,
        });

        if (result.pending) {
          logger.warn(
            { invoiceId: invoice.id },
            "[scheduler] Overdue reminder diterima CST WA Gateway sebagai queued/pending — claim dipertahankan",
          );
        }

        sent++;
        await notifyAdminGroup({
          eventType: "overdue",
          ownerName: invoice.ownerName,
          businessName: invoice.businessName,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.outstandingAmount ?? invoice.totalAmount,
          daysOverdue,
          paymentLink,
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
        }).catch((err) =>
          logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Notifikasi group admin gagal"),
        );
      } else {
        await recordSchedulerWa({
          siteId: invoice.siteId,
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          phone: invoice.phone,
          messageType: "overdue_reminder",
          status: result.skipped ? "skipped" : "failed",
          errorMessage: result.error ?? null,
        });
        await releaseOverdueReminderClaim(invoice.id, claimedAt);
        logger.warn(
          { invoiceId: invoice.id, skipped: result.skipped, error: result.error },
          "[scheduler] Pengiriman overdue gagal/dilewati — akan dicoba lagi",
        );
      }
    } catch (err) {
      await recordSchedulerWa({
        siteId: invoice.siteId,
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        phone: invoice.phone,
        messageType: "overdue_reminder",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await releaseOverdueReminderClaim(invoice.id, claimedAt).catch(() => {});
      logger.warn({ err, invoiceId: invoice.id }, "[scheduler] Pengiriman overdue error — akan dicoba lagi");
    }
  }

  logger.info(
    { sent, total: overdueInvoices.length },
    "[scheduler] Pengingat WA overdue selesai",
  );
  return sent;
}
