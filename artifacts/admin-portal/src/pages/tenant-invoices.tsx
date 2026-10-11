import { apiFetch as apiFetchBase } from "@/lib/api";
import { useState, useMemo, useRef, useEffect } from "react";
import { useSite } from "@/contexts/site-context";
import { PaymentHistoryModal } from "@/components/payment-history-modal";
import { getPaymentDateLabel } from "@/lib/payment-date-label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus, FileText, Printer, CreditCard, X, Search, Zap, AlertCircle,
  CheckCircle2, Clock, Ban, CircleDashed, MessageCircle, Send, Link2, Loader2,
  Copy, WifiOff, CheckCheck, Download, Layers, ChevronDown, ChevronRight, Eye, Trash2,
  BarChart2, FileDown, FileSpreadsheet, Pencil, History, AlertTriangle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type InvoiceStatus = "draft" | "unpaid" | "partial" | "paid" | "overdue" | "cancelled";

type Invoice = {
  id: number;
  invoiceNumber: string;
  siteId: number | null;
  tenantId: number;
  bookingId: number | null;
  unitCode: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  rentAmount: string;
  serviceChargeAmount: string;
  electricityChargeAmount: string;
  waterChargeAmount: string;
  otherChargeAmount: string;
  trashChargeAmount: string;
  discountAmount: string;
  penaltyAmount: string;
  usePpn: boolean;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  status: InvoiceStatus;
  notes: string | null;
  invoiceNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenantName: string | null;
  ownerName: string | null;
  boothNumber: string | null;
  areaName: string | null;
  email: string | null;
  phone: string | null;
  companyId: number | null;
  companyName: string | null;
  payments?: Payment[];
};

type CompanyRow = { id: number; code: string; name: string; companyName: string | null; companyCode: string | null };

type Payment = {
  id: number;
  amount: string;
  invoiceAllocationAmount?: string | null;
  surchargeAllocationAmount?: string | null;
  paymentMethod: string;
  sourceType: string | null;
  receiptNumber: string | null;
  notes: string | null;
  paidAt: string | null;
};

type Tenant = {
  id: number;
  businessName: string;
  boothNumber: string | null;
  status: string | null;
  defaultRentAmount: string | null;
  defaultServiceChargeAmount: string | null;
  defaultElectricityChargeAmount: string | null;
  defaultWaterChargeAmount: string | null;
  defaultOtherChargeAmount: string | null;
  defaultTrashChargeAmount: string | null;
};
type Booking = {
  id: number;
  tenantId: number;
  tenantName: string | null;
  unitCode: string | null;
  contractNumber: string | null;
  orderNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  rentAmount: string | null;
  serviceChargeAmount: string | null;
  electricityChargeAmount: string | null;
  waterChargeAmount: string | null;
  otherChargeAmount: string | null;
  totalAmount: string | null;
  periodLabel: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  unpaid: "Belum Bayar",
  partial: "Sebagian",
  paid: "Lunas",
  overdue: "Jatuh Tempo",
  cancelled: "Dibatalkan",
};

const STATUS_CLASS: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  unpaid: "bg-orange-100 text-orange-700 border-orange-200",
  partial: "bg-yellow-100 text-yellow-700 border-yellow-200",
  paid: "bg-green-100 text-green-700 border-green-200",
  overdue: "bg-red-100 text-red-700 border-red-200",
  cancelled: "bg-gray-100 text-gray-400 border-gray-200",
};

const STATUS_ICON: Record<InvoiceStatus, React.ReactNode> = {
  draft: <CircleDashed className="h-3.5 w-3.5" />,
  unpaid: <Clock className="h-3.5 w-3.5" />,
  partial: <AlertCircle className="h-3.5 w-3.5" />,
  paid: <CheckCircle2 className="h-3.5 w-3.5" />,
  overdue: <AlertCircle className="h-3.5 w-3.5" />,
  cancelled: <Ban className="h-3.5 w-3.5" />,
};

// ─── Utils ────────────────────────────────────────────────────────────────────

function formatRupiah(v: string | number | null | undefined): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0,
  }).format(Number(v ?? 0));
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "-";
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d));
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "-";
  const opts: Intl.DateTimeFormatOptions = { month: "short", year: "numeric" };
  const s = start ? new Intl.DateTimeFormat("id-ID", opts).format(new Date(start)) : "";
  const e = end ? new Intl.DateTimeFormat("id-ID", opts).format(new Date(end)) : "";
  if (s === e) return s;
  return `${s} – ${e}`;
}

function jakartaDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isFutureInvoicePeriod(inv: Pick<Invoice, "periodStart" | "status">): boolean {
  if (!inv.periodStart || inv.status === "paid" || inv.status === "cancelled") return false;
  return inv.periodStart > jakartaDateKey();
}

function isActiveReceivable(inv: Pick<Invoice, "periodStart" | "status" | "outstandingAmount">): boolean {
  if (["paid", "cancelled", "draft"].includes(inv.status)) return false;
  if (isFutureInvoicePeriod(inv as Pick<Invoice, "periodStart" | "status">)) return false;
  return Number(inv.outstandingAmount ?? 0) > 0;
}

function effectiveOutstanding(inv: Pick<Invoice, "status" | "outstandingAmount">): number {
  return inv.status === "cancelled" ? 0 : Number(inv.outstandingAmount ?? 0);
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

type ExportableInvoice = {
  invoiceNumber: string;
  tenantName: string | null;
  ownerName: string | null;
  boothNumber: string | null;
  areaName: string | null;
  unitCode: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  rentAmount: string;
  serviceChargeAmount: string;
  electricityChargeAmount: string;
  waterChargeAmount: string;
  otherChargeAmount: string;
  discountAmount: string;
  penaltyAmount: string;
  taxAmount: string;
  totalAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  status: string;
  notes: string | null;
  createdAt: string;
};

function csvEscape(v: string | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function exportInvoicesToCSV(rows: ExportableInvoice[], filename: string) {
  const headers = [
    "No. Invoice", "Tenant", "Pemilik", "Unit/Booth", "Area/Lantai", "Kode Unit",
    "Periode Mulai", "Periode Selesai", "Jatuh Tempo",
    "Sewa (Rp)", "Service Charge (Rp)", "Listrik (Rp)", "Air (Rp)", "Lainnya (Rp)",
    "Diskon (Rp)", "Denda (Rp)", "Pajak (Rp)",
    "Total (Rp)", "Terbayar (Rp)", "Sisa (Rp)",
    "Status", "Catatan", "Dibuat",
  ];

  const STATUS_ID: Record<string, string> = {
    draft: "Draft", unpaid: "Belum Bayar", partial: "Sebagian",
    paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan",
  };

  const lines = [
    headers.join(","),
    ...rows.map((r) => [
      csvEscape(r.invoiceNumber),
      csvEscape(r.tenantName),
      csvEscape(r.ownerName),
      csvEscape(r.boothNumber),
      csvEscape(r.areaName),
      csvEscape(r.unitCode),
      csvEscape(r.periodStart ? new Date(r.periodStart).toLocaleDateString("id-ID") : null),
      csvEscape(r.periodEnd   ? new Date(r.periodEnd  ).toLocaleDateString("id-ID") : null),
      csvEscape(r.dueDate     ? new Date(r.dueDate    ).toLocaleDateString("id-ID") : null),
      Number(r.rentAmount              ?? 0),
      Number(r.serviceChargeAmount     ?? 0),
      Number(r.electricityChargeAmount ?? 0),
      Number(r.waterChargeAmount       ?? 0),
      Number(r.otherChargeAmount       ?? 0),
      Number(r.discountAmount          ?? 0),
      Number(r.penaltyAmount           ?? 0),
      Number(r.taxAmount               ?? 0),
      Number(r.totalAmount             ?? 0),
      Number(r.paidAmount              ?? 0),
      r.status === "cancelled" ? 0 : Number(r.outstandingAmount ?? 0),
      csvEscape(STATUS_ID[r.status] ?? r.status),
      csvEscape(r.notes),
      csvEscape(r.createdAt ? new Date(r.createdAt).toLocaleDateString("id-ID") : null),
    ].join(",")),
  ];

  // BOM agar Excel buka dengan encoding UTF-8 yang benar
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

const STATUS_ID_PDF: Record<string, string> = {
  draft: "Draft", unpaid: "Belum Bayar", partial: "Sebagian",
  paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan",
  sent: "Terkirim",
};

function fmtRp(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (isNaN(n)) return "0";
  return n.toLocaleString("id-ID");
}

async function exportInvoicesToPDF(rows: ExportableInvoice[], filename: string, filterLabel?: string, companyName?: string) {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  const now = new Date();
  const tgl = now.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
  const jam = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("LAPORAN INVOICE TENANT", 148, 14, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(companyName ?? "Manajemen CST", 148, 20, { align: "center" });
  if (filterLabel) doc.text(`Filter: ${filterLabel}`, 148, 25, { align: "center" });
  doc.text(`Dicetak: ${tgl}, ${jam}  |  Total: ${rows.length} invoice`, 148, filterLabel ? 30 : 25, { align: "center" });

  const tableTop = filterLabel ? 34 : 30;

  const tableRows = rows.map((r, i) => [
    i + 1,
    r.invoiceNumber,
    r.tenantName ?? "-",
    r.periodStart ? new Date(r.periodStart).toLocaleDateString("id-ID", { month: "short", year: "numeric" }) : "-",
    r.dueDate ? new Date(r.dueDate).toLocaleDateString("id-ID") : "-",
    fmtRp(r.totalAmount),
    fmtRp(r.paidAmount),
    fmtRp(r.status === "cancelled" ? 0 : r.outstandingAmount),
    STATUS_ID_PDF[r.status] ?? r.status,
  ]);

  autoTable(doc, {
    startY: tableTop,
    head: [[
      "#", "No. Invoice", "Tenant", "Periode", "Jatuh Tempo",
      "Total (Rp)", "Terbayar (Rp)", "Sisa (Rp)", "Status",
    ]],
    body: tableRows,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold", fontSize: 8 },
    columnStyles: {
      0: { halign: "center", cellWidth: 8 },
      1: { cellWidth: 38 },
      2: { cellWidth: 40 },
      3: { cellWidth: 22, halign: "center" },
      4: { cellWidth: 22, halign: "center" },
      5: { cellWidth: 28, halign: "right" },
      6: { cellWidth: 28, halign: "right" },
      7: { cellWidth: 28, halign: "right" },
      8: { cellWidth: 20, halign: "center" },
    },
    alternateRowStyles: { fillColor: [245, 247, 255] },
    didDrawCell: (data) => {
      if (data.column.index === 8 && data.cell.section === "body") {
        const val = String(data.cell.raw ?? "");
        const colors: Record<string, [number, number, number]> = {
          "Lunas":        [22, 163, 74],
          "Sebagian":     [234, 179, 8],
          "Jatuh Tempo":  [220, 38, 38],
          "Belum Bayar":  [249, 115, 22],
          "Dibatalkan":   [107, 114, 128],
          "Draft":        [100, 116, 139],
          "Terkirim":     [59, 130, 246],
        };
        const c = colors[val];
        if (c) {
          doc.setFontSize(6.5);
          doc.setTextColor(255, 255, 255);
          const x = data.cell.x + 1;
          const y = data.cell.y + 1;
          const w = data.cell.width - 2;
          const h = data.cell.height - 2;
          doc.setFillColor(...c);
          doc.roundedRect(x, y, w, h, 1, 1, "F");
          doc.text(val, x + w / 2, y + h / 2 + 0.5, { align: "center", baseline: "middle" });
        }
      }
    },
    didDrawPage: (data) => {
      const pgCount: number = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
      const pgN: number = data.pageNumber;
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Halaman ${pgN} dari ${pgCount}`, doc.internal.pageSize.getWidth() - 10, doc.internal.pageSize.getHeight() - 5, { align: "right" });
      doc.text(`${companyName ?? "Manajemen CST"} — Laporan Invoice Tenant`, 10, doc.internal.pageSize.getHeight() - 5);
    },
  });

  doc.save(filename);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string): Promise<T> {
  const res = await apiFetchBase(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(url: string, body: object): Promise<T> {
  const res = await apiFetchBase(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Gagal memproses permintaan");
  }
  return res.json() as Promise<T>;
}

async function apiPatch<T>(url: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Gagal memperbarui");
  }
  return res.json() as Promise<T>;
}

// ─── Print Invoice ────────────────────────────────────────────────────────────

interface MallInvoiceConfig {
  mallName: string;
  companyName?: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  logoUrl: string;
  invoiceColor: string;
  invoiceFooterNote: string;
  invoiceSignerName: string;
}

const DEFAULT_INVOICE_CONFIG: MallInvoiceConfig = {
  mallName: "Mall Admin",
  companyName: "",
  tagline: "Manajemen Tenant Mall",
  address: "",
  phone: "",
  email: "",
  logoUrl: "",
  invoiceColor: "#1e3a5f",
  invoiceFooterNote: "",
  invoiceSignerName: "",
};

/** Cache sites list agar tidak fetch berulang saat print banyak invoice */
let _sitesCache: { siteId: number; companyName: string; logoUrl: string; invoiceColor: string }[] | null = null;
async function fetchSitesCache() {
  if (_sitesCache) return _sitesCache;
  try {
    const res = await apiFetchBase("/api/settings/sites", { credentials: "include" });
    if (!res.ok) return [];
    _sitesCache = await res.json();
    return _sitesCache!;
  } catch {
    return [];
  }
}

async function fetchInvoiceConfig(siteId?: number | null): Promise<MallInvoiceConfig> {
  try {
    const [settingsRes, sites] = await Promise.all([
      apiFetchBase("/api/settings", { credentials: "include" }),
      fetchSitesCache(),
    ]);
    const globalData = settingsRes.ok ? await settingsRes.json() : {};
    const base: MallInvoiceConfig = { ...DEFAULT_INVOICE_CONFIG, ...globalData };

    // Overlay warna dan logo per-site jika tersedia
    if (siteId) {
      const site = sites.find(s => s.siteId === siteId);
      if (site) {
        if (site.invoiceColor) base.invoiceColor = site.invoiceColor;
        if (site.logoUrl) base.logoUrl = site.logoUrl;
        if (site.companyName) base.companyName = site.companyName;
      }
    }
    return base;
  } catch {
    return DEFAULT_INVOICE_CONFIG;
  }
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildInvoiceHtml(inv: Invoice, cfg: MallInvoiceConfig): string {
  const accent = cfg.invoiceColor || "#1e3a5f";
  const accentLight = accent + "14";
  // Gunakan companyName (per-site) jika tersedia, fallback ke mallName (global)
  const displayName = escapeHtml((cfg.companyName && cfg.companyName.trim()) ? cfg.companyName.trim() : cfg.mallName);

  const brandBlock = cfg.logoUrl
    ? `<div style="display:flex;align-items:center;gap:14px">
         <img src="${escapeHtml(cfg.logoUrl)}" alt="Logo" style="height:56px;width:56px;object-fit:contain;flex-shrink:0" crossorigin="anonymous" />
         <div>
           <div style="font-size:20px;font-weight:700;color:${accent};line-height:1.2">${displayName}</div>
           <div style="font-size:11px;color:#777;margin-top:3px;letter-spacing:0.02em">${escapeHtml(cfg.tagline)}</div>
         </div>
       </div>`
    : `<div style="font-size:22px;font-weight:700;color:${accent}">${displayName}</div>
       <div style="font-size:12px;color:#666;margin-top:2px">${escapeHtml(cfg.tagline)}</div>`;

  const addressLine = cfg.address ? `<div style="margin-bottom:2px">${escapeHtml(cfg.address)}</div>` : "";
  const contactLine = [cfg.phone, cfg.email].filter(Boolean).map(escapeHtml).join("  ·  ");
  const contactHtml = (cfg.address || contactLine)
    ? `<div style="font-size:10px;color:#888;margin-top:8px;line-height:1.7">${addressLine}${contactLine ? `<div>${contactLine}</div>` : ""}</div>`
    : "";

  const rows = [
    ["Sewa Ruang / Booth", inv.rentAmount],
    ["Service Charge", inv.serviceChargeAmount],
    ["Biaya Listrik", inv.electricityChargeAmount],
    ["Biaya Air", inv.waterChargeAmount],
    ["Biaya Lain-lain", inv.otherChargeAmount],
    ["Iuran Sampah / Kebersihan", inv.trashChargeAmount],
  ]
    .filter(([, v]) => Number(v) > 0)
    .map(([label, v]) =>
      `<tr><td style="padding:5px 10px">${label}</td><td style="padding:5px 10px;text-align:right">${formatRupiah(v)}</td></tr>`
    ).join("");

  // Nama penanda tangan: selalu pakai displayName (nama PT dari header) agar konsisten
  const signerName = displayName;
  const signerHtml = `<div style="margin-top:40px;text-align:right;font-size:12px;color:#444">
      <div>Hormat kami,</div>
      <div style="margin-top:36px;border-top:1px solid #ccc;padding-top:4px;display:inline-block;min-width:140px;font-weight:600">${signerName}</div>
     </div>`;

  const footerNote = cfg.invoiceFooterNote
    ? `<div style="margin-bottom:6px;font-weight:500;color:#555">${escapeHtml(cfg.invoiceFooterNote)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <title>Invoice ${inv.invoiceNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; background: #fff; padding: 40px; max-width: 720px; margin: auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
    .inv-meta { text-align: right; }
    .inv-number { font-size: 15px; font-weight: 700; color: ${accent}; }
    .status-badge { display: inline-block; margin-top: 6px; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #fef3c7; color: #b45309; border: 1px solid #fcd34d; }
    .accent-divider { border: none; border-top: 3px solid ${accent}; margin: 20px 0; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; font-weight: 600; }
    .value { font-size: 13px; color: #1a1a1a; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    thead tr { background: ${accent} !important; }
    th { text-align: left; padding: 9px 10px; font-size: 11px; text-transform: uppercase; color: #fff !important; letter-spacing: 0.05em; font-weight: 600; }
    td { padding: 6px 10px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
    tr:nth-child(even) td { background: ${accentLight} !important; }
    .totals { margin-left: auto; width: 300px; }
    .total-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .total-grand { display: flex; justify-content: space-between; padding: 9px 0; font-size: 16px; font-weight: 700; border-top: 2px solid ${accent}; margin-top: 4px; color: ${accent}; }
    .outstanding { display: flex; justify-content: space-between; padding: 6px 10px; background: #fff7ed !important; border: 1px solid #fed7aa; border-radius: 8px; margin-top: 8px; font-weight: 600; color: #c2410c; }
    .footer { margin-top: 36px; font-size: 11px; color: #aaa; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 14px; }
    @media print {
      body { padding: 20px; }
      @page { margin: 10mm 15mm; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      thead tr { background: ${accent} !important; }
      th { color: #fff !important; }
      tr:nth-child(even) td { background: ${accentLight} !important; }
      .outstanding { background: #fff7ed !important; }
      .status-badge { background: #fef3c7 !important; color: #b45309 !important; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>${brandBlock}${contactHtml}</div>
    <div class="inv-meta">
      <div class="inv-number">${escapeHtml(inv.invoiceNumber)}</div>
      <div style="font-size:12px;color:#666;margin-top:4px">Tanggal: ${formatDate(inv.periodStart)}</div>
      <div class="status-badge">${STATUS_LABEL[inv.status] ?? escapeHtml(inv.status)}</div>
    </div>
  </div>
  <hr class="accent-divider" />
  <div class="grid-2">
    <div>
      <div class="label">Tagihan Kepada</div>
      <div class="value">${escapeHtml(inv.tenantName) || "-"}</div>
      <div style="font-size:12px;color:#666;margin-top:2px">${escapeHtml(inv.ownerName)}</div>
      ${inv.email ? `<div style="font-size:12px;color:#666">${escapeHtml(inv.email)}</div>` : ""}
      ${inv.phone ? `<div style="font-size:12px;color:#666">${escapeHtml(inv.phone)}</div>` : ""}
    </div>
    <div>
      <div class="label">Detail Invoice</div>
      <table style="width:auto;margin:0">
        <tr><td style="padding:2px 4px;color:#666;font-size:12px">Unit/Booth</td><td style="padding:2px 8px;font-size:12px;font-weight:500">${escapeHtml(inv.unitCode ?? inv.boothNumber) || "-"}</td></tr>
        <tr><td style="padding:2px 4px;color:#666;font-size:12px">Periode</td><td style="padding:2px 8px;font-size:12px;font-weight:500">${formatPeriod(inv.periodStart, inv.periodEnd)}</td></tr>
        <tr><td style="padding:2px 4px;color:#666;font-size:12px">Jatuh Tempo</td><td style="padding:2px 8px;font-size:12px;font-weight:500">${formatDate(inv.dueDate)}</td></tr>
      </table>
    </div>
  </div>
  <table>
    <thead><tr><th>Uraian</th><th style="text-align:right">Jumlah</th></tr></thead>
    <tbody>
      ${rows}
      ${Number(inv.discountAmount) > 0 ? `<tr><td style="padding:5px 10px;color:#059669">Diskon</td><td style="padding:5px 10px;text-align:right;color:#059669">- ${formatRupiah(inv.discountAmount)}</td></tr>` : ""}
    </tbody>
  </table>
  <div class="totals">
    <div class="total-row"><span>Subtotal</span><span>${formatRupiah(inv.subtotal)}</span></div>
    ${Number(inv.taxAmount) > 0 ? `<div class="total-row" style="color:#2563eb"><span>PPN 11% <span style="font-weight:normal;font-size:10px">(Pajak Pertambahan Nilai)</span></span><span>+ ${formatRupiah(inv.taxAmount)}</span></div>` : ""}
    <div class="total-grand"><span>Total</span><span>${formatRupiah(inv.totalAmount)}</span></div>
    <div class="total-row" style="color:#059669;padding-top:6px"><span>Terbayar</span><span>${formatRupiah(inv.paidAmount)}</span></div>
    ${Number(inv.outstandingAmount) > 0 ? `<div class="outstanding"><span>Sisa Tagihan</span><span>${formatRupiah(inv.outstandingAmount)}</span></div>` : ""}
  </div>
  ${inv.notes ? `<div style="margin-top:24px;padding:12px;background:#f8fafc;border-radius:8px;font-size:12px;color:#555"><strong>Catatan:</strong> ${escapeHtml(inv.notes)}</div>` : ""}
  ${signerHtml}
  <div class="footer">
    ${footerNote}
    <div>Dokumen ini dibuat secara otomatis oleh sistem ${displayName}. Harap simpan sebagai bukti pembayaran.</div>
  </div>
</body>
</html>`;
}

async function viewOrPrintInvoice(inv: Invoice, mode: "view" | "print" = "print") {
  const cfg = await fetchInvoiceConfig(inv.siteId);
  const html = buildInvoiceHtml(inv, cfg);
  const win = window.open("", "_blank", "width=800,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  if (mode === "print") {
    setTimeout(() => win.print(), 300);
  }
}

async function generateInvoicePdfBlob(inv: Invoice): Promise<Blob> {
  const [{ default: JsPDF }, { default: html2canvas }] = await Promise.all([
    import("jspdf"),
    import("html2canvas"),
  ]);

  const cfg = await fetchInvoiceConfig(inv.siteId);
  const html = buildInvoiceHtml(inv, cfg);

  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;top:-99999px;left:-99999px;width:800px;height:1px;border:none;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  try {
    const idoc = iframe.contentDocument!;
    idoc.open();
    idoc.write(html);
    idoc.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    const body = idoc.body;
    body.style.overflow = "visible";
    body.style.height = "auto";

    const canvas = await html2canvas(body, {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      backgroundColor: "#ffffff",
      windowWidth: 800,
      logging: false,
      imageTimeout: 6000,
    });

    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pdfW = pdf.internal.pageSize.getWidth();
    const pdfH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pdfW) / canvas.width;

    pdf.addImage(imgData, "JPEG", 0, 0, pdfW, imgH);
    let heightLeft = imgH - pdfH;
    let page = 1;
    while (heightLeft > 0) {
      pdf.addPage();
      pdf.addImage(imgData, "JPEG", 0, -(pdfH * page), pdfW, imgH);
      heightLeft -= pdfH;
      page++;
    }

    return pdf.output("blob");
  } finally {
    document.body.removeChild(iframe);
  }
}

async function downloadInvoicePdf(
  inv: Invoice,
  onStart: () => void,
  onEnd: () => void,
): Promise<void> {
  onStart();
  try {
    const blob = await generateInvoicePdfBlob(inv);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${inv.invoiceNumber}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    onEnd();
  }
}

// ─── Create Invoice Form ───────────────────────────────────────────────────────

type CreateForm = {
  tenantId: string;
  bookingId: string;
  unitCode: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  rentAmount: string;
  serviceChargeAmount: string;
  electricityChargeAmount: string;
  waterChargeAmount: string;
  otherChargeAmount: string;
  trashChargeAmount: string;
  discountAmount: string;
  penaltyAmount: string;
  notes: string;
  status: InvoiceStatus;
  usePpn: boolean;
};

const EMPTY_FORM: CreateForm = {
  tenantId: "", bookingId: "",
  unitCode: "", periodStart: "", periodEnd: "", dueDate: "",
  rentAmount: "", serviceChargeAmount: "", electricityChargeAmount: "",
  waterChargeAmount: "", otherChargeAmount: "", trashChargeAmount: "",
  discountAmount: "0", penaltyAmount: "0",
  notes: "", status: "unpaid",
  usePpn: true,
};

// ─── Edit Invoice Form ─────────────────────────────────────────────────────────

type EditForm = {
  unitCode: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  rentAmount: string;
  serviceChargeAmount: string;
  electricityChargeAmount: string;
  waterChargeAmount: string;
  otherChargeAmount: string;
  trashChargeAmount: string;
  discountAmount: string;
  penaltyAmount: string;
  notes: string;
  status: InvoiceStatus;
  usePpn: boolean;
};

function invoiceToEditForm(inv: Invoice): EditForm {
  const toDate = (s: string | null | undefined) => s ? s.slice(0, 10) : "";
  return {
    unitCode: inv.unitCode ?? "",
    periodStart: toDate(inv.periodStart),
    periodEnd: toDate(inv.periodEnd),
    dueDate: toDate(inv.dueDate),
    rentAmount: inv.rentAmount,
    serviceChargeAmount: inv.serviceChargeAmount,
    electricityChargeAmount: inv.electricityChargeAmount,
    waterChargeAmount: inv.waterChargeAmount,
    otherChargeAmount: inv.otherChargeAmount,
    trashChargeAmount: inv.trashChargeAmount,
    discountAmount: inv.discountAmount,
    penaltyAmount: inv.penaltyAmount,
    notes: inv.notes ?? "",
    status: inv.status,
    usePpn: inv.usePpn !== false,
  };
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}{required && " *"}</Label>
      {children}
    </div>
  );
}

// ─── Payment Form ─────────────────────────────────────────────────────────────

type PaymentForm = {
  amountPaid: string;
  paymentMethod: "tunai" | "transfer" | "qris" | "edc" | "other";
  paymentDate: string;
  notes: string;
};

const EMPTY_PAYMENT: PaymentForm = {
  amountPaid: "", paymentMethod: "tunai", paymentDate: todayStr(), notes: "",
};

// ─── Generate from Booking Form ───────────────────────────────────────────────

type GenerateForm = { bookingId: string; notes: string };

// ─── Main Page ────────────────────────────────────────────────────────────────

function useMobileLayout() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);
  return isMobile;
}

export default function TenantInvoices() {
  const isMobile = useMobileLayout();
  const { activeSite, activeSiteId } = useSite();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const printRef = useRef<Invoice | null>(null);

  const [filterStatus, setFilterStatus] = useState("all");
  const [filterTenant, setFilterTenant] = useState("all");
  const [filterCompany, setFilterCompany] = useState("all");
  const [filterDueDate, setFilterDueDate] = useState("all");
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_FORM);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateForm, setGenerateForm] = useState<GenerateForm>({ bookingId: "", notes: "" });

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<Invoice | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(EMPTY_PAYMENT);

  // Cek apakah ada bukti pending_review untuk invoice yang sedang dibuka di dialog Bayar
  const { data: pendingProofCheck } = useQuery<{ hasPending: boolean; receiptNumber?: string }>({
    queryKey: ["pending-proof-check", activeSiteId, paymentTarget?.id],
    queryFn: async () => {
      if (!paymentTarget) return { hasPending: false };
      const rows = await apiFetchBase(`/api/pending-payments?status=pending_review`) as unknown as Array<{ invoiceId: number; receiptNumber: string }>;
      const found = rows.find((r) => r.invoiceId === paymentTarget.id);
      return { hasPending: !!found, receiptNumber: found?.receiptNumber };
    },
    enabled: activeSiteId !== null && paymentOpen && !!paymentTarget,
  });

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<Invoice | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Invoice | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [payHistoryOpen, setPayHistoryOpen] = useState(false);
  const [payHistoryInvoice, setPayHistoryInvoice] = useState<Invoice | null>(null);

  const [cancelTarget, setCancelTarget] = useState<Invoice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Invoice | null>(null);
  const [sendingLinkId, setSendingLinkId] = useState<number | null>(null);
  const [copyingLinkId, setCopyingLinkId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [sendingPdfId, setSendingPdfId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkSendProgress, setBulkSendProgress] = useState<{ current: number; total: number; errors: number } | null>(null);
  const [paymentLinkDialog, setPaymentLinkDialog] = useState<{
    link: string;
    message?: string;
    mode: "manual" | "wa-failed" | "wa-pending";
  } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Pilihan dan dialog milik site lama tidak boleh ikut tampil setelah lokasi berganti.
  useEffect(() => {
    setSelectedIds(new Set());
    setPaymentOpen(false);
    setPaymentTarget(null);
    setDetailOpen(false);
    setDetailTarget(null);
    setEditOpen(false);
    setEditTarget(null);
    setPayHistoryOpen(false);
    setPayHistoryInvoice(null);
    setCancelTarget(null);
    setDeleteTarget(null);
  }, [activeSiteId]);

  // ─── Laporan PPN state ───────────────────────────────────────────────────────
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [ppnOpen, setPpnOpen] = useState(false);
  const [ppnFrom, setPpnFrom] = useState(curMonth);
  const [ppnTo,   setPpnTo]   = useState(curMonth);
  const [ppnTab,  setPpnTab]  = useState<"bulan" | "tenant">("bulan");

  // ─── Bulk invoice state ──────────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCommon, setBulkCommon] = useState({
    periodStart: "", periodEnd: "", dueDate: "", status: "unpaid" as InvoiceStatus, notes: "",
  });
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  type BulkPrice = { unitCode: string; rentAmount: string; serviceChargeAmount: string; electricityChargeAmount: string; waterChargeAmount: string; otherChargeAmount: string; trashChargeAmount: string; };
  const [bulkPrices, setBulkPrices] = useState<Record<number, BulkPrice>>({});
  const [bulkExpanded, setBulkExpanded] = useState<number | null>(null);
  const [bulkResult, setBulkResult] = useState<{ succeeded: number; failed: number; results: { tenantId: number; invoiceNumber: string; success: boolean; error?: string }[] } | null>(null);
  const [bulkMonth, setBulkMonth] = useState<{ month: number; year: number }>(() => {
    const now = new Date();
    return { month: now.getMonth() + 1, year: now.getFullYear() };
  });

  // ─── Queries ────────────────────────────────────────────────────────────────

  const qParams = new URLSearchParams();
  if (filterStatus !== "all") qParams.set("status", filterStatus);
  if (filterTenant !== "all") qParams.set("tenantId", filterTenant);
  if (filterCompany !== "all") qParams.set("companyId", filterCompany);
  if (search) qParams.set("search", search);

  const { data: invoices, isLoading, isError } = useQuery<Invoice[]>({
    queryKey: ["/api/tenant-invoices", activeSiteId, filterStatus, filterTenant, filterCompany, search],
    queryFn: () => apiFetch<Invoice[]>(`${BASE}/api/tenant-invoices?${qParams}`),
    refetchInterval: 30000,
    enabled: activeSiteId !== null,
  });

  const { data: tenants } = useQuery<Tenant[]>({
    queryKey: ["/api/tenants", activeSiteId],
    queryFn: () => apiFetch<Tenant[]>(`${BASE}/api/tenants`),
    enabled: activeSiteId !== null,
  });

  const { data: companies = [] } = useQuery<CompanyRow[]>({
    queryKey: ["/api/companies", activeSiteId],
    queryFn: () => apiFetch<CompanyRow[]>(`${BASE}/api/companies`),
    enabled: activeSiteId !== null,
  });

  const { data: bookings } = useQuery<Booking[]>({
    queryKey: ["/api/bookings", activeSiteId],
    queryFn: () => apiFetch<Booking[]>(`${BASE}/api/bookings`),
    enabled: activeSiteId !== null,
  });

  type PpnReportRow = {
    bulan: string;
    jumlah_invoice: number;
    total_subtotal: string;
    total_ppn: string;
    total_tagihan: string;
    total_terbayar: string;
  };
  type PpnTenantRow = {
    tenant_id: number;
    nama_tenant: string;
    nama_pemilik: string;
    unit: string;
    jumlah_invoice: number;
    total_subtotal: string;
    total_ppn: string;
    total_tagihan: string;
    total_terbayar: string;
  };
  type PpnReport = {
    from: string; to: string;
    rows: PpnReportRow[];
    totals: Partial<PpnReportRow>;
    byTenant: PpnTenantRow[];
  };

  const { data: ppnReport, isFetching: ppnLoading, refetch: refetchPpn } = useQuery<PpnReport>({
    queryKey: ["/api/tenant-invoices/ppn-report", activeSiteId, ppnFrom, ppnTo],
    queryFn: () => apiFetch<PpnReport>(`${BASE}/api/tenant-invoices/ppn-report?from=${ppnFrom}&to=${ppnTo}`),
    enabled: activeSiteId !== null && ppnOpen,
  });

  const { data: detailData, isLoading: detailLoading } = useQuery<Invoice>({
    queryKey: ["/api/tenant-invoices/detail", activeSiteId, detailTarget?.id],
    queryFn: () => apiFetch<Invoice>(`${BASE}/api/tenant-invoices/${detailTarget!.id}`),
    enabled: activeSiteId !== null && !!detailTarget,
  });

  const { data: waStatus, isLoading: waStatusLoading } = useQuery<{
    configured: boolean;
    connected: boolean | null;
    provider: string;
    message: string;
  }>({
    queryKey: ["/api/whatsapp/status"],
    queryFn: () => apiFetch(`${BASE}/api/whatsapp/status`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (data: object) => apiPost<Invoice>(`${BASE}/api/tenant-invoices`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      toast({ title: "Berhasil", description: "Invoice baru berhasil dibuat." });
      setCreateOpen(false);
    },
    onError: (e: Error) => toast({ title: "Gagal", description: e.message, variant: "destructive" }),
  });

  const bulkMutation = useMutation({
    mutationFn: (items: object[]) =>
      apiPost<{ results: { tenantId: number; invoiceNumber: string; success: boolean; error?: string }[]; succeeded: number; failed: number }>(
        `${BASE}/api/tenant-invoices/bulk`,
        items,
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      setBulkResult(res);
      if (res.failed === 0) {
        toast({ title: `${res.succeeded} Invoice Dibuat`, description: "Semua invoice berhasil dibuat." });
      } else {
        toast({
          title: `${res.succeeded} Berhasil, ${res.failed} Gagal`,
          description: "Beberapa invoice gagal dibuat. Lihat detail di dialog.",
          variant: "destructive",
        });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal", description: e.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: ({ bookingId, notes }: { bookingId: number; notes?: string }) =>
      apiPost<Invoice>(`${BASE}/api/tenant-invoices/generate-from-booking/${bookingId}`, { notes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      toast({ title: "Berhasil", description: "Invoice berhasil dibuat dari kontrak booking." });
      setGenerateOpen(false);
    },
    onError: (e: Error) => toast({ title: "Gagal", description: e.message, variant: "destructive" }),
  });

  const paymentMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: object }) =>
      apiPost<{ success: boolean; receiptNumber: string; invoiceStatus: string }>(`${BASE}/api/tenant-invoices/${id}/payment`, data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      toast({
        title: "Pembayaran Dicatat",
        description: `No. Kwitansi: ${res.receiptNumber} — Status: ${STATUS_LABEL[res.invoiceStatus as InvoiceStatus] ?? res.invoiceStatus}`,
      });
      setPaymentOpen(false);
      setPaymentTarget(null);
    },
    onError: (e: Error) => toast({ title: "Gagal", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => apiPost<Invoice>(`${BASE}/api/tenant-invoices/${id}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      toast({ title: "Invoice Dibatalkan", description: "Invoice telah berhasil dibatalkan." });
      setCancelTarget(null);
    },
    onError: (e: Error) => toast({ title: "Gagal", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetchBase(`${BASE}/api/tenant-invoices/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Gagal menghapus invoice");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      toast({ title: "Invoice Dihapus", description: "Invoice berhasil dihapus permanen." });
      setDeleteTarget(null);
    },
    onError: (e: Error) => {
      toast({ title: "Gagal Menghapus", description: e.message, variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: object }) =>
      apiPatch<Invoice>(`${BASE}/api/tenant-invoices/${id}`, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      queryClient.setQueryData(["/api/tenant-invoices/detail", activeSiteId, updated.id], updated);
      toast({ title: "Invoice Diperbarui", description: `${updated.invoiceNumber} berhasil disimpan.` });
      setEditOpen(false);
      setEditTarget(null);
      setEditForm(null);
    },
    onError: (e: Error) => toast({ title: "Gagal Menyimpan", description: e.message, variant: "destructive" }),
  });

  const waSendMutation = useMutation({
    mutationFn: ({ id, type }: { id: number; type: "send" | "overdue-reminder" }) =>
      apiPost<{ ok: boolean; skipped?: boolean; message: string }>(`${BASE}/api/whatsapp/invoice/${id}/${type}`, {}),
    onSuccess: (res) => {
      if (res.skipped) {
        toast({ title: "WA Tidak Terkirim", description: res.message, variant: "destructive" });
      } else {
        toast({ title: "WhatsApp Terkirim", description: res.message });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal Kirim WA", description: e.message, variant: "destructive" }),
  });

  const sendPdfMutation = useMutation({
    mutationFn: async (inv: Invoice) => {
      setSendingPdfId(inv.id);
      const blob = await generateInvoicePdfBlob(inv);
      const formData = new FormData();
      formData.append("pdf", blob, `${inv.invoiceNumber}.pdf`);
      const res = await fetch(`${BASE}/api/tenant-invoices/${inv.id}/send-pdf`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json() as { ok: boolean; skipped?: boolean; message?: string; error?: string; pdfUrl?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal kirim PDF");
      return data;
    },
    onSettled: () => setSendingPdfId(null),
    onSuccess: (res) => {
      if (res.skipped) {
        toast({ title: "PDF Digenerate", description: "FONNTE belum dikonfigurasi — PDF berhasil dibuat namun WA tidak terkirim.", variant: "destructive" });
      } else {
        toast({ title: "Invoice PDF Terkirim! 📄", description: res.message });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal Kirim PDF", description: e.message, variant: "destructive" }),
  });

  async function handleBulkSendPdf() {
    const toSend = filteredInvoices.filter(inv => selectedIds.has(inv.id) && inv.phone && inv.status !== "cancelled" && !isFutureInvoicePeriod(inv));
    if (toSend.length === 0) {
      toast({ title: "Tidak ada penerima", description: "Invoice yang dipilih tidak memiliki nomor HP tenant.", variant: "destructive" });
      return;
    }
    setBulkSendProgress({ current: 0, total: toSend.length, errors: 0 });
    let errors = 0;
    for (let i = 0; i < toSend.length; i++) {
      const inv = toSend[i]!;
      setBulkSendProgress({ current: i + 1, total: toSend.length, errors });
      try {
        const blob = await generateInvoicePdfBlob(inv);
        const formData = new FormData();
        formData.append("pdf", blob, `${inv.invoiceNumber}.pdf`);
        const res = await fetch(`${BASE}/api/tenant-invoices/${inv.id}/send-pdf`, {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
    }
    setBulkSendProgress(null);
    setSelectedIds(new Set());
    toast({
      title: errors === 0 ? "Blast PDF selesai! 🎉" : `Blast PDF: ${errors} gagal`,
      description: `${toSend.length - errors} dari ${toSend.length} invoice berhasil dikirim via WhatsApp.`,
      variant: errors > 0 ? "destructive" : "default",
    });
  }

  const sendLinkMutation = useMutation({
    mutationFn: (id: number) =>
      apiPost<{ ok: boolean; skipped?: boolean; pending?: boolean; waFailed?: boolean; error?: string; message?: string; paymentLink?: string | null }>(`${BASE}/api/whatsapp/invoice/${id}/send`, {}),
    onMutate: (id) => setSendingLinkId(id),
    onSettled: () => setSendingLinkId(null),
    onSuccess: (res) => {
      if (res.skipped) {
        if (res.paymentLink) {
          setLinkCopied(false);
          setPaymentLinkDialog({ link: res.paymentLink, message: "WhatsApp belum dikonfigurasi (FONNTE_TOKEN kosong).", mode: "wa-failed" });
        } else {
          toast({ title: "WA Tidak Terkirim", description: "FONNTE_TOKEN belum dikonfigurasi.", variant: "destructive" });
        }
      } else if (res.pending) {
        const pendingMessage = waStatus?.connected === true
          ? "Device WhatsApp terhubung, tetapi Fonnte masih menahan pesan ini di antrean. Tunggu beberapa saat lalu periksa riwayat pengiriman. Reconnect hanya diperlukan jika antrean tidak berkurang."
          : waStatus?.connected === false
            ? "Pesan diterima Fonnte tetapi belum diteruskan karena device sedang tidak terhubung. Reconnect device lalu periksa kembali antrean."
            : "Pesan diterima Fonnte tetapi masih berada di antrean. Periksa status device dan riwayat pengiriman sebelum mencoba kembali.";
        if (res.paymentLink) {
          setLinkCopied(false);
          setPaymentLinkDialog({ link: res.paymentLink, message: pendingMessage, mode: "wa-pending" });
        } else {
          toast({ title: "Masuk Antrian — Belum Terkirim", description: pendingMessage });
        }
      } else if (res.waFailed) {
        if (res.paymentLink) {
          setLinkCopied(false);
          setPaymentLinkDialog({ link: res.paymentLink, message: res.error ?? "Gagal kirim WA", mode: "wa-failed" });
        } else {
          toast({ title: "Gagal Kirim WA", description: res.error, variant: "destructive" });
        }
      } else {
        toast({ title: "Link Bayar Terkirim! 🔗", description: res.message });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal Kirim Link", description: e.message, variant: "destructive" }),
  });

  const copyLinkMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetch<{ link: string; invoiceNumber: string; error?: string }>(`${BASE}/api/tenant-invoices/${id}/payment-link`);
      return res;
    },
    onMutate: (id) => setCopyingLinkId(id),
    onSettled: () => setCopyingLinkId(null),
    onSuccess: (res) => {
      setLinkCopied(false);
      setPaymentLinkDialog({ link: res.link, mode: "manual" });
    },
    onError: (e: Error) => toast({ title: "Gagal Ambil Link", description: e.message, variant: "destructive" }),
  });

  const waBlastMutation = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; skipped?: boolean; sent: number; failed: number; total: number; message: string }>(`${BASE}/api/whatsapp/blast-overdue`, {}),
    onSuccess: (res) => {
      if (res.skipped) {
        toast({ title: "WA Tidak Terkirim", description: res.message, variant: "destructive" });
      } else {
        toast({ title: "Blast WA Selesai", description: res.message });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal Blast WA", description: e.message, variant: "destructive" }),
  });

  const blastLinkMutation = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; skipped?: boolean; sent: number; failed: number; total: number; message: string }>(`${BASE}/api/whatsapp/blast-link-unpaid`, {}),
    onSuccess: (res) => {
      if (res.skipped) {
        toast({ title: "Link Tidak Terkirim", description: res.message, variant: "destructive" });
      } else {
        toast({ title: "Blast Link Selesai 🔗", description: res.message });
      }
    },
    onError: (e: Error) => toast({ title: "Gagal Blast Link", description: e.message, variant: "destructive" }),
  });

  const recalcMutation = useMutation({
    mutationFn: (id: number) =>
      apiPost<Invoice>(`${BASE}/api/tenant-invoices/${id}/recalculate`, {}),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tenant-invoices/detail", activeSiteId, updated.id] });
      queryClient.setQueryData(["/api/tenant-invoices/detail", activeSiteId, updated.id], updated);
      toast({ title: "PPN Dihitung Ulang", description: `Invoice ${updated.invoiceNumber}: subtotal ${formatRupiah(updated.subtotal)} + PPN 11% ${formatRupiah(updated.taxAmount)} = ${formatRupiah(updated.totalAmount)}` });
    },
    onError: (e: Error) => toast({ title: "Gagal Hitung Ulang", description: e.message, variant: "destructive" }),
  });

  // ─── Blast Tagihan Scheduler ─────────────────────────────────────────────────

  type BlastStatusResp = {
    isRunning: boolean;
    lastRunAt: string | null;
    lastRunLabel: string | null;
    lastRunAtFormatted: string | null;
    scheduledTimesWib: string[];
    lastResult: {
      invoicesCreated: number;
      invoiceSent: number;
      reminderH7: number; // total pengingat harian tanggal 2-7
      overdueSent: number;
    } | null;
  };

  type BlastRun = {
    runAt: string;
    runAtFormatted: string;
    label: string;
    invoicesCreated: number;
    invoicesSent: number;
    reminderH7: number; // total pengingat harian tanggal 2-7
    overdueSent: number;
  };

  const { data: blastStatus, refetch: refetchBlastStatus } = useQuery<BlastStatusResp>({
    queryKey: ["/api/blast-tagihan/status"],
    queryFn: () => apiFetch<BlastStatusResp>(`${BASE}/api/blast-tagihan/status`),
    refetchInterval: 5000,
  });

  const blastTriggerMutation = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; message: string; startedAt: string }>(`${BASE}/api/blast-tagihan/trigger`, {}),
    onSuccess: (res) => {
      toast({ title: "Blast Tagihan Dimulai", description: res.message });
      setTimeout(() => { void refetchBlastStatus(); void refetchBlastHistory(); }, 3000);
    },
    onError: (e: Error) => toast({ title: "Gagal Trigger Blast", description: e.message, variant: "destructive" }),
  });

  const { data: blastHistoryData, refetch: refetchBlastHistory } = useQuery<{ ok: boolean; history: BlastRun[] }>({
    queryKey: ["/api/blast-tagihan/history"],
    queryFn: () => apiFetch<{ ok: boolean; history: BlastRun[] }>(`${BASE}/api/blast-tagihan/history`),
    refetchInterval: blastStatus?.isRunning ? 5000 : false,
  });

  // ─── Derived ────────────────────────────────────────────────────────────────

  const summary = useMemo(() => {
    const all = invoices ?? [];
    const activeReceivables = all.filter(isActiveReceivable);

    return {
      total: all.length,
      // "Belum Bayar" hanya invoice yang sudah memasuki periodenya.
      unpaid: activeReceivables.filter(i => i.status === "unpaid").length,
      overdue: activeReceivables.filter(i => i.status === "overdue").length,
      unpaidAll: activeReceivables.length,
      totalPaid: all.reduce((s, i) => s + Number(i.paidAmount ?? 0), 0),
      // Piutang aktif = periode berjalan + tunggakan lama.
      // Tenant nonaktif tetap dihitung karena daftar invoice tidak difilter status tenant.
      totalOutstanding: activeReceivables.reduce((s, i) => s + Number(i.outstandingAmount ?? 0), 0),
    };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const all = invoices ?? [];
    if (filterDueDate === "all") return all;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return all.filter(inv => {
      if (!inv.dueDate) return false;
      const due = new Date(inv.dueDate);
      due.setHours(0, 0, 0, 0);
      const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);

      if (filterDueDate === "overdue") return diffDays < 0;
      if (filterDueDate === "today")   return diffDays === 0;
      if (filterDueDate === "7")       return diffDays >= 0 && diffDays <= 7;
      if (filterDueDate === "14")      return diffDays >= 0 && diffDays <= 14;
      if (filterDueDate === "30")      return diffDays >= 0 && diffDays <= 30;
      return true;
    });
  }, [invoices, filterDueDate]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.tenantId) {
      toast({ title: "Validasi Gagal", description: "Tenant wajib dipilih.", variant: "destructive" });
      return;
    }

    if (createForm.bookingId && createForm.periodStart) {
      const duplicate = (invoices ?? []).find((inv) =>
        String(inv.bookingId ?? "") === createForm.bookingId &&
        (inv.periodStart ?? "").slice(0, 10) === createForm.periodStart
      );
      if (duplicate) {
        toast({
          title: "Invoice Sudah Ada",
          description: `${duplicate.invoiceNumber} sudah memakai booking dan periode mulai tersebut. Gunakan invoice yang sudah ada atau pilih periode lain.`,
          variant: "destructive",
        });
        return;
      }
    }

    createMutation.mutate({
      tenantId: Number(createForm.tenantId),
      bookingId: createForm.bookingId ? Number(createForm.bookingId) : null,
      unitCode: createForm.unitCode || null,
      periodStart: createForm.periodStart || null,
      periodEnd: createForm.periodEnd || null,
      dueDate: createForm.dueDate || null,
      rentAmount: createForm.rentAmount || "0",
      serviceChargeAmount: createForm.serviceChargeAmount || "0",
      electricityChargeAmount: createForm.electricityChargeAmount || "0",
      waterChargeAmount: createForm.waterChargeAmount || "0",
      otherChargeAmount: createForm.otherChargeAmount || "0",
      trashChargeAmount: createForm.trashChargeAmount || "0",
      discountAmount: createForm.discountAmount || "0",
      penaltyAmount: createForm.penaltyAmount || "0",
      usePpn: createForm.usePpn,
      notes: createForm.notes || null,
      status: createForm.status,
    });
  }

  async function handlePreviewCreate() {
    const tenant = (tenants ?? []).find(t => String(t.id) === createForm.tenantId);

    const rent     = Number(createForm.rentAmount             || 0);
    const service  = Number(createForm.serviceChargeAmount    || 0);
    const elec     = Number(createForm.electricityChargeAmount|| 0);
    const water    = Number(createForm.waterChargeAmount      || 0);
    const other    = Number(createForm.otherChargeAmount      || 0);
    const trash    = Number(createForm.trashChargeAmount      || 0);
    const discount = Number(createForm.discountAmount         || 0);
    const penalty  = Number(createForm.penaltyAmount          || 0);

    const subtotal = rent + service + elec + water + other + trash - discount + penalty;
    const taxAmt   = createForm.usePpn ? Math.round(rent * 0.11 / 1.11) : 0;
    const total    = subtotal;

    const draftInv: Invoice = {
      id: 0,
      invoiceNumber: "DRAFT-PREVIEW",
      siteId: activeSiteId ?? null,
      tenantId: Number(createForm.tenantId) || 0,
      bookingId: createForm.bookingId ? Number(createForm.bookingId) : null,
      unitCode: createForm.unitCode || null,
      periodStart: createForm.periodStart || null,
      periodEnd: createForm.periodEnd || null,
      dueDate: createForm.dueDate || null,
      rentAmount: String(rent),
      serviceChargeAmount: String(service),
      electricityChargeAmount: String(elec),
      waterChargeAmount: String(water),
      otherChargeAmount: String(other),
      trashChargeAmount: String(trash),
      discountAmount: String(discount),
      penaltyAmount: String(penalty),
      usePpn: createForm.usePpn,
      subtotal: String(subtotal),
      taxAmount: String(taxAmt),
      totalAmount: String(total),
      paidAmount: "0",
      outstandingAmount: String(total),
      status: createForm.status,
      notes: createForm.notes || null,
      invoiceNotifiedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tenantName: tenant?.businessName ?? null,
      ownerName: null,
      boothNumber: tenant?.boothNumber ?? null,
      areaName: null,
      email: null,
      phone: null,
      companyId: null,
      companyName: null,
    };

    const cfg = await fetchInvoiceConfig(activeSiteId ?? null);
    let html = buildInvoiceHtml(draftInv, cfg);

    // Watermark DRAFT di tengah halaman
    const draftCss = `
      body::before {
        content: 'DRAFT';
        position: fixed; top: 50%; left: 50%;
        transform: translate(-50%, -50%) rotate(-30deg);
        font-size: 130px; font-weight: 900;
        color: rgba(220,38,38,0.07); white-space: nowrap;
        pointer-events: none; z-index: 9999;
      }
    `;
    html = html.replace("</style>", draftCss + "</style>");

    // Banner peringatan di atas invoice
    const banner = `<div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:8px;padding:10px 18px;margin-bottom:22px;text-align:center;font-size:13px;color:#dc2626;font-weight:600">
      ⚠️ PREVIEW DRAFT — Invoice ini <u>belum disimpan</u>. Kembali ke portal admin dan klik <strong>Buat Invoice</strong> untuk menyimpan.
    </div>`;
    html = html.replace("<body>", "<body>" + banner);

    const win = window.open("", "_blank", "width=820,height=920");
    if (!win) {
      toast({ title: "Popup diblokir", description: "Izinkan popup di browser Anda untuk melihat preview invoice.", variant: "destructive" });
      return;
    }
    win.document.write(html);
    win.document.close();
  }

  function handleGenerateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!generateForm.bookingId) {
      toast({ title: "Validasi Gagal", description: "Booking wajib dipilih.", variant: "destructive" });
      return;
    }
    generateMutation.mutate({ bookingId: Number(generateForm.bookingId), notes: generateForm.notes || undefined });
  }

  function handlePaymentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paymentTarget) return;
    if (!paymentForm.amountPaid || Number(paymentForm.amountPaid) <= 0) {
      toast({ title: "Validasi Gagal", description: "Jumlah bayar harus lebih dari 0.", variant: "destructive" });
      return;
    }
    paymentMutation.mutate({
      id: paymentTarget.id,
      data: {
        amountPaid: Number(paymentForm.amountPaid),
        paymentMethod: paymentForm.paymentMethod,
        paymentDate: paymentForm.paymentDate || undefined,
        notes: paymentForm.notes || null,
      },
    });
  }

  function openPayment(inv: Invoice) {
    setPaymentTarget(inv);
    setPaymentForm({ ...EMPTY_PAYMENT, amountPaid: inv.outstandingAmount, paymentDate: todayStr() });
    setPaymentOpen(true);
  }

  function openDetail(inv: Invoice) {
    setDetailTarget(inv);
    setDetailOpen(true);
  }

  function openEdit(inv: Invoice) {
    setEditTarget(inv);
    setEditForm(invoiceToEditForm(inv));
    setDetailOpen(false);
    setEditOpen(true);
  }

  function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget || !editForm) return;
    patchMutation.mutate({
      id: editTarget.id,
      data: {
        unitCode: editForm.unitCode || null,
        periodStart: editForm.periodStart || null,
        periodEnd: editForm.periodEnd || null,
        dueDate: editForm.dueDate || null,
        rentAmount: editForm.rentAmount || "0",
        serviceChargeAmount: editForm.serviceChargeAmount || "0",
        electricityChargeAmount: editForm.electricityChargeAmount || "0",
        waterChargeAmount: editForm.waterChargeAmount || "0",
        otherChargeAmount: editForm.otherChargeAmount || "0",
        trashChargeAmount: editForm.trashChargeAmount || "0",
        discountAmount: editForm.discountAmount || "0",
        penaltyAmount: editForm.penaltyAmount || "0",
        usePpn: editForm.usePpn,
        status: editForm.status,
        notes: editForm.notes || null,
      },
    });
  }

  const BULAN_ID = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

  function applyBulkPeriod() {
    const { month, year } = bulkMonth;
    const pad = (n: number) => String(n).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    const dueMonth = month === 12 ? 1 : month + 1;
    const dueYear = month === 12 ? year + 1 : year;
    setBulkCommon(f => ({
      ...f,
      periodStart: `${year}-${pad(month)}-01`,
      periodEnd: `${year}-${pad(month)}-${pad(lastDay)}`,
      dueDate: `${dueYear}-${pad(dueMonth)}-14`,
    }));
  }

  function isActiveTenant(t: Tenant) {
    return t.status === "active" || t.status === "aktif";
  }

  function openBulkDialog() {
    const allTenants = tenants ?? [];
    const prices: Record<number, { unitCode: string; rentAmount: string; serviceChargeAmount: string; electricityChargeAmount: string; waterChargeAmount: string; otherChargeAmount: string; trashChargeAmount: string }> = {};
    for (const t of allTenants) {
      prices[t.id] = {
        unitCode: t.boothNumber ?? "",
        rentAmount: t.defaultRentAmount ?? "",
        serviceChargeAmount: t.defaultServiceChargeAmount ?? "",
        electricityChargeAmount: t.defaultElectricityChargeAmount ?? "",
        waterChargeAmount: t.defaultWaterChargeAmount ?? "",
        otherChargeAmount: t.defaultOtherChargeAmount ?? "",
        trashChargeAmount: t.defaultTrashChargeAmount ?? "",
      };
    }
    setBulkPrices(prices);
    const activeTenants = allTenants.filter(isActiveTenant);
    setBulkSelected(new Set((activeTenants.length > 0 ? activeTenants : allTenants).map((t) => t.id)));

    // Auto-isi periode bulan berjalan
    const nowD = new Date();
    const m = nowD.getMonth() + 1;
    const y = nowD.getFullYear();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const lastDay = new Date(y, m, 0).getDate();
    const dueM = m === 12 ? 1 : m + 1;
    const dueY = m === 12 ? y + 1 : y;
    setBulkMonth({ month: m, year: y });
    setBulkCommon({
      periodStart: `${y}-${pad2(m)}-01`,
      periodEnd: `${y}-${pad2(m)}-${pad2(lastDay)}`,
      dueDate: `${dueY}-${pad2(dueM)}-14`,
      status: "unpaid",
      notes: "",
    });
    setBulkExpanded(null);
    setBulkResult(null);
    setBulkOpen(true);
  }

  function handleBulkSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (bulkSelected.size === 0) {
      toast({ title: "Validasi Gagal", description: "Pilih minimal 1 tenant.", variant: "destructive" });
      return;
    }
    const items = Array.from(bulkSelected).map((tenantId) => {
      const p = bulkPrices[tenantId] ?? {};
      return {
        tenantId,
        unitCode: p.unitCode || null,
        periodStart: bulkCommon.periodStart || null,
        periodEnd: bulkCommon.periodEnd || null,
        dueDate: bulkCommon.dueDate || null,
        rentAmount: p.rentAmount || "0",
        serviceChargeAmount: p.serviceChargeAmount || "0",
        electricityChargeAmount: p.electricityChargeAmount || "0",
        waterChargeAmount: p.waterChargeAmount || "0",
        otherChargeAmount: p.otherChargeAmount || "0",
        trashChargeAmount: p.trashChargeAmount || "0",
        discountAmount: "0",
        penaltyAmount: "0",
        taxAmount: "0",
        notes: bulkCommon.notes || null,
        status: bulkCommon.status,
      };
    });
    bulkMutation.mutate(items);
  }

  function calcBulkTotal(tenantId: number): number {
    const p = bulkPrices[tenantId];
    if (!p) return 0;
    return (
      Number(p.rentAmount || 0) +
      Number(p.serviceChargeAmount || 0) +
      Number(p.electricityChargeAmount || 0) +
      Number(p.waterChargeAmount || 0) +
      Number(p.otherChargeAmount || 0) +
      Number(p.trashChargeAmount || 0)
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        {/* Baris atas: judul + badge WA */}
        <div className="flex items-start justify-between gap-2 min-w-0">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Invoice Tenant</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <p className="text-muted-foreground text-sm">Kelola tagihan dan pembayaran invoice tenant.</p>
              {/* Indikator status WhatsApp */}
              {!waStatusLoading && waStatus && (
                <span
                  title={waStatus.message}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium cursor-default select-none ${
                    !waStatus.configured
                      ? "border-gray-200 bg-gray-50 text-gray-500"
                      : waStatus.connected === true
                      ? "border-green-200 bg-green-50 text-green-700"
                      : waStatus.connected === false
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-yellow-200 bg-yellow-50 text-yellow-700"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    !waStatus.configured
                      ? "bg-gray-400"
                      : waStatus.connected === true
                      ? "bg-green-500"
                      : waStatus.connected === false
                      ? "bg-red-500 animate-pulse"
                      : "bg-yellow-500"
                  }`} />
                  WA {!waStatus.configured
                    ? "Tidak Dikonfigurasi"
                    : waStatus.connected === true
                    ? "Terhubung"
                    : waStatus.connected === false
                    ? "Terputus"
                    : "Tidak Diketahui"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Baris tombol aksi — selalu di bawah judul agar tidak sempit */}
        <div className="flex gap-2 flex-wrap items-center">
          {/* Kirim Link */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50"
            disabled={blastLinkMutation.isPending || summary.unpaidAll === 0}
            onClick={() => blastLinkMutation.mutate()}
            title={summary.unpaidAll === 0 ? "Tidak ada invoice belum lunas" : `Kirim link bayar ke ${summary.unpaidAll} invoice belum lunas`}
          >
            {blastLinkMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            {blastLinkMutation.isPending ? "Mengirim..." : `Kirim Link (${summary.unpaidAll})`}
          </Button>

          {/* Blast WA Overdue */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-green-300 text-green-700 hover:bg-green-50"
            disabled={waBlastMutation.isPending || summary.overdue === 0}
            onClick={() => waBlastMutation.mutate()}
            title={summary.overdue === 0 ? "Tidak ada invoice overdue" : `Kirim pengingat ke ${summary.overdue} invoice overdue`}
          >
            <Send className="h-3.5 w-3.5" />
            {waBlastMutation.isPending ? "Mengirim..." : `Blast WA Overdue (${summary.overdue})`}
          </Button>

          {/* Ekspor CSV */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              const params = new URLSearchParams();
              if (filterStatus !== "all") params.set("status", filterStatus);
              if (filterTenant !== "all") params.set("tenant_id", filterTenant);
              const url = `/api/tenant-invoices/export${params.toString() ? "?" + params.toString() : ""}`;
              const a = document.createElement("a");
              a.href = url;
              a.download = "";
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
            title="Ekspor semua invoice sesuai filter aktif ke CSV"
          >
            <Download className="h-3.5 w-3.5" />
            Ekspor CSV
          </Button>

          {/* Ekspor PDF */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-red-300 text-red-700 hover:bg-red-50"
            disabled={filteredInvoices.length === 0}
            onClick={() => {
              const now = new Date();
              const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
              const STATUS_LABEL: Record<string, string> = {
                all: "", draft: "Draft", unpaid: "Belum Bayar", partial: "Sebagian",
                paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan", sent: "Terkirim",
              };
              const parts: string[] = [];
              if (filterStatus !== "all") parts.push(`Status: ${STATUS_LABEL[filterStatus] ?? filterStatus}`);
              if (search) parts.push(`Cari: "${search}"`);
              const filterLabel = parts.length ? parts.join("  •  ") : undefined;
              void exportInvoicesToPDF(filteredInvoices, `laporan-invoice-${stamp}.pdf`, filterLabel, activeSite?.companyName);
            }}
            title={filteredInvoices.length === 0 ? "Tidak ada data untuk diekspor" : `Ekspor ${filteredInvoices.length} invoice ke PDF`}
          >
            <FileText className="h-3.5 w-3.5" />
            Ekspor PDF ({filteredInvoices.length})
          </Button>

          {/* Dropdown: Laporan PPN, Invoice Massal, Generate */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5">
                <BarChart2 className="h-3.5 w-3.5" />
                Lainnya
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuItem onClick={() => setPpnOpen(true)} className="gap-2">
                <BarChart2 className="h-4 w-4 text-emerald-600" />
                Laporan PPN
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={openBulkDialog}
                disabled={!tenants || tenants.length === 0}
                className="gap-2"
              >
                <Layers className="h-4 w-4 text-violet-600" />
                Invoice Massal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => { setGenerateForm({ bookingId: "", notes: "" }); setGenerateOpen(true); }}
                className="gap-2"
              >
                <Zap className="h-4 w-4 text-amber-600" />
                Generate dari Booking
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Buat Invoice — tombol utama */}
          <Button size="sm" onClick={() => { setCreateForm(EMPTY_FORM); setCreateOpen(true); }} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Buat Invoice
          </Button>
        </div>
      </div>

      {/* ── Panel Blast Tagihan Otomatis ─────────────────────────────────────── */}
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          {/* Info jadwal */}
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100">
              <Send className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-900">Blast Tagihan Otomatis via WhatsApp</p>
              <p className="mt-0.5 text-xs text-blue-700">
                Setiap awal bulan, sistem otomatis mengirim tagihan + link bayar ke semua tenant pada{" "}
                <span className="font-semibold">08:00 WIB</span>.
                Reminder H-7, H-3, H-1 jatuh tempo dan pengingat overdue juga dikirim otomatis.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {blastStatus?.scheduledTimesWib?.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    <Clock className="h-3 w-3" />
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Status + Tombol */}
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            {/* Status terakhir */}
            <div className="flex items-center gap-2">
              {blastStatus?.isRunning ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-medium text-yellow-800">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Sedang berjalan...
                </span>
              ) : blastStatus?.lastRunAtFormatted ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
                  <CheckCircle2 className="h-3 w-3" />
                  Terakhir: {blastStatus.lastRunAtFormatted}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                  <Clock className="h-3 w-3" />
                  Belum pernah dijalankan
                </span>
              )}
            </div>

            {/* Tombol trigger manual */}
            <Button
              size="sm"
              className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
              disabled={blastTriggerMutation.isPending || blastStatus?.isRunning}
              onClick={() => blastTriggerMutation.mutate()}
              title="Kirim tagihan + pengingat sekarang ke semua tenant yang belum bayar"
            >
              {blastTriggerMutation.isPending || blastStatus?.isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {blastTriggerMutation.isPending || blastStatus?.isRunning
                ? "Mengirim..."
                : "Kirim Sekarang"}
            </Button>
          </div>
        </div>

        {/* Keterangan alur notifikasi */}
        <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-blue-200 pt-3 sm:grid-cols-4">
          {[
            { icon: <MessageCircle className="h-3.5 w-3.5" />, label: "Tagihan Baru", desc: "Awal periode (hari ini)" },
            { icon: <Clock className="h-3.5 w-3.5" />, label: "Pengingat H-7", desc: "7 hari sebelum jatuh tempo" },
            { icon: <Clock className="h-3.5 w-3.5" />, label: "Pengingat H-3 & H-1", desc: "3 & 1 hari sebelum jatuh tempo" },
            { icon: <AlertCircle className="h-3.5 w-3.5" />, label: "Peringatan Overdue", desc: "Setelah melewati jatuh tempo" },
          ].map(({ icon, label, desc }) => (
            <div key={label} className="flex items-start gap-1.5 rounded-lg bg-white/70 p-2">
              <span className="mt-0.5 text-blue-500">{icon}</span>
              <div>
                <p className="text-[11px] font-semibold text-blue-900">{label}</p>
                <p className="text-[10px] text-blue-600">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Histori Blast ─────────────────────────────────────────────────── */}
        {(blastHistoryData?.history?.length ?? 0) > 0 && (
          <div className="mt-3 border-t border-blue-200 pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
              Histori Pengiriman (sesi terakhir)
            </p>
            <div className="overflow-x-auto rounded-lg border border-blue-100">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-blue-100/60 text-left text-blue-800">
                    <th className="px-2.5 py-1.5 font-semibold">Waktu (WIB)</th>
                    <th className="px-2.5 py-1.5 font-semibold text-center">Invoice Dibuat</th>
                    <th className="px-2.5 py-1.5 font-semibold text-center">WA Terkirim</th>
                    <th className="px-2.5 py-1.5 font-semibold text-center">Pengingat Harian</th>
                    <th className="px-2.5 py-1.5 font-semibold text-center">Overdue</th>
                    <th className="px-2.5 py-1.5 font-semibold text-blue-600">Pemicu</th>
                  </tr>
                </thead>
                <tbody>
                  {blastHistoryData?.history.map((run, idx) => (
                    <tr key={run.runAt} className={idx % 2 === 0 ? "bg-white" : "bg-blue-50/40"}>
                      <td className="px-2.5 py-1.5 font-medium text-blue-900 whitespace-nowrap">{run.runAtFormatted}</td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className={`font-semibold ${run.invoicesCreated > 0 ? "text-green-700" : "text-gray-400"}`}>
                          {run.invoicesCreated}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className={`font-semibold ${run.invoicesSent > 0 ? "text-blue-700" : "text-gray-400"}`}>
                          {run.invoicesSent}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-center text-gray-600">{run.reminderH7 || "-"}</td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className={run.overdueSent > 0 ? "font-semibold text-orange-600" : "text-gray-400"}>
                          {run.overdueSent || "-"}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-blue-500 truncate max-w-[120px]" title={run.label}>
                        {run.label.startsWith("manual") ? "👆 Manual" : "🕐 Otomatis"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[10px] text-blue-500">
              * Histori disimpan di memori server — akan kosong kembali setelah server restart.
            </p>
          </div>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {[
          { label: "Total Invoice", value: summary.total, sub: "semua status" },
          { label: "Total Terbayar", value: formatRupiah(summary.totalPaid), sub: "sudah diterima", accent: "green" },
          { label: "Belum Bayar", value: summary.unpaid, sub: "perlu tindakan", accent: "orange" },
          { label: "Jatuh Tempo", value: summary.overdue, sub: "segera bayar", accent: "red" },
          { label: "Total Tunggakan", value: formatRupiah(summary.totalOutstanding), sub: "outstanding", accent: "red" },
        ].map((item) => (
          <Card key={item.label}>
            <CardContent className="pt-5 pb-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{item.label}</p>
              <p className={`text-xl font-bold mt-1 ${
                item.accent === "red"
                  ? "text-red-500"
                  : item.accent === "orange"
                  ? "text-orange-500"
                  : item.accent === "green"
                  ? "text-green-600"
                  : ""
              }`}>
                {item.value}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{item.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3">
            <CardTitle>Daftar Invoice</CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8 w-48 h-9"
                  placeholder="Cari invoice / tenant..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-44 h-9"><SelectValue placeholder="Semua Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Status</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="unpaid">Belum Bayar</SelectItem>
                  <SelectItem value="partial">Sebagian</SelectItem>
                  <SelectItem value="paid">Lunas</SelectItem>
                  <SelectItem value="overdue">Jatuh Tempo</SelectItem>
                  <SelectItem value="cancelled">Dibatalkan</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterTenant} onValueChange={setFilterTenant}>
                <SelectTrigger className="w-44 h-9"><SelectValue placeholder="Semua Tenant" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Tenant</SelectItem>
                  {(tenants ?? []).map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.businessName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterCompany} onValueChange={setFilterCompany}>
                <SelectTrigger className="w-56 h-9"><SelectValue placeholder="Semua Perusahaan" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Perusahaan</SelectItem>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.companyName ?? c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterDueDate} onValueChange={setFilterDueDate}>
                <SelectTrigger className="w-48 h-9"><SelectValue placeholder="Semua Tanggal" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Tanggal</SelectItem>
                  <SelectItem value="overdue">⚠️ Sudah lewat jatuh tempo</SelectItem>
                  <SelectItem value="today">📅 Jatuh tempo hari ini</SelectItem>
                  <SelectItem value="7">⏰ Jatuh tempo ≤ 7 hari</SelectItem>
                  <SelectItem value="14">⏰ Jatuh tempo ≤ 14 hari</SelectItem>
                  <SelectItem value="30">📆 Jatuh tempo ≤ 30 hari</SelectItem>
                </SelectContent>
              </Select>
              {filterDueDate !== "all" && (
                <button
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground h-9 px-1"
                  onClick={() => setFilterDueDate("all")}
                >
                  Reset tanggal
                </button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isError && (
            <p className="text-sm text-destructive py-4 text-center">Gagal memuat data invoice. Periksa koneksi server.</p>
          )}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-violet-50 border border-violet-200 rounded-lg mb-3 flex-wrap">
              <span className="text-sm font-medium text-violet-800">
                {selectedIds.size} invoice dipilih
                {Array.from(selectedIds).filter(id => !filteredInvoices.find(inv => inv.id === id && inv.phone)).length > 0 && (
                  <span className="text-violet-500 font-normal ml-1">
                    ({Array.from(selectedIds).filter(id => filteredInvoices.find(inv => inv.id === id && inv.phone)).length} dengan nomor HP)
                  </span>
                )}
              </span>
              <Button
                size="sm"
                className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white h-8"
                disabled={bulkSendProgress !== null}
                onClick={() => void handleBulkSendPdf()}
              >
                {bulkSendProgress !== null
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Mengirim {bulkSendProgress.current}/{bulkSendProgress.total}...</>
                  : <><Send className="h-3.5 w-3.5" />Blast PDF ke WA ({filteredInvoices.filter(inv => selectedIds.has(inv.id) && inv.phone && inv.status !== "cancelled" && !isFutureInvoicePeriod(inv)).length})</>
                }
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-violet-600 hover:text-violet-800 h-8"
                disabled={bulkSendProgress !== null}
                onClick={() => setSelectedIds(new Set())}
              >
                Batalkan pilihan
              </Button>
            </div>
          )}
          {isMobile ? (
          <div className="space-y-2">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl border bg-card p-3">
                  <Skeleton className="h-4 w-40 mb-2" />
                  <Skeleton className="h-3 w-full mb-2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))
            ) : filteredInvoices.length === 0 ? (
              <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
                {filterDueDate !== "all" ? "Tidak ada invoice untuk filter tanggal ini." : "Belum ada invoice."}
              </div>
            ) : (
              filteredInvoices.map((inv) => {
                const future = isFutureInvoicePeriod(inv);
                const outstanding = effectiveOutstanding(inv);
                return (
                  <div
                    key={inv.id}
                    className={`rounded-xl border bg-card p-3 shadow-sm ${selectedIds.has(inv.id) ? "border-violet-300 bg-violet-50/40" : ""}`}
                    onClick={() => openDetail(inv)}
                  >
                    <div className="flex items-start gap-2">
                      {inv.phone ? (
                        <Checkbox
                          checked={selectedIds.has(inv.id)}
                          onCheckedChange={(checked) => {
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              if (checked) next.add(inv.id); else next.delete(inv.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Pilih invoice ${inv.invoiceNumber}`}
                          className="mt-1"
                        />
                      ) : <div className="w-4" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-mono text-xs font-semibold truncate">{inv.invoiceNumber}</p>
                            <p className="font-medium truncate">{inv.tenantName ?? "-"}</p>
                            <p className="text-xs text-muted-foreground truncate">{inv.unitCode ?? inv.boothNumber ?? "—"} · {formatPeriod(inv.periodStart, inv.periodEnd)}</p>
                          </div>
                          {future ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                              <Clock className="h-3 w-3" />Akan Datang
                            </span>
                          ) : (
                            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[inv.status]}`}>
                              {STATUS_ICON[inv.status]}{STATUS_LABEL[inv.status]}
                            </span>
                          )}
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-muted/35 p-2 text-xs">
                          <div>
                            <p className="text-muted-foreground">Total</p>
                            <p className="font-semibold">{formatRupiah(inv.totalAmount)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Terbayar</p>
                            <p className="font-semibold text-green-600">{formatRupiah(inv.paidAmount)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Sisa</p>
                            <p className={`font-semibold ${future || inv.status === "cancelled" ? "text-muted-foreground" : outstanding > 0 ? "text-orange-600" : "text-green-600"}`}>
                              {inv.status === "cancelled" ? "Nonaktif" : future ? "Belum aktif" : formatRupiah(outstanding)}
                            </p>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>Jatuh tempo: {formatDate(inv.dueDate)}</span>
                          <span>{inv.invoiceNotifiedAt ? "WA terkirim" : "WA belum"}</span>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t pt-2" onClick={(e) => e.stopPropagation()}>
                          {!future && inv.status !== "paid" && inv.status !== "cancelled" && (
                            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => openPayment(inv)}>
                              <CreditCard className="h-3.5 w-3.5 mr-1" />Bayar
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => { void viewOrPrintInvoice(inv, "view"); }}>
                            <Eye className="h-3.5 w-3.5 mr-1" />Lihat
                          </Button>
                          {!future && inv.status !== "paid" && inv.status !== "cancelled" && inv.phone && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-xs text-emerald-700"
                              disabled={sendingLinkId === inv.id}
                              onClick={() => sendLinkMutation.mutate(inv.id)}
                            >
                              {sendingLinkId === inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5 mr-1" />}
                              Tagih
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    {filteredInvoices.some(inv => inv.phone) && (
                      <Checkbox
                        checked={
                          filteredInvoices.filter(inv => inv.phone).length > 0 &&
                          filteredInvoices.filter(inv => inv.phone).every(inv => selectedIds.has(inv.id))
                        }
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedIds(new Set(filteredInvoices.filter(inv => inv.phone).map(inv => inv.id)));
                          } else {
                            setSelectedIds(new Set());
                          }
                        }}
                        aria-label="Pilih semua invoice"
                      />
                    )}
                  </TableHead>
                  <TableHead className="min-w-[180px]">No. Invoice</TableHead>
                  <TableHead className="min-w-[140px]">Tenant</TableHead>
                  <TableHead className="min-w-[160px]">Perusahaan</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="min-w-[120px]">Periode</TableHead>
                  <TableHead className="min-w-[100px]">Jatuh Tempo</TableHead>
                  <TableHead className="min-w-[110px]">Total</TableHead>
                  <TableHead className="min-w-[110px]">Terbayar</TableHead>
                  <TableHead className="min-w-[110px]">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="min-w-[120px]">WA Dikirim</TableHead>
                  <TableHead className="w-[220px] text-right">Aksi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 12 }).map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                  : filteredInvoices.length === 0
                  ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center py-10 text-muted-foreground">
                        <FileText className="h-10 w-10 mx-auto mb-2 opacity-20" />
                        {filterDueDate !== "all"
                          ? <p>Tidak ada invoice untuk filter tanggal ini.</p>
                          : <><p>Belum ada invoice.</p><p className="text-xs mt-1">Klik "Generate dari Booking" untuk membuat invoice otomatis.</p></>
                        }
                      </TableCell>
                    </TableRow>
                  )
                  : filteredInvoices.map((inv) => {
                    const isFuturePeriod = isFutureInvoicePeriod(inv);
                    return (
                    <TableRow
                      key={inv.id}
                      className={`cursor-pointer hover:bg-muted/30 ${selectedIds.has(inv.id) ? "bg-violet-50/60" : ""}`}
                      onClick={() => openDetail(inv)}
                    >
                      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                        {inv.phone ? (
                          <Checkbox
                            checked={selectedIds.has(inv.id)}
                            onCheckedChange={(checked) => {
                              setSelectedIds(prev => {
                                const next = new Set(prev);
                                if (checked) next.add(inv.id); else next.delete(inv.id);
                                return next;
                              });
                            }}
                            aria-label={`Pilih invoice ${inv.invoiceNumber}`}
                          />
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-medium">{inv.invoiceNumber}</TableCell>
                      <TableCell>
                        <p className="font-medium">{inv.tenantName ?? "-"}</p>
                        <p className="text-xs text-muted-foreground">{inv.ownerName ?? ""}</p>
                      </TableCell>
                      <TableCell>
                        {inv.companyName ? (
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                            inv.companyId === 4 ? "bg-amber-50 text-amber-700 border-amber-200" :
                            inv.companyId === 1 ? "bg-blue-50 text-blue-700 border-blue-200" :
                            "bg-gray-50 text-gray-700 border-gray-200"
                          }`} title={inv.companyName}>
                            {inv.companyName}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">-</span>}
                      </TableCell>
                      <TableCell className="text-sm">{inv.unitCode ?? (inv.boothNumber ?? "-")}</TableCell>
                      <TableCell className="text-sm">{formatPeriod(inv.periodStart, inv.periodEnd)}</TableCell>
                      <TableCell className="text-sm">{formatDate(inv.dueDate)}</TableCell>
                      <TableCell className="text-sm font-medium">{formatRupiah(inv.totalAmount)}</TableCell>
                      <TableCell className="text-sm text-green-600">{formatRupiah(inv.paidAmount)}</TableCell>
                      <TableCell className={`text-sm font-semibold ${inv.status === "cancelled" || isFuturePeriod ? "text-muted-foreground" : effectiveOutstanding(inv) > 0 ? "text-orange-600" : "text-green-600"}`}>
                        {inv.status === "cancelled"
                          ? "Tidak menjadi piutang"
                          : isFuturePeriod
                            ? "Belum menjadi piutang"
                            : formatRupiah(effectiveOutstanding(inv))}
                      </TableCell>
                      <TableCell>
                        {isFuturePeriod ? (
                          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium bg-slate-50 text-slate-600 border-slate-200">
                            <Clock className="h-3.5 w-3.5" />
                            Akan Datang
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[inv.status]}`}>
                            {STATUS_ICON[inv.status]}
                            {STATUS_LABEL[inv.status]}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {inv.invoiceNotifiedAt ? (
                          <span className="inline-flex items-center gap-1 text-green-700" title={`WA terkirim: ${new Date(inv.invoiceNotifiedAt).toLocaleString("id-ID")}`}>
                            <CheckCheck className="h-3.5 w-3.5 flex-shrink-0" />
                            {new Date(inv.invoiceNotifiedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <MessageCircle className="h-3.5 w-3.5 flex-shrink-0" />
                            Belum
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {!isFuturePeriod && inv.status !== "paid" && inv.status !== "cancelled" && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" onClick={() => openPayment(inv)}>
                              <CreditCard className="h-3 w-3" />
                              Bayar
                            </Button>
                          )}
                          {!isFuturePeriod && inv.status !== "paid" && inv.status !== "cancelled" && inv.phone && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800"
                              title="Kirim link upload bukti bayar via WhatsApp"
                              disabled={sendingLinkId === inv.id}
                              onClick={() => sendLinkMutation.mutate(inv.id)}
                            >
                              {sendingLinkId === inv.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <Link2 className="h-3 w-3" />
                              }
                              Kirim Link
                            </Button>
                          )}
                          {!isFuturePeriod && inv.status !== "paid" && inv.status !== "cancelled" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs gap-1 text-blue-700 border-blue-200 hover:bg-blue-50 hover:text-blue-800"
                              title="Pratinjau & salin link bayar untuk dikirim manual"
                              disabled={copyingLinkId === inv.id}
                              onClick={() => copyLinkMutation.mutate(inv.id)}
                            >
                              {copyingLinkId === inv.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <Copy className="h-3 w-3" />
                              }
                              Salin Link
                            </Button>
                          )}
                          {!isFuturePeriod && inv.status !== "paid" && inv.status !== "cancelled" && inv.phone && (
                            <Button
                              size="sm" variant="ghost"
                              className={`h-7 w-7 p-0 ${inv.status === "overdue" ? "text-red-500 hover:text-red-600" : "text-emerald-600 hover:text-emerald-700"}`}
                              title={inv.status === "overdue" ? "Kirim pengingat overdue via WA" : "Kirim ulang notifikasi tagihan via WA"}
                              disabled={waSendMutation.isPending}
                              onClick={() => waSendMutation.mutate({ id: inv.id, type: inv.status === "overdue" ? "overdue-reminder" : "send" })}
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800" title="Lihat invoice" onClick={() => { void viewOrPrintInvoice(inv, "view"); }}>
                            <Eye className="h-3 w-3" />
                            Lihat
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700"
                            title="Download PDF"
                            disabled={downloadingId === inv.id}
                            onClick={() => {
                              void downloadInvoicePdf(
                                inv,
                                () => setDownloadingId(inv.id),
                                () => setDownloadingId(null),
                              );
                            }}
                          >
                            {downloadingId === inv.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Download className="h-3.5 w-3.5" />
                            }
                          </Button>
                          {inv.phone && inv.status !== "cancelled" && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-7 w-7 p-0 text-violet-600 hover:text-violet-700"
                              title="Kirim Invoice PDF ke WhatsApp tenant"
                              disabled={sendingPdfId === inv.id}
                              onClick={() => sendPdfMutation.mutate(inv)}
                            >
                              {sendingPdfId === inv.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Send className="h-3.5 w-3.5" />
                              }
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Print" onClick={() => { void viewOrPrintInvoice(inv, "print"); }}>
                            <Printer className="h-3.5 w-3.5" />
                          </Button>
                          {!isFuturePeriod && inv.status !== "paid" && inv.status !== "cancelled" && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Batalkan" onClick={() => setCancelTarget(inv)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.status !== "paid" && inv.status !== "cancelled" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                              title="Hapus invoice permanen"
                              onClick={() => setDeleteTarget(inv)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    );
                  })
                }
              </TableBody>
            </Table>
          </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Dialog: Create Invoice ───────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-2xl sm:w-auto">
          <DialogHeader>
            <DialogTitle>Buat Invoice Baru</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh] pr-2">
            <form id="create-invoice-form" onSubmit={handleCreateSubmit} className="flex flex-col gap-4 py-1">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Tenant" required>
                  <Select
                    value={createForm.tenantId}
                    onValueChange={(v) => {
                      const tenant = (tenants ?? []).find(t => String(t.id) === v);
                      setCreateForm(f => ({
                        ...f,
                        tenantId: v,
                        bookingId: "",
                        unitCode: tenant?.boothNumber ?? "",
                        periodStart: "",
                        periodEnd: "",
                        dueDate: "",
                        rentAmount: tenant?.defaultRentAmount ?? "",
                        serviceChargeAmount: tenant?.defaultServiceChargeAmount ?? "",
                        electricityChargeAmount: tenant?.defaultElectricityChargeAmount ?? "",
                        waterChargeAmount: tenant?.defaultWaterChargeAmount ?? "",
                        otherChargeAmount: tenant?.defaultOtherChargeAmount ?? "",
                        trashChargeAmount: tenant?.defaultTrashChargeAmount ?? "",
                      }));
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Pilih tenant..." /></SelectTrigger>
                    <SelectContent>
                      {(tenants ?? []).map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>{t.businessName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Kontrak / Booking">
                  <Select
                    value={createForm.bookingId}
                    onValueChange={(v) => {
                      if (v === "__clear__") {
                        setCreateForm(f => ({ ...f, bookingId: "" }));
                        return;
                      }
                      const bk = (bookings ?? []).find(b => String(b.id) === v);
                      setCreateForm(f => ({
                        ...f,
                        bookingId: v,
                        unitCode: bk?.unitCode ?? "",
                        periodStart: bk?.startDate ? bk.startDate.slice(0, 10) : "",
                        periodEnd: bk?.endDate ? bk.endDate.slice(0, 10) : "",
                        dueDate: bk?.dueDate ? bk.dueDate.slice(0, 10) : "",
                        rentAmount: bk?.rentAmount ? String(bk.rentAmount) : "",
                        serviceChargeAmount: bk?.serviceChargeAmount ? String(bk.serviceChargeAmount) : "",
                        electricityChargeAmount: bk?.electricityChargeAmount ? String(bk.electricityChargeAmount) : "",
                        waterChargeAmount: bk?.waterChargeAmount ? String(bk.waterChargeAmount) : "",
                        otherChargeAmount: bk?.otherChargeAmount ? String(bk.otherChargeAmount) : "",
                        trashChargeAmount: f.trashChargeAmount,
                      }));
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Pilih booking (opsional)..." /></SelectTrigger>
                    <SelectContent>
                      {createForm.bookingId && (
                        <SelectItem value="__clear__" className="text-muted-foreground italic">
                          — Kosongkan pilihan —
                        </SelectItem>
                      )}
                      {(bookings ?? [])
                        .filter(b => !createForm.tenantId || String(b.tenantId) === createForm.tenantId)
                        .map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {b.contractNumber ?? b.orderNumber ?? `#${b.id}`}
                            {b.tenantName ? ` — ${b.tenantName}` : ""}
                            {b.unitCode ? ` (${b.unitCode})` : ""}
                          </SelectItem>
                        ))}
                      {(bookings ?? []).filter(b => !createForm.tenantId || String(b.tenantId) === createForm.tenantId).length === 0 && (
                        <div className="px-3 py-2 text-sm text-muted-foreground">
                          {createForm.tenantId ? "Tidak ada booking untuk tenant ini" : "Belum ada data booking"}
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Unit / Kode">
                  <Input value={createForm.unitCode} onChange={e => setCreateForm(f => ({ ...f, unitCode: e.target.value }))} placeholder="A-01" />
                </Field>
                <Field label="Periode Mulai">
                  <Input type="date" value={createForm.periodStart} onChange={e => setCreateForm(f => ({ ...f, periodStart: e.target.value }))} />
                </Field>
                <Field label="Periode Selesai">
                  <Input type="date" value={createForm.periodEnd} onChange={e => setCreateForm(f => ({ ...f, periodEnd: e.target.value }))} />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Jatuh Tempo">
                  <Input type="date" value={createForm.dueDate} onChange={e => setCreateForm(f => ({ ...f, dueDate: e.target.value }))} />
                </Field>
                <Field label="Status Awal">
                  <Select value={createForm.status} onValueChange={(v) => setCreateForm(f => ({ ...f, status: v as InvoiceStatus }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="unpaid">Belum Bayar</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Komponen Tagihan</p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Harga Sewa">
                  <Input type="number" min="0" value={createForm.rentAmount} onChange={e => setCreateForm(f => ({ ...f, rentAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Service Charge">
                  <Input type="number" min="0" value={createForm.serviceChargeAmount} onChange={e => setCreateForm(f => ({ ...f, serviceChargeAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Biaya Listrik">
                  <Input type="number" min="0" value={createForm.electricityChargeAmount} onChange={e => setCreateForm(f => ({ ...f, electricityChargeAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Biaya Air">
                  <Input type="number" min="0" value={createForm.waterChargeAmount} onChange={e => setCreateForm(f => ({ ...f, waterChargeAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Biaya Lain-lain">
                  <Input type="number" min="0" value={createForm.otherChargeAmount} onChange={e => setCreateForm(f => ({ ...f, otherChargeAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Iuran Sampah / Kebersihan">
                  <Input type="number" min="0" value={createForm.trashChargeAmount} onChange={e => setCreateForm(f => ({ ...f, trashChargeAmount: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Diskon">
                  <Input type="number" min="0" value={createForm.discountAmount} onChange={e => setCreateForm(f => ({ ...f, discountAmount: e.target.value }))} placeholder="0" />
                </Field>
              </div>

              {/* Toggle PPN */}
              <div className={`flex items-center justify-between rounded-lg border p-3 ${createForm.usePpn ? "border-blue-200 bg-blue-50/60" : "border-slate-200 bg-slate-50"}`}>
                <div>
                  <p className="text-sm font-medium">Gunakan PPN 11%</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {createForm.usePpn ? "Harga Sewa sudah termasuk PPN — PPN diekstrak dari dalam (tax-inclusive)" : "Tidak ada PPN — total tagihan = subtotal saja"}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={createForm.usePpn}
                  onClick={() => setCreateForm(f => ({ ...f, usePpn: !f.usePpn }))}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${createForm.usePpn ? "bg-blue-600" : "bg-slate-300"}`}
                >
                  <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${createForm.usePpn ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>

              {/* PPN Preview */}
              {(() => {
                const sub = (Number(createForm.rentAmount||0)+Number(createForm.serviceChargeAmount||0)+Number(createForm.electricityChargeAmount||0)+Number(createForm.waterChargeAmount||0)+Number(createForm.otherChargeAmount||0)+Number(createForm.trashChargeAmount||0))-Number(createForm.discountAmount||0);
                // Tax-inclusive: PPN diekstrak dari dalam Harga Sewa (rent × 11/111)
                // Total = subtotal (PPN sudah di dalam, TIDAK ditambahkan lagi)
                const ppn = createForm.usePpn ? Math.round(Number(createForm.rentAmount||0) * 0.11 / 1.11) : 0;
                const dpp = Number(createForm.rentAmount||0) - ppn;
                const total = sub; // PPN sudah termasuk, tidak ditambah
                return sub > 0 ? (
                  <div className={`rounded-md border p-3 text-sm space-y-1 ${createForm.usePpn ? "bg-blue-50 border-blue-100" : "bg-slate-50 border-slate-200"}`}>
                    <p className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${createForm.usePpn ? "text-blue-700" : "text-slate-600"}`}>Ringkasan Tagihan</p>
                    <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{formatRupiah(String(sub))}</span></div>
                    {createForm.usePpn && (
                      <>
                        <div className="flex justify-between text-xs text-muted-foreground/70 italic"><span>DPP (Harga Sewa belum PPN)</span><span>{formatRupiah(String(dpp))}</span></div>
                        <div className="flex justify-between text-blue-600 text-xs"><span>PPN 11% (diekstrak dari Harga Sewa)</span><span>{formatRupiah(String(ppn))}</span></div>
                      </>
                    )}
                    <div className={`flex justify-between font-bold text-base border-t pt-1 mt-1 ${createForm.usePpn ? "border-blue-200" : "border-slate-200"}`}><span>Total</span><span>{formatRupiah(String(total))}</span></div>
                  </div>
                ) : null;
              })()}

              <Field label="Catatan">
                <Textarea value={createForm.notes} onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Catatan tambahan (opsional)" />
              </Field>
            </form>
          </ScrollArea>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Batal</Button>
            <div className="flex gap-2 sm:ml-auto">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handlePreviewCreate()}
                disabled={!createForm.tenantId}
                title="Lihat tampilan invoice sebelum disimpan"
              >
                👁 Preview
              </Button>
              <Button type="submit" form="create-invoice-form" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Menyimpan..." : "Buat Invoice"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Generate from Booking ────────────────────────────────────── */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Generate Invoice dari Booking
            </DialogTitle>
          </DialogHeader>
          <form id="generate-form" onSubmit={handleGenerateSubmit} className="flex flex-col gap-4 py-1">
            <Field label="Pilih Kontrak / Booking" required>
              <Select value={generateForm.bookingId} onValueChange={(v) => setGenerateForm(f => ({ ...f, bookingId: v }))}>
                <SelectTrigger><SelectValue placeholder="Pilih booking aktif..." /></SelectTrigger>
                <SelectContent>
                  {(bookings ?? [])
                    .filter(b => b !== null)
                    .map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.contractNumber ?? `#${b.id}`} — {b.tenantName ?? ""} {b.unitCode ? `(${b.unitCode})` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground bg-blue-50 border border-blue-100 rounded-md p-3">
              Invoice akan dibuat otomatis berdasarkan billing cycle dan tarif dari booking yang dipilih. Periode tagihan akan dihitung untuk bulan/kuartal/tahun berjalan.
            </p>
            <Field label="Catatan">
              <Textarea value={generateForm.notes} onChange={e => setGenerateForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Opsional..." />
            </Field>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Batal</Button>
            <Button type="submit" form="generate-form" disabled={generateMutation.isPending} className="gap-2">
              <Zap className="h-4 w-4" />
              {generateMutation.isPending ? "Membuat..." : "Generate Invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Input Pembayaran ─────────────────────────────────────────── */}
      <Dialog open={paymentOpen} onOpenChange={(o) => { if (!o) { setPaymentOpen(false); setPaymentTarget(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Input Pembayaran Invoice
            </DialogTitle>
          </DialogHeader>
          {paymentTarget && (
            <div className="bg-muted/40 rounded-lg p-3 text-sm mb-1">
              <p className="font-mono font-medium text-xs text-muted-foreground">{paymentTarget.invoiceNumber}</p>
              <p className="font-semibold">{paymentTarget.tenantName}</p>
              <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                <span>Total: <strong className="text-foreground">{formatRupiah(paymentTarget.totalAmount)}</strong></span>
                <span>Sisa: <strong className="text-orange-600">{formatRupiah(paymentTarget.outstandingAmount)}</strong></span>
              </div>
            </div>
          )}
          {pendingProofCheck?.hasPending && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Ada bukti pembayaran menunggu verifikasi</p>
                <p className="text-xs mt-0.5">
                  {pendingProofCheck.receiptNumber} sedang <em>pending review</em>. Setujui atau tolak terlebih dahulu
                  di halaman <a href="/tinjau-pembayaran" className="underline font-medium">Tinjau Pembayaran</a> sebelum mencatat pembayaran baru.
                  Mencatat dua pembayaran untuk satu invoice akan menyebabkan data ganda.
                </p>
              </div>
            </div>
          )}
          <form id="payment-form" onSubmit={handlePaymentSubmit} className="flex flex-col gap-4 py-1">
            <Field label="Jumlah Bayar (Rp)" required>
              <Input
                type="number" min="1"
                value={paymentForm.amountPaid}
                onChange={e => setPaymentForm(f => ({ ...f, amountPaid: e.target.value }))}
                placeholder="0"
              />
            </Field>
            {paymentTarget && activeSite?.type === "sport_center" && Number(paymentForm.amountPaid || 0) > Number(paymentTarget.outstandingAmount || 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="font-semibold text-amber-800">Pembayaran lebih besar dari sisa invoice</p>
                <p className="text-xs text-amber-700 mt-1">
                  Sewa: {formatRupiah(paymentTarget.outstandingAmount)} · Cicilan surcharge: {formatRupiah(Number(paymentForm.amountPaid || 0) - Number(paymentTarget.outstandingAmount || 0))}.
                  Total transfer tetap dicatat penuh sesuai bukti/mutasi.
                </p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Metode Pembayaran">
                <Select value={paymentForm.paymentMethod} onValueChange={(v) => setPaymentForm(f => ({ ...f, paymentMethod: v as PaymentForm["paymentMethod"] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tunai">Tunai</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="qris">QRIS</SelectItem>
                    <SelectItem value="edc">EDC</SelectItem>
                    <SelectItem value="other">Lainnya</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Tanggal Bayar">
                <Input type="date" value={paymentForm.paymentDate} onChange={e => setPaymentForm(f => ({ ...f, paymentDate: e.target.value }))} />
              </Field>
            </div>
            <Field label="Catatan">
              <Textarea value={paymentForm.notes} onChange={e => setPaymentForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Opsional..." />
            </Field>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPaymentOpen(false); setPaymentTarget(null); }}>Batal</Button>
            <Button type="submit" form="payment-form" disabled={paymentMutation.isPending}>
              {paymentMutation.isPending ? "Memproses..." : "Catat Pembayaran"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Detail Invoice ───────────────────────────────────────────── */}
      <PaymentHistoryModal
        open={payHistoryOpen}
        onClose={() => setPayHistoryOpen(false)}
        invoice={payHistoryInvoice}
      />

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Detail Invoice
            </DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="space-y-2 py-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
          ) : detailData ? (
            <ScrollArea className="max-h-[70vh] pr-2">
              <div className="flex flex-col gap-4">
                {/* Top info */}
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-mono text-sm font-bold text-primary">{detailData.invoiceNumber}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Dibuat {formatDate(detailData.createdAt)}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASS[detailData.status]}`}>
                    {STATUS_ICON[detailData.status]}
                    {STATUS_LABEL[detailData.status]}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><p className="text-xs text-muted-foreground">Tenant</p><p className="font-medium">{detailData.tenantName}</p></div>
                  <div><p className="text-xs text-muted-foreground">Unit</p><p className="font-medium">{detailData.unitCode ?? detailData.boothNumber ?? "-"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Periode</p><p className="font-medium">{formatPeriod(detailData.periodStart, detailData.periodEnd)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Jatuh Tempo</p><p className="font-medium">{formatDate(detailData.dueDate)}</p></div>
                </div>

                <Separator />

                <div className="space-y-1.5 text-sm">
                  {[
                    ["Sewa Ruang", detailData.rentAmount],
                    ["Service Charge", detailData.serviceChargeAmount],
                    ["Biaya Listrik", detailData.electricityChargeAmount],
                    ["Biaya Air", detailData.waterChargeAmount],
                    ["Biaya Lain-lain", detailData.otherChargeAmount],
                    ["Iuran Sampah / Kebersihan", detailData.trashChargeAmount],
                  ].filter(([, v]) => Number(v) > 0).map(([label, v]) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-muted-foreground">{label}</span>
                      <span>{formatRupiah(v)}</span>
                    </div>
                  ))}
                  {Number(detailData.discountAmount) > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Diskon</span><span>- {formatRupiah(detailData.discountAmount)}</span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between text-muted-foreground">
                    <span>Subtotal</span><span>{formatRupiah(detailData.subtotal)}</span>
                  </div>
                  {Number(detailData.taxAmount) > 0 && (
                    <div className="flex justify-between text-blue-600">
                      <span>PPN 11% (Pajak Pertambahan Nilai)</span><span>+ {formatRupiah(detailData.taxAmount)}</span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between font-bold text-base">
                    <span>Total</span><span>{formatRupiah(detailData.totalAmount)}</span>
                  </div>
                  <div className="flex justify-between text-green-600">
                    <span>Terbayar</span><span>{formatRupiah(detailData.paidAmount)}</span>
                  </div>
                  {Number(detailData.outstandingAmount) > 0 && (
                    <div className="flex justify-between font-semibold text-orange-600 bg-orange-50 border border-orange-200 rounded-md px-3 py-2">
                      <span>Sisa Tagihan</span><span>{formatRupiah(detailData.outstandingAmount)}</span>
                    </div>
                  )}
                </div>

                {detailData.notes && (
                  <div className="bg-muted/40 rounded-md p-3 text-sm">
                    <p className="text-xs text-muted-foreground mb-1">Catatan</p>
                    <p>{detailData.notes}</p>
                  </div>
                )}

                {/* Payment history */}
                {(detailData.payments ?? []).length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Riwayat Pembayaran</p>
                      <div className="space-y-2">
                        {detailData.payments!.map((p) => (
                          <div key={p.id} className="flex justify-between items-center text-sm bg-muted/30 rounded-md px-3 py-2">
                            <div>
                              <p className="font-medium">{formatRupiah(p.amount)}</p>
                              {Number(p.surchargeAllocationAmount ?? 0) > 0 && (
                                <div className="text-xs mt-0.5">
                                  <span className="text-muted-foreground">Sewa {formatRupiah(p.invoiceAllocationAmount)}</span>
                                  <span className="text-amber-700"> · Surcharge {formatRupiah(p.surchargeAllocationAmount)}</span>
                                </div>
                              )}
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{getPaymentDateLabel(p.sourceType)}</p>
                              <p className="text-xs text-muted-foreground">{p.paymentMethod} · {formatDate(p.paidAt)}</p>
                            </div>
                            <p className="text-xs text-muted-foreground font-mono">{p.receiptNumber ?? "-"}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          ) : null}
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2 text-violet-700 border-violet-200 hover:bg-violet-50 hover:text-violet-800"
              onClick={() => {
                if (detailData) {
                  setPayHistoryInvoice(detailData);
                  setPayHistoryOpen(true);
                }
              }}
            >
              <History className="h-4 w-4" />
              Riwayat Pembayaran
            </Button>
            <Button variant="outline" onClick={() => { if (detailData) void viewOrPrintInvoice(detailData, "view"); }} className="gap-2 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800">
              <Eye className="h-4 w-4" />
              Lihat Invoice
            </Button>
            <Button
              variant="outline"
              className="gap-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800"
              disabled={detailData ? downloadingId === detailData.id : false}
              onClick={() => {
                if (!detailData) return;
                void downloadInvoicePdf(
                  detailData,
                  () => setDownloadingId(detailData.id),
                  () => setDownloadingId(null),
                );
              }}
            >
              {detailData && downloadingId === detailData.id
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />
              }
              {detailData && downloadingId === detailData.id ? "Memproses..." : "Download PDF"}
            </Button>
            <Button variant="outline" onClick={() => { if (detailData) void viewOrPrintInvoice(detailData, "print"); }} className="gap-2">
              <Printer className="h-4 w-4" />
              Print Invoice
            </Button>
            {detailData && detailData.status !== "cancelled" && detailData.phone && (
              <Button
                variant="outline"
                className={`gap-2 ${detailData.status === "overdue" ? "border-red-300 text-red-600 hover:bg-red-50" : "border-green-300 text-green-700 hover:bg-green-50"}`}
                disabled={waSendMutation.isPending}
                onClick={() => waSendMutation.mutate({ id: detailData.id, type: detailData.status === "overdue" ? "overdue-reminder" : "send" })}
              >
                <MessageCircle className="h-4 w-4" />
                {waSendMutation.isPending ? "Mengirim..." : detailData.status === "overdue" ? "Kirim Pengingat WA" : "Kirim Notif WA"}
              </Button>
            )}
            {detailData && detailData.phone && (
              <Button
                variant="outline"
                className="gap-2 border-violet-300 text-violet-700 hover:bg-violet-50 hover:text-violet-800"
                disabled={sendingPdfId === detailData.id}
                onClick={() => sendPdfMutation.mutate(detailData)}
              >
                {sendingPdfId === detailData.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Send className="h-4 w-4" />
                }
                {sendingPdfId === detailData.id ? "Memproses PDF..." : "Kirim PDF ke WA"}
              </Button>
            )}
            {detailData && detailData.status !== "cancelled" && Number(detailData.taxAmount) === 0 && Number(detailData.subtotal) > 0 && (
              <Button
                variant="outline"
                className="gap-2 text-amber-700 border-amber-300 hover:bg-amber-50 hover:text-amber-800"
                disabled={recalcMutation.isPending}
                onClick={() => recalcMutation.mutate(detailData.id)}
              >
                {recalcMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {recalcMutation.isPending ? "Menghitung..." : "Terapkan PPN 11%"}
              </Button>
            )}
            {detailData && detailData.status !== "cancelled" && (
              <Button
                variant="outline"
                className="gap-2 text-violet-700 border-violet-200 hover:bg-violet-50 hover:text-violet-800"
                onClick={() => openEdit(detailData)}
              >
                <Pencil className="h-4 w-4" />
                Edit Invoice
              </Button>
            )}
            {detailData && detailData.status !== "paid" && detailData.status !== "cancelled" && (
              <Button onClick={() => { setDetailOpen(false); openPayment(detailData); }} className="gap-2">
                <CreditCard className="h-4 w-4" />
                Input Pembayaran
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Edit Invoice ─────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!o) { setEditOpen(false); setEditTarget(null); setEditForm(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-violet-600" />
              Edit Invoice{editTarget ? ` — ${editTarget.invoiceNumber}` : ""}
            </DialogTitle>
          </DialogHeader>
          {editForm && (
            <ScrollArea className="flex-1 pr-1">
              <form id="edit-invoice-form" onSubmit={handleEditSubmit} className="flex flex-col gap-4 py-1">
                {/* Info invoice */}
                {editTarget && (
                  <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm flex flex-wrap gap-4">
                    <div><p className="text-xs text-muted-foreground">Tenant</p><p className="font-medium">{editTarget.tenantName ?? "-"}</p></div>
                    <div><p className="text-xs text-muted-foreground">Invoice</p><p className="font-mono text-xs font-bold text-primary">{editTarget.invoiceNumber}</p></div>
                    <div><p className="text-xs text-muted-foreground">Terbayar</p><p className="font-medium text-green-600">{formatRupiah(editTarget.paidAmount)}</p></div>
                  </div>
                )}

                {/* Kode Unit & Periode */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Kode Unit / Booth">
                    <Input value={editForm.unitCode} onChange={e => setEditForm(f => f ? { ...f, unitCode: e.target.value } : f)} placeholder="A-01" />
                  </Field>
                  <Field label="Periode Mulai">
                    <Input type="date" value={editForm.periodStart} onChange={e => setEditForm(f => f ? { ...f, periodStart: e.target.value } : f)} />
                  </Field>
                  <Field label="Periode Selesai">
                    <Input type="date" value={editForm.periodEnd} onChange={e => setEditForm(f => f ? { ...f, periodEnd: e.target.value } : f)} />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Jatuh Tempo">
                    <Input type="date" value={editForm.dueDate} onChange={e => setEditForm(f => f ? { ...f, dueDate: e.target.value } : f)} />
                  </Field>
                  <Field label="Status">
                    <Select value={editForm.status} onValueChange={(v) => setEditForm(f => f ? { ...f, status: v as InvoiceStatus } : f)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="unpaid">Belum Bayar</SelectItem>
                        <SelectItem value="paid">Lunas</SelectItem>
                        <SelectItem value="overdue">Jatuh Tempo</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                {/* Komponen Biaya */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label="Harga Sewa (Rp)">
                    <Input type="number" min="0" value={editForm.rentAmount} onChange={e => setEditForm(f => f ? { ...f, rentAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Service Charge (Rp)">
                    <Input type="number" min="0" value={editForm.serviceChargeAmount} onChange={e => setEditForm(f => f ? { ...f, serviceChargeAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Listrik (Rp)">
                    <Input type="number" min="0" value={editForm.electricityChargeAmount} onChange={e => setEditForm(f => f ? { ...f, electricityChargeAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Air (Rp)">
                    <Input type="number" min="0" value={editForm.waterChargeAmount} onChange={e => setEditForm(f => f ? { ...f, waterChargeAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Lain-lain (Rp)">
                    <Input type="number" min="0" value={editForm.otherChargeAmount} onChange={e => setEditForm(f => f ? { ...f, otherChargeAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Sampah / Kebersihan (Rp)">
                    <Input type="number" min="0" value={editForm.trashChargeAmount} onChange={e => setEditForm(f => f ? { ...f, trashChargeAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                  <Field label="Diskon (Rp)">
                    <Input type="number" min="0" value={editForm.discountAmount} onChange={e => setEditForm(f => f ? { ...f, discountAmount: e.target.value } : f)} placeholder="0" />
                  </Field>
                </div>

                {/* Toggle PPN */}
                <div className={`flex items-center justify-between rounded-lg border p-3 ${editForm.usePpn ? "border-blue-200 bg-blue-50/60" : "border-slate-200 bg-slate-50"}`}>
                  <div>
                    <p className="text-sm font-medium">Gunakan PPN 11%</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {editForm.usePpn ? "Harga Sewa sudah termasuk PPN — PPN diekstrak dari dalam (tax-inclusive)" : "Tidak ada PPN — total = subtotal saja"}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={editForm.usePpn}
                    onClick={() => setEditForm(f => f ? { ...f, usePpn: !f.usePpn } : f)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${editForm.usePpn ? "bg-blue-600" : "bg-slate-300"}`}
                  >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${editForm.usePpn ? "translate-x-5" : "translate-x-0"}`} />
                  </button>
                </div>

                {/* Preview Ringkasan */}
                {(() => {
                  const sub = (Number(editForm.rentAmount||0)+Number(editForm.serviceChargeAmount||0)+Number(editForm.electricityChargeAmount||0)+Number(editForm.waterChargeAmount||0)+Number(editForm.otherChargeAmount||0)+Number(editForm.trashChargeAmount||0))-Number(editForm.discountAmount||0);
                  if (sub <= 0) return null;
                  // Tax-inclusive: PPN diekstrak dari dalam Harga Sewa (rent × 11/111)
                  // Total = subtotal (PPN sudah di dalam, TIDAK ditambahkan lagi)
                  const ppn = editForm.usePpn ? Math.round(Number(editForm.rentAmount||0) * 0.11 / 1.11) : 0;
                  const dpp = Number(editForm.rentAmount||0) - ppn;
                  const total = sub; // PPN sudah termasuk, tidak ditambah
                  return (
                    <div className={`rounded-md border p-3 text-sm space-y-1 ${editForm.usePpn ? "bg-blue-50 border-blue-100" : "bg-slate-50 border-slate-200"}`}>
                      <p className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${editForm.usePpn ? "text-blue-700" : "text-slate-600"}`}>Ringkasan Tagihan</p>
                      <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{formatRupiah(String(sub))}</span></div>
                      {editForm.usePpn && (
                        <>
                          <div className="flex justify-between text-xs text-muted-foreground/70 italic"><span>DPP (Harga Sewa belum PPN)</span><span>{formatRupiah(String(dpp))}</span></div>
                          <div className="flex justify-between text-blue-600 text-xs"><span>PPN 11% (diekstrak dari Harga Sewa)</span><span>{formatRupiah(String(ppn))}</span></div>
                        </>
                      )}
                      <div className={`flex justify-between font-bold text-base border-t pt-1 mt-1 ${editForm.usePpn ? "border-blue-200" : "border-slate-200"}`}><span>Total</span><span>{formatRupiah(String(total))}</span></div>
                    </div>
                  );
                })()}

                <Field label="Catatan">
                  <Textarea value={editForm.notes} onChange={e => setEditForm(f => f ? { ...f, notes: e.target.value } : f)} rows={2} placeholder="Catatan tambahan (opsional)" />
                </Field>
              </form>
            </ScrollArea>
          )}
          <DialogFooter className="pt-2">
            <Button variant="outline" disabled={patchMutation.isPending} onClick={() => { setEditOpen(false); setEditTarget(null); setEditForm(null); }}>
              Batal
            </Button>
            <Button type="submit" form="edit-invoice-form" disabled={patchMutation.isPending} className="gap-2 bg-violet-600 hover:bg-violet-700">
              {patchMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" />Menyimpan...</> : <><Pencil className="h-4 w-4" />Simpan Perubahan</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Konfirmasi Hapus Invoice ─────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4" />
              Hapus Invoice?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Apakah Anda yakin ingin menghapus invoice{" "}
            <strong className="text-foreground font-mono">{deleteTarget?.invoiceNumber}</strong> secara permanen?
            Tindakan ini <strong>tidak dapat dibatalkan</strong>.
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={deleteMutation.isPending} onClick={() => setDeleteTarget(null)}>Batal</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? "Menghapus..." : "Ya, Hapus"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Konfirmasi Batalkan ──────────────────────────────────────── */}
      <Dialog open={!!cancelTarget} onOpenChange={(o) => { if (!o) setCancelTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <X className="h-4 w-4" />
              Batalkan Invoice
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Apakah Anda yakin ingin membatalkan invoice <strong className="text-foreground font-mono">{cancelTarget?.invoiceNumber}</strong>? Tindakan ini tidak dapat dibatalkan.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Tidak</Button>
            <Button
              variant="destructive"
              disabled={cancelMutation.isPending}
              onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
            >
              {cancelMutation.isPending ? "Membatalkan..." : "Ya, Batalkan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Pratinjau & Salin Link Bayar ──────────────────────────────── */}
      <Dialog open={!!paymentLinkDialog} onOpenChange={(o) => { if (!o) { setPaymentLinkDialog(null); setLinkCopied(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {paymentLinkDialog?.mode === "wa-pending" ? (
                <><Clock className="h-5 w-5 text-amber-500" />Pesan Masuk Antrian Fonnte</>
              ) : paymentLinkDialog?.mode === "wa-failed" ? (
                waStatus?.connected === false
                  ? <><WifiOff className="h-5 w-5 text-orange-500" />WhatsApp Tidak Terhubung</>
                  : <><AlertTriangle className="h-5 w-5 text-orange-500" />WhatsApp Belum Terkirim</>
              ) : (
                <><Link2 className="h-5 w-5 text-blue-500" />Link Pembayaran Tenant</>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {paymentLinkDialog?.mode !== "manual" && paymentLinkDialog?.message && (
              <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
                <p className="font-medium mb-1">
                  {paymentLinkDialog.mode === "wa-pending" ? "Pengiriman belum selesai" : "Pengiriman WA gagal"}
                </p>
                <p className="text-orange-700">{paymentLinkDialog.message}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                {paymentLinkDialog?.mode !== "manual"
                  ? "Kirim link ini secara manual ke tenant (copy lalu kirim via WA, SMS, atau email):"
                  : "Salin link berikut dan kirimkan ke tenant melalui WA, SMS, atau media lain:"
                }
              </p>
              <div
                className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 cursor-pointer hover:bg-muted/60 transition-colors group"
                title="Klik untuk menyalin"
                onClick={() => {
                  if (paymentLinkDialog?.link) {
                    void navigator.clipboard.writeText(paymentLinkDialog.link);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 3000);
                  }
                }}
              >
                <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="flex-1 text-xs font-mono break-all select-all">
                  {paymentLinkDialog?.link}
                </span>
                <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              {linkCopied && (
                <p className="text-xs text-green-600 mt-1.5 flex items-center gap-1">
                  <CheckCheck className="h-3.5 w-3.5" />Link berhasil disalin ke clipboard!
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setPaymentLinkDialog(null); setLinkCopied(false); }}>
              Tutup
            </Button>
            <Button
              className={linkCopied ? "bg-green-600 hover:bg-green-700" : ""}
              onClick={() => {
                if (paymentLinkDialog?.link) {
                  void navigator.clipboard.writeText(paymentLinkDialog.link);
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 3000);
                }
              }}
            >
              {linkCopied
                ? <><CheckCheck className="h-4 w-4 mr-1.5" />Tersalin!</>
                : <><Copy className="h-4 w-4 mr-1.5" />Salin Link</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog: Invoice Massal ───────────────────────────────────────────── */}
      <Dialog open={bulkOpen} onOpenChange={(o) => { if (!o) { setBulkOpen(false); setBulkResult(null); } }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-violet-600" />
              Buat Invoice Massal
            </DialogTitle>
          </DialogHeader>

          {/* ── Setelah berhasil: tampilkan ringkasan ── */}
          {bulkResult ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-3 rounded-lg border p-4">
                <CheckCircle2 className="h-8 w-8 text-green-500 shrink-0" />
                <div>
                  <p className="font-semibold">{bulkResult.succeeded} invoice berhasil dibuat</p>
                  {bulkResult.failed > 0 && (
                    <p className="text-sm text-destructive">{bulkResult.failed} gagal</p>
                  )}
                </div>
              </div>
              <ScrollArea className="max-h-60">
                <div className="flex flex-col gap-1 pr-2">
                  {bulkResult.results.map((r) => {
                    const t = (tenants ?? []).find(x => x.id === r.tenantId);
                    return (
                      <div key={r.tenantId} className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${r.success ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                        <span className="font-medium">{t?.businessName ?? `Tenant #${r.tenantId}`}</span>
                        {r.success
                          ? <span className="font-mono text-xs text-green-700">{r.invoiceNumber}</span>
                          : <span className="text-xs text-red-600">{r.error ?? "Gagal"}</span>
                        }
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
              <DialogFooter>
                <Button onClick={() => { setBulkOpen(false); setBulkResult(null); }}>Tutup</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={handleBulkSubmit} className="flex flex-col gap-4">
              {/* ── Pilih Periode Cepat ── */}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
                <span className="text-sm font-medium shrink-0">Pilih Bulan:</span>
                <Select value={String(bulkMonth.month)} onValueChange={v => setBulkMonth(f => ({ ...f, month: Number(v) }))}>
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BULAN_ID.map((n, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={String(bulkMonth.year)} onValueChange={v => setBulkMonth(f => ({ ...f, year: Number(v) }))}>
                  <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[bulkMonth.year - 1, bulkMonth.year, bulkMonth.year + 1].map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" size="sm" className="h-8 gap-1.5 bg-violet-600 hover:bg-violet-700" onClick={applyBulkPeriod}>
                  <Zap className="h-3.5 w-3.5" />
                  Isi Otomatis
                </Button>
                {bulkCommon.periodStart && (
                  <span className="text-xs text-muted-foreground">
                    {BULAN_ID[new Date(bulkCommon.periodStart).getMonth()]} {new Date(bulkCommon.periodStart).getFullYear()}
                    {bulkCommon.dueDate && ` · Jatuh tempo: ${new Date(bulkCommon.dueDate).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })}`}
                  </span>
                )}
              </div>

              {/* ── Baris field manual ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Periode Mulai</Label>
                  <Input type="date" value={bulkCommon.periodStart} onChange={e => setBulkCommon(f => ({ ...f, periodStart: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Periode Selesai</Label>
                  <Input type="date" value={bulkCommon.periodEnd} onChange={e => setBulkCommon(f => ({ ...f, periodEnd: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Jatuh Tempo</Label>
                  <Input type="date" value={bulkCommon.dueDate} onChange={e => setBulkCommon(f => ({ ...f, dueDate: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Status Awal</Label>
                  <Select value={bulkCommon.status} onValueChange={(v) => setBulkCommon(f => ({ ...f, status: v as InvoiceStatus }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="unpaid">Belum Bayar</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Catatan (untuk semua invoice)</Label>
                <Input value={bulkCommon.notes} onChange={e => setBulkCommon(f => ({ ...f, notes: e.target.value }))} placeholder="Opsional" />
              </div>

              <Separator />

              {/* ── Header tabel ── */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  Pilih Tenant
                  <span className="ml-2 text-muted-foreground font-normal">({bulkSelected.size} dari {(tenants ?? []).length} dipilih)</span>
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-green-700 hover:text-green-800 hover:bg-green-50"
                    onClick={() => setBulkSelected(new Set((tenants ?? []).filter(isActiveTenant).map(t => t.id)))}>
                    Aktif Saja
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => setBulkSelected(new Set((tenants ?? []).map(t => t.id)))}>
                    Semua
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => setBulkSelected(new Set())}>
                    Kosongkan
                  </Button>
                </div>
              </div>

              {/* ── Tabel tenant ── */}
              <ScrollArea className="max-h-72 rounded-md border">
                <div className="divide-y">
                  {(tenants ?? []).map((t) => {
                    const isSelected = bulkSelected.has(t.id);
                    const isExpanded = bulkExpanded === t.id;
                    const p = bulkPrices[t.id] ?? { unitCode: "", rentAmount: "", serviceChargeAmount: "", electricityChargeAmount: "", waterChargeAmount: "", otherChargeAmount: "", trashChargeAmount: "" };
                    const total = calcBulkTotal(t.id);
                    return (
                      <div key={t.id} className={`transition-colors ${isSelected ? "" : "opacity-50"}`}>
                        {/* Baris utama */}
                        <div className="flex items-center gap-3 px-3 py-2.5">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => {
                              setBulkSelected(prev => {
                                const next = new Set(prev);
                                if (checked) next.add(t.id); else next.delete(t.id);
                                return next;
                              });
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="font-medium text-sm truncate">{t.businessName}</p>
                              {isActiveTenant(t)
                                ? <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700">Aktif</span>
                                : <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500">Nonaktif</span>
                              }
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{p.unitCode || t.boothNumber || "—"}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-semibold">{total > 0 ? formatRupiah(total) : <span className="text-muted-foreground text-xs">belum diisi</span>}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 shrink-0"
                            onClick={() => setBulkExpanded(isExpanded ? null : t.id)}
                          >
                            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </Button>
                        </div>

                        {/* Baris expand — edit harga per tenant */}
                        {isExpanded && (
                          <div className="bg-muted/30 px-3 pb-3 pt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {[
                              { key: "unitCode", label: "Unit / Kode", type: "text", placeholder: "A-01" },
                              { key: "rentAmount", label: "Harga Sewa", type: "number", placeholder: "0" },
                              { key: "serviceChargeAmount", label: "Service Charge", type: "number", placeholder: "0" },
                              { key: "electricityChargeAmount", label: "Biaya Listrik", type: "number", placeholder: "0" },
                              { key: "waterChargeAmount", label: "Biaya Air", type: "number", placeholder: "0" },
                              { key: "otherChargeAmount", label: "Lain-lain", type: "number", placeholder: "0" },
                              { key: "trashChargeAmount", label: "Sampah/Kebersihan", type: "number", placeholder: "0" },
                            ].map(({ key, label, type, placeholder }) => (
                              <div key={key} className="flex flex-col gap-1">
                                <Label className="text-xs">{label}</Label>
                                <Input
                                  type={type}
                                  min={type === "number" ? "0" : undefined}
                                  placeholder={placeholder}
                                  value={(p as any)[key]}
                                  onChange={(e) => setBulkPrices(prev => ({
                                    ...prev,
                                    [t.id]: { ...prev[t.id], [key]: e.target.value },
                                  }))}
                                  className="h-8 text-sm"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>

              {/* ── Footer ── */}
              <div className="flex items-center justify-between pt-1">
                <div className="text-sm text-muted-foreground">
                  Total estimasi:{" "}
                  <span className="font-semibold text-foreground">
                    {formatRupiah(
                      Array.from(bulkSelected).reduce((sum, id) => sum + calcBulkTotal(id), 0)
                    )}
                  </span>
                  {" "}dari {bulkSelected.size} tenant
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkMutation.isPending}>
                    Batal
                  </Button>
                  <Button
                    type="submit"
                    disabled={bulkMutation.isPending || bulkSelected.size === 0}
                    className="gap-2 bg-violet-600 hover:bg-violet-700"
                  >
                    {bulkMutation.isPending
                      ? <><Loader2 className="h-4 w-4 animate-spin" />Membuat {bulkSelected.size} Invoice...</>
                      : <><Layers className="h-4 w-4" />Buat {bulkSelected.size} Invoice</>
                    }
                  </Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ══════════════ Dialog Laporan PPN ══════════════ */}
      <Dialog open={ppnOpen} onOpenChange={setPpnOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart2 className="h-5 w-5 text-emerald-600" />
              Laporan Rekapitulasi PPN 11%
            </DialogTitle>
          </DialogHeader>

          {/* Filter periode */}
          <div className="flex flex-wrap items-end gap-3 pb-2">
            <div>
              <Label className="text-xs mb-1 block text-muted-foreground">Dari Bulan</Label>
              <Input
                type="month"
                value={ppnFrom}
                max={ppnTo}
                onChange={(e) => setPpnFrom(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <div>
              <Label className="text-xs mb-1 block text-muted-foreground">Sampai Bulan</Label>
              <Input
                type="month"
                value={ppnTo}
                min={ppnFrom}
                onChange={(e) => setPpnTo(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1"
              onClick={() => void refetchPpn()}
              disabled={ppnLoading}
            >
              {ppnLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Tampilkan
            </Button>
          </div>

          {/* ── Tabs Per Bulan / Per Tenant ── */}
          {ppnLoading ? (
            <div className="py-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : !ppnReport ? (
            <p className="text-sm text-muted-foreground text-center py-8">Pilih rentang bulan dan klik Tampilkan.</p>
          ) : (
            <Tabs value={ppnTab} onValueChange={(v) => setPpnTab(v as "bulan" | "tenant")}>
              <TabsList className="w-full">
                <TabsTrigger value="bulan" className="flex-1">📅 Per Bulan</TabsTrigger>
                <TabsTrigger value="tenant" className="flex-1">🏪 Per Tenant ({ppnReport.byTenant.length})</TabsTrigger>
              </TabsList>

              {/* ══ Tab 1 — Per Bulan ══ */}
              <TabsContent value="bulan" className="mt-3 space-y-3">
                {ppnReport.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Tidak ada invoice pada periode ini.</p>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40">
                          <TableHead className="w-28">Bulan</TableHead>
                          <TableHead className="text-right">Jml Invoice</TableHead>
                          <TableHead className="text-right">Subtotal (DPP)</TableHead>
                          <TableHead className="text-right text-emerald-700">PPN 11%</TableHead>
                          <TableHead className="text-right">Total Tagihan</TableHead>
                          <TableHead className="text-right">Total Terbayar</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ppnReport.rows.map((r) => (
                          <TableRow key={r.bulan}>
                            <TableCell className="font-medium">{r.bulan}</TableCell>
                            <TableCell className="text-right">{r.jumlah_invoice}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_subtotal)}</TableCell>
                            <TableCell className="text-right font-medium text-emerald-700">{formatRupiah(r.total_ppn)}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_tagihan)}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_terbayar)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/60 font-bold border-t-2">
                          <TableCell>TOTAL</TableCell>
                          <TableCell className="text-right">{ppnReport.totals.jumlah_invoice ?? 0}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_subtotal ?? "0")}</TableCell>
                          <TableCell className="text-right text-emerald-700">{formatRupiah(ppnReport.totals.total_ppn ?? "0")}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_tagihan ?? "0")}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_terbayar ?? "0")}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
                {/* Ekspor tab bulan */}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" className="h-8 gap-1 border-slate-300 text-slate-700"
                    disabled={ppnReport.rows.length === 0}
                    onClick={() => {
                      const header = ["Bulan","Jumlah Invoice","Subtotal (DPP)","PPN 11%","Total Tagihan","Total Terbayar"];
                      const dr = ppnReport.rows.map(r => [r.bulan, r.jumlah_invoice, r.total_subtotal, r.total_ppn, r.total_tagihan, r.total_terbayar]);
                      const t = ppnReport.totals;
                      dr.push(["TOTAL", t.jumlah_invoice ?? "", t.total_subtotal ?? "", t.total_ppn ?? "", t.total_tagihan ?? "", t.total_terbayar ?? ""]);
                      const csv = [header, ...dr].map(r => r.join(",")).join("\n");
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
                      a.download = `ppn-per-bulan-${ppnFrom}-sd-${ppnTo}.csv`;
                      a.click();
                    }}>
                    <FileDown className="h-3.5 w-3.5" /> CSV
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 gap-1 border-green-500 text-green-700"
                    disabled={ppnReport.rows.length === 0}
                    onClick={async () => {
                      const { default: ExcelJS } = await import("exceljs");
                      const wb = new ExcelJS.Workbook();
                      const judul = [[`LAPORAN PPN 11% PER BULAN`],[`Periode: ${ppnFrom} s/d ${ppnTo}`],[`Dicetak: ${new Date().toLocaleDateString("id-ID",{dateStyle:"long"})}`],[]];
                      const header = [["Bulan","Jumlah Invoice","Subtotal (DPP)","PPN 11%","Total Tagihan","Total Terbayar"]];
                      const dr = ppnReport.rows.map(r => [r.bulan, Number(r.jumlah_invoice), Number(r.total_subtotal), Number(r.total_ppn), Number(r.total_tagihan), Number(r.total_terbayar)]);
                      const t = ppnReport.totals;
                      dr.push(["TOTAL", Number(t.jumlah_invoice??0), Number(t.total_subtotal??0), Number(t.total_ppn??0), Number(t.total_tagihan??0), Number(t.total_terbayar??0)]);
                      const ws = wb.addWorksheet("Per Bulan");
                      ws.addRows([...judul,...header,...dr]);
                      ws.columns = [{width:12},{width:15},{width:20},{width:20},{width:20},{width:20}];
                      ws.mergeCells(1,1,1,6); ws.mergeCells(2,1,2,6); ws.mergeCells(3,1,3,6);
                      const startRow = judul.length + header.length + 1;
                      for (let row = startRow; row < startRow + dr.length; row++) for (let col = 3; col <= 6; col++) { ws.getCell(row, col).numFmt = '#,##0'; }
                      const buf = await wb.xlsx.writeBuffer();
                      const blob = new Blob([buf], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = `ppn-per-bulan-${ppnFrom}-sd-${ppnTo}.xlsx`; a.click(); URL.revokeObjectURL(url);
                    }}>
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                  </Button>
                </div>
              </TabsContent>

              {/* ══ Tab 2 — Per Tenant ══ */}
              <TabsContent value="tenant" className="mt-3 space-y-3">
                {ppnReport.byTenant.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Tidak ada invoice pada periode ini.</p>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40">
                          <TableHead className="min-w-[160px]">Tenant</TableHead>
                          <TableHead className="min-w-[100px]">Unit</TableHead>
                          <TableHead className="text-right">Jml Invoice</TableHead>
                          <TableHead className="text-right">Subtotal (DPP)</TableHead>
                          <TableHead className="text-right text-emerald-700">PPN 11%</TableHead>
                          <TableHead className="text-right">Total Tagihan</TableHead>
                          <TableHead className="text-right">Terbayar</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ppnReport.byTenant.map((r) => (
                          <TableRow key={r.tenant_id}>
                            <TableCell>
                              <p className="font-medium leading-tight">{r.nama_tenant ?? "-"}</p>
                              <p className="text-xs text-muted-foreground">{r.nama_pemilik ?? ""}</p>
                            </TableCell>
                            <TableCell className="text-sm">{r.unit}</TableCell>
                            <TableCell className="text-right">{r.jumlah_invoice}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_subtotal)}</TableCell>
                            <TableCell className="text-right font-medium text-emerald-700">{formatRupiah(r.total_ppn)}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_tagihan)}</TableCell>
                            <TableCell className="text-right">{formatRupiah(r.total_terbayar)}</TableCell>
                          </TableRow>
                        ))}
                        {/* Total baris */}
                        <TableRow className="bg-muted/60 font-bold border-t-2">
                          <TableCell colSpan={2}>TOTAL ({ppnReport.byTenant.length} tenant)</TableCell>
                          <TableCell className="text-right">{ppnReport.totals.jumlah_invoice ?? 0}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_subtotal ?? "0")}</TableCell>
                          <TableCell className="text-right text-emerald-700">{formatRupiah(ppnReport.totals.total_ppn ?? "0")}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_tagihan ?? "0")}</TableCell>
                          <TableCell className="text-right">{formatRupiah(ppnReport.totals.total_terbayar ?? "0")}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
                {/* Ekspor tab tenant */}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" className="h-8 gap-1 border-slate-300 text-slate-700"
                    disabled={ppnReport.byTenant.length === 0}
                    onClick={() => {
                      const header = ["Nama Tenant","Pemilik","Unit","Jml Invoice","Subtotal (DPP)","PPN 11%","Total Tagihan","Total Terbayar"];
                      const dr = ppnReport.byTenant.map(r => [r.nama_tenant??"",r.nama_pemilik??"",r.unit,r.jumlah_invoice,r.total_subtotal,r.total_ppn,r.total_tagihan,r.total_terbayar]);
                      const t = ppnReport.totals;
                      dr.push([`TOTAL (${ppnReport.byTenant.length} tenant)`,"","",t.jumlah_invoice??"",t.total_subtotal??"",t.total_ppn??"",t.total_tagihan??"",t.total_terbayar??""]);
                      const csv = [header,...dr].map(r=>r.join(",")).join("\n");
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}));
                      a.download = `ppn-per-tenant-${ppnFrom}-sd-${ppnTo}.csv`;
                      a.click();
                    }}>
                    <FileDown className="h-3.5 w-3.5" /> CSV
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 gap-1 border-green-500 text-green-700"
                    disabled={ppnReport.byTenant.length === 0}
                    onClick={async () => {
                      const { default: ExcelJS } = await import("exceljs");
                      const wb = new ExcelJS.Workbook();
                      const judul = [[`LAPORAN PPN 11% PER TENANT`],[`Periode: ${ppnFrom} s/d ${ppnTo}`],[`Dicetak: ${new Date().toLocaleDateString("id-ID",{dateStyle:"long"})}`],[]];
                      const header = [["Nama Tenant","Pemilik","Unit","Jml Invoice","Subtotal (DPP)","PPN 11%","Total Tagihan","Total Terbayar"]];
                      const dr = ppnReport.byTenant.map(r => [r.nama_tenant??"",r.nama_pemilik??"",r.unit,Number(r.jumlah_invoice),Number(r.total_subtotal),Number(r.total_ppn),Number(r.total_tagihan),Number(r.total_terbayar)]);
                      const t = ppnReport.totals;
                      dr.push([`TOTAL (${ppnReport.byTenant.length} tenant)`,"","",Number(t.jumlah_invoice??0),Number(t.total_subtotal??0),Number(t.total_ppn??0),Number(t.total_tagihan??0),Number(t.total_terbayar??0)]);
                      const ws = wb.addWorksheet("Per Tenant");
                      ws.addRows([...judul,...header,...dr]);
                      ws.columns = [{width:22},{width:18},{width:10},{width:12},{width:20},{width:20},{width:20},{width:18}];
                      ws.mergeCells(1,1,1,8); ws.mergeCells(2,1,2,8); ws.mergeCells(3,1,3,8);
                      const startRow = judul.length + header.length + 1;
                      for (let row = startRow; row < startRow + dr.length; row++) for (let col = 5; col <= 8; col++) { ws.getCell(row, col).numFmt = '#,##0'; }
                      // sheet gabungan kedua tab
                      const drB = ppnReport.rows.map(r => [r.bulan, Number(r.jumlah_invoice), Number(r.total_subtotal), Number(r.total_ppn), Number(r.total_tagihan), Number(r.total_terbayar)]);
                      const judulB = [[`LAPORAN PPN 11% PER BULAN`],[`Periode: ${ppnFrom} s/d ${ppnTo}`],[`Dicetak: ${new Date().toLocaleDateString("id-ID",{dateStyle:"long"})}`],[]];
                      const headerB = [["Bulan","Jumlah Invoice","Subtotal (DPP)","PPN 11%","Total Tagihan","Total Terbayar"]];
                      const tb = ppnReport.totals;
                      drB.push(["TOTAL",Number(tb.jumlah_invoice??0),Number(tb.total_subtotal??0),Number(tb.total_ppn??0),Number(tb.total_tagihan??0),Number(tb.total_terbayar??0)]);
                      const wsB = wb.addWorksheet("Per Bulan");
                      wsB.addRows([...judulB,...headerB,...drB]);
                      wsB.columns = [{width:12},{width:15},{width:20},{width:20},{width:20},{width:20}];
                      wsB.mergeCells(1,1,1,6); wsB.mergeCells(2,1,2,6); wsB.mergeCells(3,1,3,6);
                      const buf = await wb.xlsx.writeBuffer();
                      const blob = new Blob([buf], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = `ppn-lengkap-${ppnFrom}-sd-${ppnTo}.xlsx`; a.click(); URL.revokeObjectURL(url);
                    }}>
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Excel (+ Per Bulan)
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          )}

          <DialogFooter>
            <p className="text-xs text-muted-foreground flex-1">
              * Invoice <strong>Draft</strong> &amp; <strong>Dibatalkan</strong> tidak dihitung.
              PPN otomatis 11% dari subtotal (DPP).
            </p>
            <Button variant="outline" onClick={() => setPpnOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
