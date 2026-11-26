/**
 * WhatsApp Notification Service melalui CST WA Gateway.
 *
 * Transport WA dipusatkan di wa.cstlogistic.co.id. Aplikasi hanya memegang
 * client API key dan tidak menerima kredensial sesi WhatsApp/admin gateway.
 */

import { db } from "@workspace/db";
import { usersTable, systemSettingsTable, waLogsTable } from "@workspace/db/schema";
import { sql, and, inArray, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  sendGatewayGroupText,
  sendGatewayMedia,
  sendGatewayText,
} from "./whatsapp-gateway-client";

export function isWhatsappDeliveryDisabled(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_WHATSAPP_SEND === "true"
  );
}

// ─── Helper: ambil company_name dari mall_sites ───────────────────────────────

const _companyNameCache = new Map<number, { name: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function getSiteCompanyName(siteId: number | null | undefined): Promise<string> {
  const DEFAULT = "Manajemen CST";
  if (!siteId || siteId <= 0) return DEFAULT;

  const cached = _companyNameCache.get(siteId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  try {
    const result = await db.execute(sql`SELECT company_name FROM mall_sites WHERE id = ${siteId} LIMIT 1`);
    const rows = (result as { rows: Record<string, unknown>[] }).rows;
    const name = (rows[0]?.company_name as string | undefined) ?? DEFAULT;
    _companyNameCache.set(siteId, { name, expiresAt: Date.now() + CACHE_TTL });
    return name;
  } catch {
    return DEFAULT;
  }
}

/** Hapus cache company_name (dipanggil saat site diupdate) */
export function clearCompanyNameCache(siteId?: number) {
  if (siteId) {
    _companyNameCache.delete(siteId);
  } else {
    _companyNameCache.clear();
  }
}

export interface WaResult {
  ok: boolean;
  skipped?: boolean;
  pending?: boolean;
  response?: unknown;
  error?: string;
}

// Satu pembayaran bisa melewati lebih dari satu jalur post-commit
// (misalnya endpoint POS dan endpoint invoice). Gateway juga menyediakan
// idempotency key; dedupe aplikasi tetap dipertahankan untuk notifikasi grup berdasarkan
// nomor kuitansi/invoice selama proses server masih hidup.
const groupNotificationCache = new Map<
  string,
  { expiresAt: number; promise: Promise<WaResult> }
>();
const GROUP_NOTIFICATION_DEDUPE_MS = 30 * 60 * 1000;

/**
 * Format angka ke Rupiah, contoh: 5500000 → "Rp 5.500.000"
 */
export function formatRupiah(amount: number | string): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  return "Rp " + n.toLocaleString("id-ID");
}

/**
 * Normalisasi nomor HP Indonesia ke format internasional tanpa +
 * 081234567890 → 6281234567890
 * 6281234567890 → 6281234567890
 * Group JID (misal: 12036341119221335@g.us) — tidak dinormalisasi
 */
function normalizePhone(phone: string): string {
  // Group JID dari WhatsApp — langsung pakai as-is
  if (phone.includes("@")) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("62")) return digits;
  return "62" + digits;
}

/**
 * Kirim pesan WA ke satu nomor atau Group JID.
 */
const DEV_PHONES = new Set(["6281111111111","6281111111112","6281111111113","6281111111114"]);

/**
 * Ambil daftar tujuan notifikasi WA admin.
 * Prioritas:
 *   1. ADMIN_WA_GROUP (group JID) — jika diset, kirim HANYA ke group, skip semua lainnya
 *   2. DB user owner/admin/finance aktif yang punya phone_number (filter dev placeholder)
 *      + selalu tambahkan ADMIN_WHATSAPP / ADMIN_WHATSAPP jika ada
 *   3. Fallback ke system_settings.mall_config.adminPhone
 */
export async function getAdminNotifyPhones(): Promise<Array<{ name: string; phone: string }>> {
  const waGroup = process.env.ADMIN_WA_GROUP;
  if (waGroup) return [{ name: "Admin Group", phone: waGroup }];

  try {
    const rows = await db
      .select({ name: usersTable.name, phoneNumber: usersTable.phoneNumber })
      .from(usersTable)
      .where(
        and(
          inArray(usersTable.role, ["owner", "admin", "finance"]),
          eq(usersTable.status, "active"),
          sql`phone_number IS NOT NULL AND phone_number != ''`,
        ),
      );

    const phones: Array<{ name: string; phone: string }> = rows
      .filter((u) => u.phoneNumber && !DEV_PHONES.has(u.phoneNumber))
      .map((u) => ({ name: u.name, phone: u.phoneNumber! }));

    const envPhone = process.env.ADMIN_WHATSAPP ?? process.env.ADMIN_WHATSAPP;
    if (envPhone && !phones.some((p) => normalizePhone(p.phone) === normalizePhone(envPhone))) {
      phones.push({ name: "Admin", phone: envPhone });
    }

    if (phones.length === 0) {
      const [row] = await db
        .select({ value: systemSettingsTable.value })
        .from(systemSettingsTable)
        .where(eq(systemSettingsTable.key, "mall_config"));
      const phone = (row?.value as Record<string, unknown> | undefined)?.adminPhone;
      if (typeof phone === "string" && phone.length > 0) phones.push({ name: "Admin", phone });
    }

    // Data user dan konfigurasi environment bisa menunjuk nomor yang sama.
    // Kirim satu kali per tujuan agar satu pembayaran tidak menjadi beberapa
    // pesan identik ke admin.
    const uniquePhones = new Map<string, { name: string; phone: string }>();
    for (const entry of phones) {
      const key = normalizePhone(entry.phone);
      if (!uniquePhones.has(key)) uniquePhones.set(key, entry);
    }
    return [...uniquePhones.values()];
  } catch {
    const fallback = process.env.ADMIN_WHATSAPP ?? process.env.ADMIN_WHATSAPP ?? process.env.ADMIN_WA_GROUP;
    return fallback ? [{ name: "Admin", phone: fallback }] : [];
  }
}

async function sendMessage(phone: string, message: string): Promise<WaResult> {
  if (isWhatsappDeliveryDisabled()) {
    return { ok: true, skipped: true };
  }

  const result = await sendGatewayText(phone, message);
  return {
    ok: result.ok,
    skipped: result.skipped,
    pending: result.queued,
    response: result.response,
    error: result.error,
  };
}

async function sendGroupMessage(groupJid: string, message: string): Promise<WaResult> {
  if (isWhatsappDeliveryDisabled()) {
    return { ok: true, skipped: true };
  }

  const result = await sendGatewayGroupText(groupJid, message);
  return {
    ok: result.ok,
    skipped: result.skipped,
    pending: result.queued,
    response: result.response,
    error: result.error,
  };
}

/**
 * Kirim WA dengan lampiran file (PDF/gambar/video) melalui CST WA Gateway.
 * fileUrl wajib HTTPS agar media dapat diambil gateway dengan aman.
 */
export async function sendWaWithFile(phone: string, message: string, fileUrl: string): Promise<WaResult> {
  if (isWhatsappDeliveryDisabled()) {
    return { ok: true, skipped: true };
  }

  const result = await sendGatewayMedia(phone, message, fileUrl);
  return {
    ok: result.ok,
    skipped: result.skipped,
    pending: result.queued,
    response: result.response,
    error: result.error,
  };
}

// ─── Template Pesan ──────────────────────────────────────────────────────────

export interface InvoiceNotifParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  periodLabel: string;
  totalAmount: string | number;
  dueDate: string;
  phone: string;
  paymentLink?: string;
  companyName?: string;
}

export interface PaymentConfirmParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  amountPaid: string | number;
  paymentMethod: string;
  phone: string;
  companyName?: string;
}

export interface OverdueReminderParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  totalAmount: string | number;
  outstandingAmount: string | number;
  daysOverdue: number;
  phone: string;
  paymentLink?: string;
  companyName?: string;
}

/**
 * Kirim notifikasi invoice baru ke tenant
 */
export async function sendInvoiceNotification(params: InvoiceNotifParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const linkLine = params.paymentLink
    ? `\n🔗 *Link Pembayaran:*\n${params.paymentLink}\n`
    : "";

  const message =
    `📋 *Tagihan Baru — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Berikut adalah tagihan terbaru yang telah kami terbitkan untuk Anda:\n\n` +
    `• No. Invoice : *${params.invoiceNumber}*\n` +
    `• Periode       : ${params.periodLabel}\n` +
    `• Total Tagihan : *${formatRupiah(params.totalAmount)}*\n` +
    `• Jatuh Tempo  : *${params.dueDate}*\n` +
    linkLine +
    `\nMohon lakukan pembayaran sebelum tanggal jatuh tempo.\n\n` +
    `Hubungi kami jika ada pertanyaan.\n\n` +
    `Terima kasih 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface DueReminderParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  periodLabel: string;
  totalAmount: string | number;
  outstandingAmount?: string | number | null;
  dueDate: string;
  daysUntilDue: number;
  phone: string;
  paymentLink?: string;
  companyName?: string;
}

/**
 * Kirim pengingat jatuh tempo (H-3 / H-1) — bukan tagihan baru.
 * Template ini berbeda dari sendInvoiceNotification agar tidak membingungkan tenant.
 */
export async function sendDueReminder(params: DueReminderParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const dayLabel = params.daysUntilDue === 1 ? "1 hari lagi" : `${params.daysUntilDue} hari lagi`;
  const urgencyEmoji = params.daysUntilDue === 1 ? "🔴" : "🟡";
  const outstanding = params.outstandingAmount ?? params.totalAmount;
  const linkLine = params.paymentLink
    ? `\n🔗 *Link Pembayaran:*\n${params.paymentLink}\n`
    : "";

  const message =
    `${urgencyEmoji} *Pengingat Jatuh Tempo — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Tagihan berikut akan jatuh tempo dalam *${dayLabel}*. Mohon segera lakukan pembayaran.\n\n` +
    `• No. Invoice       : *${params.invoiceNumber}*\n` +
    `• Periode            : ${params.periodLabel}\n` +
    `• Sisa Tagihan      : *${formatRupiah(outstanding)}*\n` +
    `• Jatuh Tempo       : *${params.dueDate}*\n` +
    linkLine +
    `\nPembayaran tepat waktu sangat membantu kelancaran operasional Anda.\n\n` +
    `Hubungi kami jika ada pertanyaan. Terima kasih 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

/**
 * Kirim konfirmasi pembayaran ke tenant
 */
export async function sendPaymentConfirmation(params: PaymentConfirmParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const methodLabel: Record<string, string> = {
    transfer: "Transfer Bank",
    tunai: "Tunai / Cash",
    qris: "QRIS",
    edc: "EDC / Debit",
    other: "Lainnya",
  };

  const message =
    `✅ *Pembayaran Diterima — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Pembayaran Anda telah kami terima dengan rincian sebagai berikut:\n\n` +
    `• No. Invoice : *${params.invoiceNumber}*\n` +
    `• Jumlah         : *${formatRupiah(params.amountPaid)}*\n` +
    `• Metode         : ${methodLabel[params.paymentMethod] ?? params.paymentMethod}\n\n` +
    `Terima kasih atas pembayaran Anda yang tepat waktu. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface PaymentReceivedParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  amount: string | number;
  phone: string;
  companyName?: string;
}

export interface PaymentApprovedParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  amount: string | number;
  phone: string;
  companyName?: string;
}

export interface PaymentRejectedParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  rejectionReason: string;
  phone: string;
  companyName?: string;
}

/**
 * Kirim notifikasi bukti pembayaran diterima (menunggu verifikasi)
 */
export async function sendPaymentReceived(params: PaymentReceivedParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const message =
    `🔔 *Bukti Pembayaran Diterima — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Bukti pembayaran Anda telah kami terima dengan rincian:\n\n` +
    `• No. Invoice : *${params.invoiceNumber}*\n` +
    `• Jumlah         : *${formatRupiah(params.amount)}*\n\n` +
    `Pembayaran Anda sedang dalam proses verifikasi oleh tim kami. Anda akan mendapat konfirmasi setelah proses selesai.\n\n` +
    `Terima kasih atas kesabaran Anda. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

/**
 * Kirim konfirmasi pembayaran disetujui admin
 */
export async function sendPaymentApproved(params: PaymentApprovedParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const message =
    `✅ *Pembayaran Disetujui — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kami informasikan bahwa pembayaran Anda telah *diverifikasi dan disetujui* oleh tim kami.\n\n` +
    `• No. Invoice : *${params.invoiceNumber}*\n` +
    `• Jumlah         : *${formatRupiah(params.amount)}*\n\n` +
    `Simpan pesan ini sebagai bukti konfirmasi pembayaran Anda.\n\n` +
    `Terima kasih atas kepercayaan Anda. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

/**
 * Kirim notifikasi pembayaran ditolak admin
 */
export async function sendPaymentRejected(params: PaymentRejectedParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const message =
    `❌ *Pembayaran Tidak Dapat Diproses — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Mohon maaf, bukti pembayaran Anda untuk invoice berikut tidak dapat kami proses:\n\n` +
    `• No. Invoice : *${params.invoiceNumber}*\n` +
    `• Alasan         : ${params.rejectionReason}\n\n` +
    `Mohon upload ulang bukti pembayaran yang valid melalui link yang telah dikirimkan sebelumnya, atau hubungi kami untuk informasi lebih lanjut.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface AdminPaymentAlertParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  amount: string | number;
  paymentMethod: string;
  referenceNumber?: string | null;
  paymentId: number;
  adminPhone: string;
  reviewLink: string;
  proofUrl?: string | null;
}

/**
 * Kirim notifikasi ke admin saat tenant submit bukti pembayaran.
 * Admin dapat membalas WA dengan:
 *   SETUJU {paymentId}       → approve
 *   TOLAK {paymentId} alasan → reject
 */
export async function sendAdminPaymentAlert(params: AdminPaymentAlertParams): Promise<WaResult> {
  const methodLabel: Record<string, string> = {
    transfer: "Transfer Bank",
    tunai: "Tunai / Cash",
    qris: "QRIS",
    edc: "EDC / Debit",
    other: "Lainnya",
  };

  const message =
    `🔔 *Bukti Pembayaran Baru Masuk*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `• Tenant   : *${params.ownerName}* (${params.businessName})\n` +
    `• Invoice  : *${params.invoiceNumber}*\n` +
    `• Jumlah   : *${formatRupiah(params.amount)}*\n` +
    `• Metode   : ${methodLabel[params.paymentMethod] ?? params.paymentMethod}\n` +
    (params.referenceNumber ? `• Ref No   : ${params.referenceNumber}\n` : "") +
    (params.proofUrl ? `\n📎 *Bukti Transfer:*\n${params.proofUrl}\n` : "") +
    `\n*Balas pesan ini untuk memproses:*\n` +
    `✅ SETUJU ${params.paymentId}\n` +
    `❌ TOLAK ${params.paymentId} <alasan>\n\n` +
    `🔗 Portal Admin: ${params.reviewLink}`;

  return sendMessage(params.adminPhone, message);
}

export interface BankUnmatchedAlertParams {
  adminName: string;
  adminPhone: string;
  totalImported: number;
  unmatchedCount: number;
  autoMatchedCount: number;
  duplicateCount: number;
  bankAccountId?: string;
  source: "import_csv" | "import_sheet" | "scheduler";
}

/**
 * Kirim notifikasi ke admin/owner/finance saat ada mutasi bank yang unmatched
 * setelah proses import atau dari scheduler periodik.
 */
export async function sendBankUnmatchedAlert(params: BankUnmatchedAlertParams): Promise<WaResult> {
  const sourceLabel: Record<string, string> = {
    import_csv: "Upload CSV",
    import_sheet: "Google Sheets",
    scheduler: "Pengecekan Periodik",
  };

  const bankLine = params.bankAccountId
    ? `• Rekening       : *${params.bankAccountId}*\n`
    : "";

  let message: string;

  if (params.source === "scheduler") {
    message =
      `🔔 *Mutasi Bank Perlu Review*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Yth. *${params.adminName}*,\n\n` +
      `Terdapat *${params.unmatchedCount} mutasi bank* yang belum berhasil dicocokkan secara otomatis dan perlu ditinjau secara manual.\n\n` +
      bankLine +
      `• Belum Cocok   : *${params.unmatchedCount} mutasi*\n\n` +
      `Mohon segera buka menu *Rekonsiliasi Bank → Mutasi* untuk mencocokkan transaksi tersebut.\n\n` +
      `Terima kasih 🙏\n` +
      `_Sistem Manajemen Mall_`;
  } else {
    message =
      `🏦 *Hasil Import Mutasi Bank*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Yth. *${params.adminName}*,\n\n` +
      `Import mutasi bank via *${sourceLabel[params.source] ?? params.source}* telah selesai:\n\n` +
      bankLine +
      `• Total Diimport : *${params.totalImported} mutasi*\n` +
      `• Auto-cocok     : ✅ ${params.autoMatchedCount} mutasi\n` +
      `• Duplikat       : ⚠️ ${params.duplicateCount} mutasi\n` +
      `• Belum Cocok    : ❌ *${params.unmatchedCount} mutasi*\n\n` +
      (params.unmatchedCount > 0
        ? `*${params.unmatchedCount} mutasi perlu dicocokkan manual.* Buka menu *Rekonsiliasi Bank → Mutasi* untuk meninjau.\n\n`
        : `Semua mutasi berhasil dicocokkan otomatis. 🎉\n\n`) +
      `Terima kasih 🙏\n` +
      `_Sistem Manajemen Mall_`;
  }

  return sendMessage(params.adminPhone, message);
}

export interface ReconciliationReminderParams {
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  totalAmount: string | number;
  outstandingAmount: string | number;
  dueDate: string;
  phone: string;
  monthLabel: string;
  companyName?: string;
}

/**
 * Kirim pengingat rekonsiliasi ke tenant yang invoicenya belum terverifikasi bank
 */
export async function sendReconciliationReminder(params: ReconciliationReminderParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const message =
    `📋 *Pengingat Rekonsiliasi — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kami belum menemukan konfirmasi pembayaran Anda untuk periode *${params.monthLabel}* dalam rekonsiliasi bank kami.\n\n` +
    `• No. Invoice       : *${params.invoiceNumber}*\n` +
    `• Total Tagihan     : ${formatRupiah(params.totalAmount)}\n` +
    `• Sisa Belum Bayar : *${formatRupiah(params.outstandingAmount)}*\n` +
    `• Jatuh Tempo       : ${params.dueDate}\n\n` +
    `Mohon segera:\n` +
    `1️⃣ Lakukan pembayaran jika belum dilakukan, atau\n` +
    `2️⃣ Kirimkan bukti transfer jika sudah membayar\n\n` +
    `Hubungi kami jika ada pertanyaan atau kendala pembayaran.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface BookingConfirmationParams {
  ownerName: string;
  businessName: string;
  orderNumber: string;
  contractNumber?: string | null;
  unitCode: string;
  floor?: string | null;
  startDate: string;
  endDate: string;
  durationMonths?: number | null;
  rentAmount: string | number;
  totalAmount?: string | number | null;
  dueDate?: string | null;
  phone: string;
  companyName?: string;
}

/**
 * Kirim konfirmasi booking/kontrak resmi ke tenant
 */
export async function sendBookingConfirmation(params: BookingConfirmationParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  };

  const contractLine = params.contractNumber
    ? `• No. Kontrak    : *${params.contractNumber}*\n`
    : `• No. Order      : *${params.orderNumber}*\n`;

  const floorLine = params.floor ? ` · ${params.floor}` : "";
  const durationLine = params.durationMonths
    ? `• Durasi Sewa    : *${params.durationMonths} bulan*\n`
    : "";

  const totalLine = params.totalAmount
    ? `• Total Tagihan  : ${formatRupiah(params.totalAmount)}\n`
    : "";

  const dueLine = params.dueDate
    ? `• Tagihan Pertama: *${fmtDate(params.dueDate)}*\n`
    : "";

  const message =
    `🎉 *Kontrak Sewa Resmi Dibuat*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Selamat! Kontrak sewa untuk usaha Anda telah resmi dibuat dengan rincian sebagai berikut:\n\n` +
    contractLine +
    `• Nama Usaha     : *${params.businessName}*\n` +
    `• Unit / Lokasi  : *${params.unitCode}*${floorLine}\n` +
    `• Periode Sewa   : ${fmtDate(params.startDate)} s/d ${fmtDate(params.endDate)}\n` +
    durationLine +
    `• Harga Sewa     : *${formatRupiah(params.rentAmount)}/bulan*\n` +
    totalLine +
    dueLine +
    `\nMohon simpan pesan ini sebagai bukti konfirmasi kontrak Anda.\n\n` +
    `Jika ada pertanyaan terkait kontrak, silakan hubungi tim manajemen kami.\n\n` +
    `Terima kasih atas kepercayaan Anda. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface ContractActivatedParams {
  ownerName: string;
  businessName: string;
  contractNumber?: string | null;
  orderNumber: string;
  unitCode: string;
  floor?: string | null;
  startDate: string;
  endDate: string;
  phone: string;
  companyName?: string;
}

/**
 * Kirim notifikasi kontrak resmi aktif ke tenant
 */
export async function sendContractActivated(params: ContractActivatedParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  };
  const refLine = params.contractNumber
    ? `• No. Kontrak  : *${params.contractNumber}*\n`
    : `• No. Order    : *${params.orderNumber}*\n`;
  const floorLine = params.floor ? ` · ${params.floor}` : "";
  const message =
    `✅ *Kontrak Sewa Resmi Aktif*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kontrak sewa Anda kini telah berstatus *AKTIF*:\n\n` +
    refLine +
    `• Nama Usaha   : *${params.businessName}*\n` +
    `• Unit         : *${params.unitCode}*${floorLine}\n` +
    `• Periode      : ${fmtDate(params.startDate)} s/d ${fmtDate(params.endDate)}\n\n` +
    `Selamat beroperasi! Jika ada pertanyaan, silakan hubungi tim manajemen kami.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;
  return sendMessage(params.phone, message);
}

export interface ContractExpiringSoonParams {
  ownerName: string;
  businessName: string;
  contractNumber?: string | null;
  orderNumber: string;
  unitCode: string;
  endDate: string;
  daysLeft: number;
  phone: string;
  companyName?: string;
}

/**
 * Kirim pengingat kontrak akan berakhir dalam 30 hari
 */
export async function sendContractExpiringSoon(params: ContractExpiringSoonParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  };
  const refLine = params.contractNumber
    ? `• No. Kontrak  : *${params.contractNumber}*\n`
    : `• No. Order    : *${params.orderNumber}*\n`;
  const message =
    `⚠️ *Kontrak Sewa Akan Segera Berakhir*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kami menginformasikan bahwa kontrak sewa Anda akan berakhir dalam *${params.daysLeft} hari* lagi.\n\n` +
    refLine +
    `• Nama Usaha   : *${params.businessName}*\n` +
    `• Unit         : *${params.unitCode}*\n` +
    `• Berakhir     : *${fmtDate(params.endDate)}*\n\n` +
    `Mohon segera hubungi tim manajemen kami jika Anda ingin memperpanjang kontrak sewa.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;
  return sendMessage(params.phone, message);
}

export interface ContractTerminatedParams {
  ownerName: string;
  businessName: string;
  contractNumber?: string | null;
  orderNumber: string;
  unitCode: string;
  reason?: string | null;
  phone: string;
  companyName?: string;
}

/**
 * Kirim notifikasi kontrak diterminasi ke tenant
 */
export async function sendContractTerminated(params: ContractTerminatedParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const refLine = params.contractNumber
    ? `• No. Kontrak  : *${params.contractNumber}*\n`
    : `• No. Order    : *${params.orderNumber}*\n`;
  const reasonLine = params.reason
    ? `• Alasan       : ${params.reason}\n`
    : "";
  const message =
    `🔴 *Kontrak Sewa Diakhiri*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kami menginformasikan bahwa kontrak sewa Anda telah resmi *diakhiri (terminasi)*:\n\n` +
    refLine +
    `• Nama Usaha   : *${params.businessName}*\n` +
    `• Unit         : *${params.unitCode}*\n` +
    reasonLine +
    `\nUntuk informasi lebih lanjut terkait proses pengakhiran kontrak, silakan hubungi tim manajemen kami.\n\n` +
    `Terima kasih atas kepercayaan Anda selama ini. 🙏\n` +
    `_${company}_`;
  return sendMessage(params.phone, message);
}

/**
 * Kirim reminder ke calon tenant yang pendaftarannya masih pending (bulk reminder)
 */
export async function sendCalonTenantReminder(phone: string, brandOrName?: string, companyName?: string): Promise<WaResult> {
  const company = companyName ?? "Manajemen CST";
  const nameLine = brandOrName ? `Halo *${brandOrName}*,` : "Halo,";
  const message =
    `🔔 *Pengingat Pendaftaran Tenant*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${nameLine}\n\n` +
    `Pendaftaran tenant Anda saat ini masih *menunggu proses* dari tim kami.\n\n` +
    `Mohon pastikan dokumen/perjanjian Anda telah dilengkapi. Jika membutuhkan bantuan atau ada pertanyaan, tim kami siap membantu.\n\n` +
    `Terima kasih atas kesabaran Anda. 🙏\n` +
    `_${company}_`;
  return sendMessage(phone, message);
}

/**
 * Kirim notifikasi ke calon tenant saat pendaftaran disetujui admin
 */
export async function sendCalonTenantApproved(phone: string, brandName?: string, companyName?: string): Promise<WaResult> {
  const company = companyName ?? "Manajemen CST";
  const nameLine = brandName ? ` atas nama *${brandName}*` : "";
  const message =
    `✅ *Pendaftaran Tenant Disetujui*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Selamat! Pendaftaran tenant Anda${nameLine} telah *disetujui* oleh tim kami.\n\n` +
    `Tim kami akan segera menghubungi Anda untuk proses berikutnya.\n\n` +
    `Terima kasih atas kepercayaan Anda. 🙏\n` +
    `_${company}_`;
  return sendMessage(phone, message);
}

/**
 * Kirim notifikasi ke calon tenant saat pendaftaran ditolak admin
 */
export async function sendCalonTenantRejected(phone: string, brandName?: string, companyName?: string): Promise<WaResult> {
  const company = companyName ?? "Manajemen CST";
  const nameLine = brandName ? ` atas nama *${brandName}*` : "";
  const message =
    `❌ *Pendaftaran Tenant Tidak Dapat Diproses*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Mohon maaf, pendaftaran tenant Anda${nameLine} belum dapat kami lanjutkan saat ini.\n\n` +
    `Untuk informasi lebih lanjut, silakan hubungi tim manajemen kami.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;
  return sendMessage(phone, message);
}

/**
 * Kirim notifikasi ke calon tenant bahwa ada unit yang kini kosong / tersedia
 */
export async function sendCalonTenantUnitAvailable(
  phone: string,
  picName: string | undefined,
  unitCodes: string[],
  companyName?: string,
): Promise<WaResult> {
  const company = companyName ?? "Manajemen CST";
  const salam = picName ? `Halo *${picName}*,` : "Halo,";
  const unitList = unitCodes.map((u) => `  • *${u}*`).join("\n");
  const unitSection =
    unitCodes.length === 1
      ? `Unit yang kini tersedia:\n  • *${unitCodes[0]}*`
      : `Unit-unit yang kini tersedia:\n${unitList}`;
  const message =
    `🏪 *Kabar Baik — Unit Tersedia!*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${salam}\n\n` +
    `Kami ingin memberitahukan bahwa saat ini ada unit yang *kosong dan siap disewa* di mall kami.\n\n` +
    `${unitSection}\n\n` +
    `Jika Anda masih tertarik, segera hubungi tim manajemen kami untuk informasi lebih lanjut dan proses sewa.\n\n` +
    `Jangan lewatkan kesempatan ini! 🙏\n` +
    `_${company}_`;
  return sendMessage(phone, message);
}

export interface PosPaymentSuccessParams {
  ownerName: string;
  businessName: string;
  invoiceNumber?: string | null;
  amountPaid: string | number;
  paymentMethod: string;
  receiptNumber: string;
  receiptUrl?: string | null;
  phone: string;
  companyName?: string;
}

/**
 * Kirim notifikasi pembayaran POS berhasil ke tenant — termasuk link receipt
 */
export async function sendPosPaymentSuccess(params: PosPaymentSuccessParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const methodLabel: Record<string, string> = {
    transfer: "Transfer Bank",
    tunai: "Tunai / Cash",
    qris: "QRIS",
    edc: "EDC / Debit",
    other: "Lainnya",
  };

  const invoiceLine = params.invoiceNumber
    ? `• No. Invoice  : *${params.invoiceNumber}*\n`
    : "";

  const receiptLine = params.receiptUrl
    ? `\n🧾 *Receipt / Kuitansi:*\n${params.receiptUrl}\n`
    : "";

  const message =
    `✅ *Pembayaran Diterima — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Pembayaran Anda telah kami terima dengan rincian:\n\n` +
    invoiceLine +
    `• No. Kuitansi : *${params.receiptNumber}*\n` +
    `• Jumlah         : *${formatRupiah(params.amountPaid)}*\n` +
    `• Metode         : ${methodLabel[params.paymentMethod] ?? params.paymentMethod}\n` +
    receiptLine +
    `\nTerima kasih atas pembayaran Anda yang tepat waktu. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

export interface AdminPosPaymentAlertParams {
  adminName: string;
  adminPhone: string;
  businessName: string;
  ownerName: string;
  receiptNumber: string;
  invoiceNumber?: string | null;
  amountPaid: string | number;
  paymentMethod: string;
  kasirName: string;
  siteName?: string | null;
}

/**
 * Kirim notifikasi ke admin/owner saat kasir mencatat pembayaran POS baru.
 */
export async function sendAdminPosPaymentAlert(params: AdminPosPaymentAlertParams): Promise<WaResult> {
  const methodLabel: Record<string, string> = {
    transfer: "Transfer Bank",
    tunai: "Tunai / Cash",
    qris: "QRIS",
    edc: "EDC / Debit",
    other: "Lainnya",
  };
  const invoiceLine = params.invoiceNumber ? `• No. Invoice  : *${params.invoiceNumber}*\n` : "";
  const siteLine = params.siteName ? `• Lokasi       : ${params.siteName}\n` : "";
  const message =
    `🏪 *Pembayaran POS Baru Diterima*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. *${params.adminName}*,\n\n` +
    `Ada pembayaran baru yang dicatat oleh kasir:\n\n` +
    `• Tenant       : *${params.businessName}* (${params.ownerName})\n` +
    invoiceLine +
    `• No. Kuitansi : *${params.receiptNumber}*\n` +
    `• Jumlah       : *${formatRupiah(params.amountPaid)}*\n` +
    `• Metode       : ${methodLabel[params.paymentMethod] ?? params.paymentMethod}\n` +
    `• Kasir        : ${params.kasirName}\n` +
    siteLine +
    `\n_Sistem Manajemen Mall_`;
  return sendMessage(params.adminPhone, message);
}

export async function sendOverdueReminder(params: OverdueReminderParams): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";
  const linkLine = params.paymentLink
    ? `\n🔗 *Link Pembayaran:*\n${params.paymentLink}\n`
    : "";

  const message =
    `🔴 *Tagihan Melewati Jatuh Tempo — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Kami menginformasikan bahwa tagihan Anda telah melewati batas waktu pembayaran.\n\n` +
    `• No. Invoice       : *${params.invoiceNumber}*\n` +
    `• Total Tagihan     : ${formatRupiah(params.totalAmount)}\n` +
    `• Sisa Belum Bayar : *${formatRupiah(params.outstandingAmount)}*\n` +
    `• Keterlambatan     : *${params.daysOverdue} hari*\n` +
    linkLine +
    `\nMohon segera lakukan pembayaran untuk menghindari sanksi keterlambatan lebih lanjut.\n\n` +
    `Hubungi kami jika ada pertanyaan atau kendala.\n\n` +
    `Terima kasih. 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}

// ─── Admin Group Notification ─────────────────────────────────────────────────

export interface AdminGroupPaymentParams {
  eventType: "bukti_pembayaran" | "pos_kasir" | "payment_approved" | "payment_rejected" | "invoice_sent" | "reminder" | "overdue";
  businessName: string;
  ownerName: string;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  amount: string | number;
  paymentMethod?: string;
  kasirName?: string | null;
  siteName?: string | null;
  referenceNumber?: string | null;
  reviewLink?: string | null;
  rejectionReason?: string | null;
  periodLabel?: string | null;
  dueDate?: string | null;
  daysUntilDue?: number | null;
  daysOverdue?: number | null;
  paymentLink?: string | null;
  siteId?: number | null;
  tenantId?: number | null;
  invoiceId?: number | null;
}

async function recordAdminGroupDelivery(
  params: AdminGroupPaymentParams,
  groupJid: string,
  result: WaResult,
): Promise<void> {
  const status = result.skipped
    ? "skipped"
    : !result.ok
      ? "failed"
      : result.pending
        ? "queued"
        : "accepted";

  const gatewayId = result.pending && result.response && typeof result.response === "object"
    ? (result.response as { messageId?: unknown }).messageId
    : null;
  const errorMessage = typeof gatewayId === "string" && /^[0-9a-f-]{16,64}$/i.test(gatewayId)
    ? `gateway:${gatewayId}` : (result.error ?? null);

  try {
    await db.insert(waLogsTable).values({
      siteId: params.siteId ?? null,
      tenantId: params.tenantId ?? null,
      invoiceId: params.invoiceId ?? null,
      phone: groupJid,
      messageType: `admin_group_${params.eventType}`,
      status,
      errorMessage,
      sentBy: "admin_group",
    });
  } catch (err) {
    logger.warn(
      { err, invoiceId: params.invoiceId, eventType: params.eventType },
      "[WA] Gagal menyimpan delivery log group admin",
    );
  }
}

/**
 * Kirim notifikasi ringkas ke WhatsApp Group admin (ADMIN_WA_GROUP).
 * Dipanggil secara fire-and-forget bersamaan dengan notifikasi individual.
 * Group JID format: 12036341119221335@g.us (tidak perlu normalisasi nomor)
 */
export function getAdminWaGroupStatus(): { configured: boolean; valid: boolean } {
  const groupJid = process.env.ADMIN_WA_GROUP?.trim() ?? "";
  return {
    configured: groupJid.length > 0,
    valid: /^\d+@g\.us$/.test(groupJid),
  };
}

/** Called only after a durable gateway FAILED receipt to permit a distinct retry. */
export function resetAdminGroupNotificationDedupe(params: AdminGroupPaymentParams): void {
  const groupJid = process.env.ADMIN_WA_GROUP?.trim() ?? "";
  const key = [groupJid, params.eventType, params.receiptNumber ?? "", params.invoiceNumber ?? "", String(params.amount)].join("|");
  groupNotificationCache.delete(key);
}

export async function notifyAdminGroup(params: AdminGroupPaymentParams): Promise<WaResult> {
  const groupJid = process.env.ADMIN_WA_GROUP?.trim();
  if (!groupJid) return { ok: true, skipped: true };
  if (!/^\d+@g\.us$/.test(groupJid)) {
    const result: WaResult = { ok: false, error: "ADMIN_WA_GROUP format tidak valid" };
    logger.error("[WA] ADMIN_WA_GROUP format tidak valid; expected numeric group JID ending @g.us");
    await recordAdminGroupDelivery(params, groupJid, result);
    return result;
  }

  const dedupeKey = [
    groupJid.trim(),
    params.eventType,
    params.receiptNumber ?? "",
    params.invoiceNumber ?? "",
    String(params.amount),
  ].join("|");
  const cached = groupNotificationCache.get(dedupeKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }
  if (cached) groupNotificationCache.delete(dedupeKey);

  const methodLabel: Record<string, string> = {
    transfer: "Transfer Bank",
    tunai: "Tunai / Cash",
    qris: "QRIS",
    edc: "EDC / Debit",
    other: "Lainnya",
  };

  const now = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let emoji = "🔔";
  let title = "Notifikasi Pembayaran";

  if (params.eventType === "bukti_pembayaran") {
    emoji = "📤";
    title = "Bukti Pembayaran Masuk";
  } else if (params.eventType === "pos_kasir") {
    emoji = "🏪";
    title = "Pembayaran POS Kasir";
  } else if (params.eventType === "payment_approved") {
    emoji = "✅";
    title = "Pembayaran Disetujui";
  } else if (params.eventType === "payment_rejected") {
    emoji = "❌";
    title = "Pembayaran Ditolak";
  } else if (params.eventType === "invoice_sent") {
    emoji = "🧾";
    title = "Invoice Tagihan Dikirim";
  } else if (params.eventType === "reminder") {
    const d = params.daysUntilDue;
    emoji = "⏰";
    title = d != null ? `Pengingat Tagihan H-${d}` : "Pengingat Tagihan";
  } else if (params.eventType === "overdue") {
    emoji = "🔴";
    title = "Tagihan Jatuh Tempo";
  }

  const invoiceLine = params.invoiceNumber ? `• Invoice    : *${params.invoiceNumber}*\n` : "";
  const receiptLine = params.receiptNumber ? `• Kuitansi  : *${params.receiptNumber}*\n` : "";
  const methodLine = params.paymentMethod
    ? `• Metode    : ${methodLabel[params.paymentMethod] ?? params.paymentMethod}\n`
    : "";
  const kasirLine = params.kasirName ? `• Kasir     : ${params.kasirName}\n` : "";
  const siteLine = params.siteName ? `• Lokasi    : ${params.siteName}\n` : "";
  const refLine = params.referenceNumber ? `• Ref No    : ${params.referenceNumber}\n` : "";
  const reviewLine = params.reviewLink ? `\n🔗 ${params.reviewLink}` : "";
  const rejectLine = params.rejectionReason ? `• Alasan    : ${params.rejectionReason}\n` : "";
  const periodLine = params.periodLabel ? `• Periode   : ${params.periodLabel}\n` : "";
  const dueDateLine = params.dueDate ? `• Jatuh Tempo: *${params.dueDate}*\n` : "";
  const overdueLabel = params.daysOverdue != null ? `• Telat     : *${params.daysOverdue} hari*\n` : "";
  const payLinkLine = params.paymentLink ? `\n🔗 *Link Bayar:* ${params.paymentLink}` : "";

  const message =
    `${emoji} *${title}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `• Tenant    : *${params.businessName}* (${params.ownerName})\n` +
    invoiceLine +
    receiptLine +
    periodLine +
    `• Jumlah    : *${formatRupiah(params.amount)}*\n` +
    dueDateLine +
    overdueLabel +
    methodLine +
    kasirLine +
    refLine +
    siteLine +
    rejectLine +
    `• Waktu     : ${now}\n` +
    reviewLine +
    payLinkLine;

  const sendPromise = sendGroupMessage(groupJid, message).then(async (result) => {
    await recordAdminGroupDelivery(params, groupJid, result);

    // Respons queued dari CST WA Gateway berarti pesan sudah diterima oleh
    // durable queue. Pertahankan dedupe agar event yang sama tidak diantrikan
    // dua kali. Hanya kegagalan atau skip yang boleh dicoba ulang.
    if (!result.ok || result.skipped) {
      groupNotificationCache.delete(dedupeKey);
    }
    return result;
  });
  groupNotificationCache.set(dedupeKey, {
    expiresAt: Date.now() + GROUP_NOTIFICATION_DEDUPE_MS,
    promise: sendPromise,
  });
  return sendPromise;
}

// ─── Invoice Konsolidasi ──────────────────────────────────────────────────────

export interface ConsolidatedInvoiceWaParams {
  phone: string;
  ownerName: string;
  businessName: string;
  invoiceNumber: string;
  periodLabel: string | null;
  dueDate: string | null;
  totalAmount: string | number;
  outstandingAmount: string | number;
  paidAmount: string | number;
  items: Array<{
    unitCode: string | null;
    invoiceNumber: string;
    amount: string | number;
    invoiceOutstanding: string | number;
  }>;
  companyName?: string;
}

export async function sendConsolidatedInvoiceNotification(
  params: ConsolidatedInvoiceWaParams
): Promise<WaResult> {
  const company = params.companyName ?? "Manajemen CST";

  const itemLines = params.items
    .map((item, i) => {
      const unit = item.unitCode ? `Unit ${item.unitCode}` : `Item ${i + 1}`;
      return `  ${i + 1}. *${unit}* — ${item.invoiceNumber}\n     Tagihan: ${formatRupiah(item.amount)} | Sisa: *${formatRupiah(item.invoiceOutstanding)}*`;
    })
    .join("\n");

  const dueLine = params.dueDate
    ? `• Jatuh Tempo     : *${new Date(params.dueDate).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}*\n`
    : "";

  const periodLine = params.periodLabel
    ? `• Periode            : ${params.periodLabel}\n`
    : "";

  const alreadyPaid = Number(params.paidAmount) > 0
    ? `• Sudah Dibayar  : ${formatRupiah(params.paidAmount)}\n`
    : "";

  const message =
    `📦 *Tagihan Konsolidasi — ${params.businessName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Yth. Bapak/Ibu *${params.ownerName}*,\n\n` +
    `Berikut tagihan konsolidasi untuk semua unit yang Anda sewa:\n\n` +
    `• No. Invoice       : *${params.invoiceNumber}*\n` +
    periodLine +
    dueLine +
    `\n📋 *Rincian per Unit:*\n` +
    itemLines +
    `\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    alreadyPaid +
    `• *Total Sisa Tagihan : ${formatRupiah(params.outstandingAmount)}*\n\n` +
    `Mohon lakukan pembayaran sebelum tanggal jatuh tempo.\n` +
    `Hubungi kami jika ada pertanyaan.\n\n` +
    `Terima kasih 🙏\n` +
    `_${company}_`;

  return sendMessage(params.phone, message);
}
