import React, { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileSpreadsheet, RefreshCw, ExternalLink, Upload, Download,
  CheckCircle2, XCircle, AlertCircle, Loader2, Info, Link2,
  Clock, Settings2, Eye, ChevronDown, ChevronUp, ArrowUpDown,
  Banknote, Ban, BadgeCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";

const API = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "") + "/api";

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtRp(v: number | string | null | undefined) {
  const n = parseFloat(String(v ?? "0")) || 0;
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(n);
}
function fmtTgl(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtWaktu(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncConfig {
  backgroundMode?: "on-demand" | "scheduled";
  enabled: boolean;
  spreadsheetId: string;
  sheetName: string;
  bankAccountId: string;
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastSyncResult: {
    success: boolean;
    newRows: number;
    totalRows: number;
    error?: string | null;
    at: string;
  } | null;
}

interface SyncInfo {
  serviceAccountEmail: string;
}

interface KPI {
  mutations: {
    unmatched: number;
    matched: number;
    approved: number;
    rejected: number;
    duplicateNeedReview: number;
    total: number;
  };
}

interface Mutation {
  id: number;
  transactionDate: string;
  description: string;
  amount: string;
  direction: string;
  status: string;
  providerName: string | null;
  providerOrderId: string | null;
  bankAccountId: string | null;
  mutationKey: string;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  unmatched: "Tidak Cocok",
  matched: "Ada Kandidat",
  approved: "Disetujui",
  rejected: "Ditolak",
  duplicate_need_review: "Duplikat",
  need_review: "Perlu Review",
};
const STATUS_CLASS: Record<string, string> = {
  unmatched: "bg-slate-100 text-slate-600 border-slate-200",
  matched: "bg-amber-100 text-amber-700 border-amber-200",
  approved: "bg-emerald-100 text-emerald-700 border-emerald-200",
  rejected: "bg-red-100 text-red-600 border-red-200",
  duplicate_need_review: "bg-orange-100 text-orange-700 border-orange-200",
  need_review: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

// ─── Service Account Info Panel ───────────────────────────────────────────────

function ServiceAccountPanel() {
  const { data } = useQuery<SyncInfo>({
    queryKey: ["bank-rekon-info"],
    queryFn: () => apiFetch("/api/bank-reconciliation/info").then((r) => r.json()),
    staleTime: 60_000,
  });

  const email = data?.serviceAccountEmail ?? "(memuat…)";
  const isConfigured = email !== "(tidak tersedia)" && email !== "(memuat…)";

  return (
    <Card className="border-blue-200 bg-blue-50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-blue-800">
          <Info className="h-4 w-4" />
          Service Account Google Sheets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {isConfigured ? (
          <>
            <p className="text-blue-700">
              Bagikan spreadsheet ke alamat email ini agar sinkronisasi dapat berjalan:
            </p>
            <div className="flex items-center gap-2 rounded-md border border-blue-300 bg-white px-3 py-2">
              <span className="flex-1 font-mono text-sm text-blue-900 break-all">{email}</span>
              <button
                type="button"
                className="text-xs text-blue-600 hover:text-blue-800 font-medium shrink-0"
                onClick={() => { navigator.clipboard?.writeText(email); }}
              >
                Salin
              </button>
            </div>
            <p className="text-blue-600 text-xs">
              Di Google Sheets: klik <strong>Bagikan</strong> → tempel email di atas → izin <em>Editor</em>.
            </p>
          </>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-800">GOOGLE_SERVICE_ACCOUNT_JSON belum dikonfigurasi</p>
              <p className="text-amber-700 text-xs mt-0.5">
                Minta admin Replit untuk menambahkan secret <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> di tab Secrets.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Sync Config Card ─────────────────────────────────────────────────────────

function SyncConfigCard({ cfg, isLoading }: { cfg?: SyncConfig; isLoading: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const isOnDemand = cfg?.backgroundMode === "on-demand";

  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetName, setSheetName] = useState("");

  // Initialize from loaded config
  React.useEffect(() => {
    if (cfg) {
      setSpreadsheetId(cfg.spreadsheetId ?? "");
      setSheetName(cfg.sheetName ?? "");
    }
  }, [cfg]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await apiFetch("/api/bank-reconciliation/sync-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: isOnDemand ? (cfg?.enabled ?? false) : true,
          spreadsheetId: spreadsheetId.trim(),
          sheetName: sheetName.trim(),
          bankAccountId: cfg?.bankAccountId ?? "",
          intervalMinutes: cfg?.intervalMinutes ?? 60,
        }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Gagal menyimpan"); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Konfigurasi disimpan", description: "ID spreadsheet berhasil disimpan." });
      qc.invalidateQueries({ queryKey: ["bank-rekon-sync-config"] });
    },
    onError: (e: Error) => {
      toast({ title: "Gagal menyimpan", description: e.message, variant: "destructive" });
    },
  });

  const extractId = (v: string) => {
    const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : v.trim();
  };
  const resolvedId = extractId(spreadsheetId);
  const sheetUrl = resolvedId ? `https://docs.google.com/spreadsheets/d/${resolvedId}` : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          Konfigurasi Spreadsheet
        </CardTitle>
        <CardDescription>
          {isOnDemand
            ? "Atur spreadsheet, lalu jalankan sinkronisasi melalui tombol Sinkron dari Sheet Sekarang."
            : "Hubungkan rekonsiliasi bank dengan Google Sheets untuk sinkronisasi otomatis."}
        </CardDescription>
        {isOnDemand && (
          <Badge variant="secondary" className="w-fit">On-demand · Sinkron manual</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Memuat konfigurasi…
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="spreadsheet-id">URL / ID Spreadsheet</Label>
              <Input
                id="spreadsheet-id"
                placeholder="https://docs.google.com/spreadsheets/d/... atau ID saja"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
              />
              {resolvedId && (
                <p className="text-xs text-muted-foreground">
                  ID: <code className="bg-muted px-1 rounded">{resolvedId}</code>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-name">Nama Sheet (opsional)</Label>
              <Input
                id="sheet-name"
                placeholder="Contoh: Mutasi Bank — kosongkan untuk sheet pertama"
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !spreadsheetId.trim()}
                size="sm"
              >
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Simpan Konfigurasi
              </Button>
              {sheetUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={sheetUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Buka Spreadsheet
                  </a>
                </Button>
              )}
            </div>

            {/* Last sync info */}
            {cfg?.lastSyncAt && (
              <div className="rounded-md border p-3 text-sm space-y-1">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span className="font-medium">Sinkronisasi terakhir:</span>
                  <span>{fmtWaktu(cfg.lastSyncAt)}</span>
                </div>
                {cfg.lastSyncResult && (
                  <div className={`flex items-center gap-1.5 text-xs ${cfg.lastSyncResult.success ? "text-emerald-700" : "text-red-600"}`}>
                    {cfg.lastSyncResult.success
                      ? <CheckCircle2 className="h-3.5 w-3.5" />
                      : <XCircle className="h-3.5 w-3.5" />}
                    {cfg.lastSyncResult.success
                      ? `${cfg.lastSyncResult.newRows} baris baru dari ${cfg.lastSyncResult.totalRows} total`
                      : (cfg.lastSyncResult.error ?? "Gagal")}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Action Buttons ───────────────────────────────────────────────────────────

function ActionButtons({
  cfg,
  onSyncDone,
  onExportDone,
}: {
  cfg?: SyncConfig;
  onSyncDone: () => void;
  onExportDone: (url: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const syncMutation = useMutation({
    mutationFn: async () => {
      const r = await apiFetch("/api/bank-reconciliation/sync-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Gagal sinkronisasi"); }
      return r.json() as Promise<{ success: boolean; newRows: number; totalRows: number; skipped: number; autoMatched: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Sinkronisasi berhasil",
        description: `${data.newRows} baris baru diimpor (${data.skipped} dilewati, ${data.autoMatched} auto-matched).`,
      });
      qc.invalidateQueries({ queryKey: ["bank-mutations"] });
      qc.invalidateQueries({ queryKey: ["bank-kpi"] });
      qc.invalidateQueries({ queryKey: ["bank-rekon-sync-config"] });
      onSyncDone();
    },
    onError: (e: Error) => {
      toast({ title: "Sinkronisasi gagal", description: e.message, variant: "destructive" });
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const spreadsheetId = cfg?.spreadsheetId;
      if (!spreadsheetId) throw new Error("Atur spreadsheet ID terlebih dahulu di Konfigurasi.");
      const r = await apiFetch("/api/bank-reconciliation/export-google-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetId }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Gagal ekspor"); }
      return r.json() as Promise<{ success: boolean; sheetTitle: string; rowCount: number; sheetUrl: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Ekspor berhasil",
        description: `${data.rowCount} baris diekspor ke sheet "${data.sheetTitle}".`,
      });
      onExportDone(data.sheetUrl);
    },
    onError: (e: Error) => {
      toast({ title: "Ekspor gagal", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="default"
        size="sm"
        onClick={() => syncMutation.mutate()}
        disabled={syncMutation.isPending}
      >
        {syncMutation.isPending
          ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
          : <RefreshCw className="h-4 w-4 mr-2" />}
        Sinkron dari Sheet Sekarang
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => exportMutation.mutate()}
        disabled={exportMutation.isPending}
      >
        {exportMutation.isPending
          ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
          : <Upload className="h-4 w-4 mr-2" />}
        Ekspor Laporan ke Sheets
      </Button>
    </div>
  );
}

// ─── KPI Cards ────────────────────────────────────────────────────────────────

function KpiCards() {
  const { data, isLoading } = useQuery<KPI>({
    queryKey: ["bank-kpi"],
    queryFn: () => apiFetch("/api/bank-reconciliation/kpi").then((r) => r.json()),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="pt-5 pb-4">
              <div className="h-7 bg-muted rounded mb-1" />
              <div className="h-4 bg-muted rounded w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const m = data?.mutations;
  const cards = [
    { label: "Total Mutasi", value: m?.total ?? 0, icon: <ArrowUpDown className="h-4 w-4" />, cls: "text-slate-700" },
    { label: "Tidak Cocok", value: m?.unmatched ?? 0, icon: <AlertCircle className="h-4 w-4" />, cls: "text-slate-600" },
    { label: "Ada Kandidat", value: m?.matched ?? 0, icon: <Link2 className="h-4 w-4" />, cls: "text-amber-600" },
    { label: "Disetujui", value: m?.approved ?? 0, icon: <BadgeCheck className="h-4 w-4" />, cls: "text-emerald-600" },
    { label: "Perlu Review", value: m?.duplicateNeedReview ?? 0, icon: <Ban className="h-4 w-4" />, cls: "text-orange-600" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4 pb-3">
            <div className={`flex items-center gap-1.5 mb-1 ${c.cls}`}>
              {c.icon}
              <span className="text-2xl font-bold">{c.value}</span>
            </div>
            <p className="text-xs text-muted-foreground">{c.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Mutations Table ──────────────────────────────────────────────────────────

function MutationsTable() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = new URLSearchParams();
  if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);

  const { data: mutations, isLoading, refetch } = useQuery<Mutation[]>({
    queryKey: ["bank-mutations", statusFilter, dateFrom, dateTo],
    queryFn: () => apiFetch(`/api/bank-reconciliation/mutations?${params}`).then((r) => r.json()),
    staleTime: 15_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Banknote className="h-4 w-4 text-muted-foreground" />
            Mutasi Bank
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 pt-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            <option value="all">Semua Status</option>
            <option value="unmatched">Tidak Cocok</option>
            <option value="matched">Ada Kandidat</option>
            <option value="approved">Disetujui</option>
            <option value="rejected">Ditolak</option>
            <option value="duplicate_need_review">Duplikat</option>
          </select>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 text-xs w-auto"
            placeholder="Dari tanggal"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 text-xs w-auto"
            placeholder="Sampai tanggal"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Memuat mutasi…
          </div>
        ) : !mutations || mutations.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <FileSpreadsheet className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">Belum ada mutasi bank.</p>
            <p className="text-xs mt-1">Gunakan tombol "Sinkron dari Sheet" untuk mengimpor data.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">Tanggal</th>
                  <th className="px-4 py-2.5 text-left font-medium">Keterangan</th>
                  <th className="px-4 py-2.5 text-right font-medium">Nominal</th>
                  <th className="px-4 py-2.5 text-center font-medium">Arah</th>
                  <th className="px-4 py-2.5 text-center font-medium">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {mutations.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {fmtTgl(m.transactionDate)}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <p className="truncate text-xs">{m.description}</p>
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs font-medium whitespace-nowrap">
                      {fmtRp(m.amount)}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        m.direction === "IN"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-red-100 text-red-600"
                      }`}>
                        {m.direction === "IN" ? "Masuk" : "Keluar"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_CLASS[m.status] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}>
                        {STATUS_LABEL[m.status] ?? m.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {m.providerName ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-muted-foreground border-t">
              Menampilkan {mutations.length} mutasi (maks 500)
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RekonsiliasiBank() {
  const [lastSheetUrl, setLastSheetUrl] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data: syncConfig, isLoading: isSyncConfigLoading } = useQuery<SyncConfig>({
    queryKey: ["bank-rekon-sync-config"],
    queryFn: () => apiFetch("/api/bank-reconciliation/sync-config").then((r) => r.json()),
    staleTime: 30_000,
  });
  const isOnDemand = syncConfig?.backgroundMode === "on-demand";

  const handleSyncDone = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["bank-mutations"] });
    qc.invalidateQueries({ queryKey: ["bank-kpi"] });
  }, [qc]);

  const handleExportDone = useCallback((url: string) => {
    setLastSheetUrl(url);
  }, []);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
            Rekonsiliasi Bank — Google Sheets
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isOnDemand
              ? "Sinkronisasi mutasi bank dari Google Sheets dan ekspor laporan rekonsiliasi sesuai permintaan."
              : "Sinkronisasi mutasi bank dari Google Sheets dan ekspor laporan rekonsiliasi secara otomatis."}
          </p>
        </div>
        {lastSheetUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={lastSheetUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Buka Laporan Terakhir
            </a>
          </Button>
        )}
      </div>

      {/* Service Account Info */}
      <ServiceAccountPanel />

      {/* KPI */}
      <KpiCards />

      {/* Config + Actions */}
      <div className="grid gap-4 md:grid-cols-2">
        <SyncConfigCard cfg={syncConfig} isLoading={isSyncConfigLoading} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              Tindakan
            </CardTitle>
            <CardDescription>
              Sinkronisasi baris baru dari spreadsheet atau ekspor rekonsiliasi ke sheet laporan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionButtons cfg={syncConfig} onSyncDone={handleSyncDone} onExportDone={handleExportDone} />
            <Separator />
            <div className="space-y-2 text-xs text-muted-foreground">
              <p><strong>Sinkron dari Sheet:</strong> mengimpor baris mutasi baru dari spreadsheet input, melewati baris yang sudah ada (berdasarkan mutation_key), lalu menjalankan auto-matching.</p>
              <p><strong>Ekspor Laporan:</strong> menulis data rekonsiliasi saat ini (status, match, invoice) ke sheet baru dalam spreadsheet yang sama.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Mutations Table */}
      <MutationsTable />

      {/* Cara Setup */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Info className="h-4 w-4" />
            Cara Setup Google Sheets
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1.5">
          <p>1. Tambahkan secret <code className="bg-muted px-1 rounded">GOOGLE_SERVICE_ACCOUNT_JSON</code> di Replit Secrets dengan konten JSON dari Service Account Google Cloud.</p>
          <p>2. Buat atau buka Google Sheets, catat URL-nya, lalu bagikan ke email Service Account (lihat panel di atas) dengan izin Editor.</p>
          <p>3. Tempel URL spreadsheet di kolom Konfigurasi dan klik Simpan.</p>
          <p>4. Klik "Sinkron dari Sheet" untuk mengimpor mutasi bank, atau "Ekspor Laporan" untuk menulis rekap ke Sheets.</p>
        </CardContent>
      </Card>
    </div>
  );
}
