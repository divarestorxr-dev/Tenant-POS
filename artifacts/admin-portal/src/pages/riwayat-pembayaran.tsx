import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  RefreshCw,
  Receipt,
  Download,
  Filter,
  Eye,
  Pencil,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getPaymentDateLabel } from "@/lib/payment-date-label";
import { useToast } from "@/hooks/use-toast";
import { useSite } from "@/contexts/site-context";
import { apiFetch } from "@/lib/api";
import { asArray } from "@/lib/api-shape";

function formatRupiah(val: number | string | null | undefined) {
  if (val == null || val === "") return "Rp 0";
  const num = typeof val === "string" ? parseFloat(val) : val;
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(num);
}

function formatTanggal(val: string | null | undefined) {
  if (!val) return "-";
  return new Date(val).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDateInputValue(val: string | null | undefined) {
  return val ? new Date(val).toISOString().slice(0, 10) : "";
}

const METODE_LABELS: Record<string, string> = {
  tunai: "Tunai",
  transfer: "Transfer",
  qris: "QRIS",
  edc: "EDC",
  other: "Lainnya",
};

const SOURCE_LABELS: Record<string, string> = {
  pos: "POS",
  manual: "Manual",
  bank_recon: "Rekonsiliasi Bank",
  ocr: "OCR Upload",
};

type Payment = {
  id: number;
  paymentNumber: string | null;
  receiptNumber: string | null;
  amount: number;
  discountAmount: number;
  penaltyAmount: number;
  paymentMethod: string;
  approvalStatus: string;
  isVoided: boolean;
  duplicateOfPaymentId?: number | null;
  paidAt: string | null;
  sourceType: string | null;
  notes: string | null;
  referenceNumber: string | null;
  proofUrl: string | null;
  voidReason?: string | null;
  invoiceId: number | null;
  bookingId: number | null;
  tenantName: string | null;
  boothNumber: string | null;
  orderNumber: string | null;
  periodLabel: string | null;
  reconciled: boolean;
  bankMatchedByRule: boolean;
};

type PaymentsResponse = {
  data: Payment[];
  total: number;
  page: number;
  pageSize: number;
};

type DetailPayment = Payment & {
  voidReason?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  refundAmount?: number;
  refundReason?: string | null;
};

type DuplicatePayment = {
  id: number;
  paymentNumber: string | null;
  receiptNumber: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  amount: number | string;
  paymentMethod: string;
  paymentStatus: string | null;
  approvalStatus: string;
  paidAt: string | null;
  proofUrl: string | null;
  businessName: string | null;
};

function parseDuplicatePaymentId(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const match = reason.match(/\b(?:payment|pembayaran)\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function getDuplicatePaymentId(payment: DetailPayment | null): number | null {
  if (!payment?.isVoided) return null;
  if (payment.duplicateOfPaymentId != null) return payment.duplicateOfPaymentId;
  return parseDuplicatePaymentId(payment.voidReason);
}

export default function RiwayatPembayaran() {
  const [search, setSearch] = useState("");
  const [metode, setMetode] = useState("semua");
  const [status, setStatus] = useState("semua");
  const [source, setSource] = useState("semua");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [selectedPayment, setSelectedPayment] = useState<DetailPayment | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [proofBlobUrl, setProofBlobUrl] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  useEffect(() => {
    if (!proofPreview) {
      setProofBlobUrl(null);
      setProofError(null);
      setProofLoading(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setProofBlobUrl(null);
    setProofError(null);
    setProofLoading(true);
    void (async () => {
      try {
        const response = await apiFetch(proofPreview, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Bukti pembayaran tidak dapat dibuka (HTTP ${response.status})`);
        }
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") && blob.type !== "application/pdf") {
          throw new Error("Format bukti pembayaran tidak didukung untuk pratinjau.");
        }
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setProofBlobUrl(objectUrl);
      } catch (error) {
        if (!controller.signal.aborted) {
          setProofError(error instanceof Error ? error.message : "Gagal memuat bukti pembayaran.");
        }
      } finally {
        if (!controller.signal.aborted) setProofLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proofPreview]);
  const [dateDraft, setDateDraft] = useState("");
  const [dateEditing, setDateEditing] = useState(false);
  const [dateSaving, setDateSaving] = useState(false);
  const { toast } = useToast();
  const { activeSiteId } = useSite();
  const pageSize = 20;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (metode !== "semua") params.set("method", metode);
  if (status !== "semua") params.set("status", status);
  if (source !== "semua") params.set("source", source);
  if (dateFrom) params.set("from", dateFrom);
  if (dateTo) params.set("to", dateTo);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));

  const { data, isLoading, refetch, isFetching } = useQuery<PaymentsResponse>({
    queryKey: ["riwayat-pembayaran", activeSiteId, search, metode, status, source, dateFrom, dateTo, page],
    queryFn: async () => {
      const res = await apiFetch(`/api/tenant-pos/payments-history?${params}`);
      if (!res.ok) throw new Error("Gagal mengambil data");
      const payload = await res.json();
      return { ...payload, data: asArray<Payment>(payload?.data ?? payload) };
    },
    placeholderData: (prev) => prev,
    enabled: activeSiteId !== null,
  });

  const payments = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const duplicatePaymentId = getDuplicatePaymentId(selectedPayment);
  const { data: duplicatePayment, isLoading: isDuplicateLoading } = useQuery<DuplicatePayment>({
    queryKey: ["duplicate-payment", duplicatePaymentId],
    queryFn: async () => {
      const res = await apiFetch(`/api/payments/${duplicatePaymentId}`);
      if (!res.ok) throw new Error("Gagal mengambil pembayaran yang menjadi duplikat");
      return res.json();
    },
    enabled: Boolean(selectedPayment?.isVoided && duplicatePaymentId),
  });

  function resetFilter() {
    setSearch("");
    setMetode("semua");
    setStatus("semua");
    setSource("semua");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  function selectPayment(payment: Payment) {
    setSelectedPayment(payment as DetailPayment);
    setDateDraft(toDateInputValue(payment.paidAt));
    setDateEditing(false);
  }

  async function savePaymentDate() {
    if (!selectedPayment || !dateDraft) return;
    setDateSaving(true);
    try {
      const res = await apiFetch(`/api/payments/${selectedPayment.id}/date`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentDate: dateDraft }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Gagal mengubah tanggal pembayaran");

      const paidAt = body.payment?.paidAt ?? `${dateDraft}T00:00:00.000Z`;
      setSelectedPayment((current) => current ? { ...current, paidAt } : current);
      setDateEditing(false);
      await refetch();
      toast({ title: "Tanggal pembayaran diperbarui", description: "Tanggal bayar berhasil disimpan." });
    } catch (err) {
      toast({
        title: "Gagal mengubah tanggal",
        description: err instanceof Error ? err.message : "Silakan coba lagi.",
        variant: "destructive",
      });
    } finally {
      setDateSaving(false);
    }
  }

  function statusBadge(p: Payment) {
    if (p.isVoided)
      return <Badge variant="destructive" className="text-[10px]">Dibatalkan</Badge>;
    if (p.approvalStatus === "approved")
      return <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]"><CheckCircle2 className="h-3 w-3 mr-1" />Disetujui</Badge>;
    if (p.approvalStatus === "pending_review")
      return <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-[10px]"><AlertCircle className="h-3 w-3 mr-1" />Menunggu</Badge>;
    if (p.approvalStatus === "rejected")
      return <Badge className="bg-red-100 text-red-800 border-red-200 text-[10px]"><XCircle className="h-3 w-3 mr-1" />Ditolak</Badge>;
    return <Badge variant="outline" className="text-[10px]">{p.approvalStatus}</Badge>;
  }

  function exportCsv() {
    if (!payments.length) return;
    const headers = ["No. Pembayaran", "Tenant", "Booth", "No. Penyewaan", "Metode", "Jumlah", "Diskon", "Sumber", "Status", "Tanggal"];
    const rows = payments.map((p) => [
      p.paymentNumber ?? p.receiptNumber ?? "-",
      p.tenantName ?? "-",
      p.boothNumber ?? "-",
      p.orderNumber ?? "-",
      METODE_LABELS[p.paymentMethod] ?? p.paymentMethod,
      p.amount,
      p.discountAmount,
      SOURCE_LABELS[p.sourceType ?? ""] ?? p.sourceType ?? "-",
      p.isVoided ? "Dibatalkan" : p.approvalStatus,
      p.paidAt ? new Date(p.paidAt).toLocaleString("id-ID") : "-",
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `riwayat-pembayaran-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Receipt className="h-6 w-6" />
            Riwayat Pembayaran
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Seluruh transaksi pembayaran tenant dari semua sumber
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!payments.length}>
            <Download className="h-4 w-4 mr-1" />
            Ekspor CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filter
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="lg:col-span-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Cari tenant / no. pembayaran..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  className="pl-8"
                />
              </div>
            </div>
            <Select value={metode} onValueChange={(v) => { setMetode(v); setPage(1); }}>
              <SelectTrigger>
                <SelectValue placeholder="Metode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semua">Semua Metode</SelectItem>
                <SelectItem value="tunai">Tunai</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
                <SelectItem value="qris">QRIS</SelectItem>
                <SelectItem value="edc">EDC</SelectItem>
                <SelectItem value="other">Lainnya</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semua">Semua Status</SelectItem>
                <SelectItem value="approved">Disetujui</SelectItem>
                <SelectItem value="pending_review">Menunggu</SelectItem>
                <SelectItem value="rejected">Ditolak</SelectItem>
                <SelectItem value="voided">Dibatalkan</SelectItem>
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={(v) => { setSource(v); setPage(1); }}>
              <SelectTrigger>
                <SelectValue placeholder="Sumber" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semua">Semua Sumber</SelectItem>
                <SelectItem value="pos">POS</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="bank_recon">Rekonsiliasi Bank</SelectItem>
                <SelectItem value="ocr">OCR Upload</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-1.5 items-center">
              <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="text-xs" />
              <span className="text-muted-foreground text-xs shrink-0">–</span>
              <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="text-xs" />
            </div>
          </div>
          {(search || metode !== "semua" || status !== "semua" || source !== "semua" || dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" onClick={resetFilter} className="mt-2 text-xs h-7">
              Reset Filter
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Tabel */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardDescription>
              {isLoading ? "Memuat..." : `${total.toLocaleString("id-ID")} transaksi ditemukan`}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">No. Pembayaran</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="w-32">No. Penyewaan</TableHead>
                  <TableHead className="w-24">Metode</TableHead>
                  <TableHead className="w-24">Sumber</TableHead>
                  <TableHead className="w-36">Tanggal sesuai sumber</TableHead>
                  <TableHead className="w-24">Bukti</TableHead>
                  <TableHead className="text-right w-32">Jumlah</TableHead>
                  <TableHead className="w-32">Status / Rekon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                      <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
                      Memuat data...
                    </TableCell>
                  </TableRow>
                ) : payments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                      Tidak ada data pembayaran
                    </TableCell>
                  </TableRow>
                ) : (
                  payments.map((p) => (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => selectPayment(p)}
                    >
                      <TableCell className="font-mono text-xs">
                        {p.paymentNumber ?? p.receiptNumber ?? (
                          <span className="text-muted-foreground italic">–</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{p.tenantName ?? "-"}</div>
                        {p.boothNumber && (
                          <div className="text-xs text-muted-foreground">Booth {p.boothNumber}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.orderNumber || <span className="text-muted-foreground italic">–</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {METODE_LABELS[p.paymentMethod] ?? p.paymentMethod}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {SOURCE_LABELS[p.sourceType ?? ""] ?? p.sourceType ?? "-"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        <div className="text-[10px] uppercase tracking-wide">{getPaymentDateLabel(p.sourceType)}</div>
                        <div>{formatTanggal(p.paidAt)}</div>
                      </TableCell>
                      <TableCell>
                        {p.proofUrl ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={(event) => {
                              event.stopPropagation();
                              setProofPreview(p.proofUrl);
                            }}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Lihat
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-sm">
                        {formatRupiah(p.amount)}
                        {p.discountAmount > 0 && (
                          <div className="text-xs text-green-600 font-normal">
                            -{formatRupiah(p.discountAmount)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          {statusBadge(p)}
                          {p.reconciled ? (
                            <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 text-[10px]">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Rekon
                            </Badge>
                          ) : p.bankMatchedByRule ? (
                            <Badge
                              variant="outline"
                              className="bg-amber-50 text-amber-800 border-amber-200 text-[10px]"
                              title="Mutasi bank sudah diposting oleh Rule AI, tetapi kandidat payment tenant tidak menjadi match canonical."
                            >
                              Cocok Bank
                            </Badge>
                          ) : null}
                          {p.isVoided && parseDuplicatePaymentId(p.voidReason) && (
                            <span className="text-[10px] text-muted-foreground">
                              Duplikat dari payment #{parseDuplicatePaymentId(p.voidReason)}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-sm text-muted-foreground">
                Halaman {page} dari {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  Sebelumnya
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Berikutnya
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={!!selectedPayment} onOpenChange={() => setSelectedPayment(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Detail Pembayaran
            </DialogTitle>
          </DialogHeader>
          {selectedPayment && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-muted-foreground text-xs">No. Pembayaran</p>
                  <p className="font-mono font-medium">{selectedPayment.paymentNumber ?? selectedPayment.receiptNumber ?? "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">No. Penyewaan</p>
                  <p className="font-mono">{selectedPayment.orderNumber || "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tenant</p>
                  <p className="font-medium">{selectedPayment.tenantName ?? "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Booth</p>
                  <p>{selectedPayment.boothNumber ?? "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Periode</p>
                  <p>{selectedPayment.periodLabel ?? "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Sumber</p>
                  <p>{SOURCE_LABELS[selectedPayment.sourceType ?? ""] ?? selectedPayment.sourceType ?? "-"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Metode Bayar</p>
                  <p>{METODE_LABELS[selectedPayment.paymentMethod] ?? selectedPayment.paymentMethod}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">{getPaymentDateLabel(selectedPayment.sourceType)}</p>
                  {dateEditing ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Input
                        type="date"
                        value={dateDraft}
                        onChange={(event) => setDateDraft(event.target.value)}
                        className="h-8 text-xs"
                        disabled={dateSaving}
                      />
                      <Button
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={savePaymentDate}
                        disabled={!dateDraft || dateSaving}
                      >
                        {dateSaving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        Simpan
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p>{formatTanggal(selectedPayment.paidAt)}</p>
                      {!selectedPayment.isVoided && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Edit tanggal pembayaran"
                          onClick={() => setDateEditing(true)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {selectedPayment.proofUrl && (
                  <div>
                    <p className="text-muted-foreground text-xs">Bukti Pembayaran</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 h-8 text-xs gap-1"
                      onClick={() => setProofPreview(selectedPayment.proofUrl)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Lihat bukti pembayaran
                    </Button>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs">Jumlah</p>
                  <p className="font-bold text-base">{formatRupiah(selectedPayment.amount)}</p>
                </div>
                {selectedPayment.discountAmount > 0 && (
                  <div>
                    <p className="text-muted-foreground text-xs">Diskon</p>
                    <p className="text-green-600">-{formatRupiah(selectedPayment.discountAmount)}</p>
                  </div>
                )}
                {selectedPayment.referenceNumber && (
                  <div>
                    <p className="text-muted-foreground text-xs">No. Referensi</p>
                    <p className="font-mono text-xs">{selectedPayment.referenceNumber}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs">Status</p>
                  <div className="mt-0.5">{statusBadge(selectedPayment)}</div>
                </div>
              </div>
              {selectedPayment.notes && (
                <div>
                  <p className="text-muted-foreground text-xs">Catatan</p>
                  <p className="bg-muted rounded px-2 py-1.5 text-xs mt-1">{selectedPayment.notes}</p>
                </div>
              )}
              {selectedPayment.isVoided && (selectedPayment.voidReason || duplicatePaymentId) && (
                <div className="bg-red-50 border border-red-100 rounded p-3">
                  {selectedPayment.voidReason && (
                    <>
                      <p className="text-red-700 text-xs font-medium">Alasan Pembatalan</p>
                      <p className="text-red-600 text-xs mt-1">{selectedPayment.voidReason}</p>
                    </>
                  )}
                  {duplicatePaymentId && (
                    <div className="mt-3 border-t border-red-200 pt-3">
                      <p className="text-red-700 text-xs font-medium">Pembayaran asli yang sudah disetujui</p>
                      {isDuplicateLoading ? (
                        <p className="text-red-500 text-xs mt-1">Memuat detail pembayaran #{duplicatePaymentId}...</p>
                      ) : duplicatePayment ? (
                        <div className="mt-1.5 rounded border border-red-200 bg-white/70 p-2.5 text-xs">
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                            <div>
                              <span className="text-muted-foreground">No. Pembayaran</span>
                              <p className="font-mono font-medium">
                                {duplicatePayment.paymentNumber ?? duplicatePayment.receiptNumber ?? `#${duplicatePayment.id}`}
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">ID Pembayaran</span>
                              <p className="font-mono font-medium">#{duplicatePayment.id}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Invoice</span>
                              <p className="font-mono">{duplicatePayment.invoiceNumber ?? duplicatePayment.invoiceId ?? "-"}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Tenant</span>
                              <p className="font-medium">{duplicatePayment.businessName ?? "-"}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Jumlah</span>
                              <p className="font-semibold">{formatRupiah(duplicatePayment.amount)}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Status</span>
                              <p className="mt-0.5">
                                <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">
                                  {duplicatePayment.approvalStatus === "approved" ? "Disetujui" : duplicatePayment.approvalStatus}
                                </Badge>
                              </p>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            {duplicatePayment.proofUrl ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs gap-1"
                                onClick={() => setProofPreview(duplicatePayment.proofUrl)}
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Tampilkan bukti bayar
                              </Button>
                            ) : (
                              <span className="text-red-500">Bukti bayar tidak tersedia</span>
                            )}
                            <span className="text-muted-foreground">
                              {formatTanggal(duplicatePayment.paidAt)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-red-500 text-xs mt-1">
                          Pembayaran #{duplicatePaymentId} tidak ditemukan atau tidak dapat diakses.
                        </p>
                      )}
                    </div>
                  )}
                  {selectedPayment.voidedAt && (
                    <p className="text-red-400 text-[10px] mt-1">{formatTanggal(selectedPayment.voidedAt)} oleh {selectedPayment.voidedBy ?? "-"}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!proofPreview} onOpenChange={(open) => { if (!open) setProofPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bukti Pembayaran</DialogTitle>
          </DialogHeader>
          {proofLoading && (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat bukti pembayaran...
            </div>
          )}
          {proofError && (
            <div role="alert" className="rounded border border-destructive/30 p-4 text-sm text-destructive">
              {proofError}
            </div>
          )}
          {proofBlobUrl && !proofError && (
            <iframe
              src={proofBlobUrl}
              title="Bukti pembayaran tenant"
              className="w-full h-[70vh] rounded border bg-muted"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setProofPreview(null)}>Tutup</Button>
            {proofBlobUrl && (
              <Button asChild>
                <a href={proofBlobUrl} target="_blank" rel="noopener noreferrer">
                  Buka di Tab Baru
                </a>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
