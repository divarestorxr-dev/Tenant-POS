import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import {
  MessageCircle, Send, AlertTriangle, CheckCircle2, Wifi, WifiOff,
  Loader2, RefreshCw, Megaphone, Link2, PhoneCall, History, XCircle, Clock,
  CalendarClock, BellOff, BellRing, Users, Plus, Trash2,
} from "lucide-react";
import { useSite } from "@/contexts/site-context";

function fmtRp(v: string | number | null | undefined) {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(n);
}

function fmtDate(v: string | Date | null | undefined, fallback = "-") {
  if (!v) return fallback;
  return new Date(v).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDatetime(v: string | Date | null | undefined) {
  if (!v) return null;
  return new Date(v).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface WaStatus {
  configured: boolean;
  connected: boolean | null;
  provider: string;
  message: string;
  queueCount?: number;
  onlineWorkers?: number;
  workers?: Array<Record<string, unknown>>;
}

interface BlastResult {
  ok: boolean;
  sent?: number;
  failed?: number;
  total?: number;
  skipped?: boolean;
  message?: string;
  error?: string;
}

interface Invoice {
  id: number;
  invoiceNumber: string;
  businessName: string;
  ownerName: string;
  phone: string | null;
  totalAmount: string;
  outstandingAmount: string | null;
  dueDate: string | null;
  status: string;
}

interface ReminderInvoice {
  id: number;
  invoiceNumber: string;
  businessName: string;
  ownerName: string;
  phone: string | null;
  dueDate: string | null;
  status: string;
  totalAmount: string;
  outstandingAmount: string | null;
  dueReminder3dAt: string | null;
  dueReminder1dAt: string | null;
  lastOverdueReminderAt: string | null;
}

interface WaLog {
  id: number;
  phone: string;
  messageType: string;
  status: "sent" | "failed" | "skipped";
  errorMessage: string | null;
  sentBy: string | null;
  createdAt: string;
}

interface WaGroup {
  label: string;
  jid: string;
}

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  invoice: "Notifikasi Invoice",
  overdue_reminder: "Pengingat Overdue",
  due_reminder: "Pengingat Jatuh Tempo",
  blast_overdue: "Blast Overdue",
  blast_link: "Blast Link Bayar",
  test: "Pesan Tes",
  payment_confirmation: "Konfirmasi Bayar",
};

function StatusBadge({ status }: { status: WaLog["status"] }) {
  if (status === "sent") return <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]"><CheckCircle2 className="h-2.5 w-2.5 mr-1" />Terkirim</Badge>;
  if (status === "failed") return <Badge className="bg-red-100 text-red-700 border-red-200 text-[10px]"><XCircle className="h-2.5 w-2.5 mr-1" />Gagal</Badge>;
  return <Badge className="bg-gray-100 text-gray-500 border-gray-200 text-[10px]"><Clock className="h-2.5 w-2.5 mr-1" />Dilewati</Badge>;
}

function InvoiceStatusBadge({ status }: { status: string }) {
  if (status === "overdue") return <Badge className="bg-red-100 text-red-700 border-red-200 text-[10px]">Overdue</Badge>;
  if (status === "partial") return <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-[10px]">Sebagian</Badge>;
  return <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200 text-[10px]">Belum Bayar</Badge>;
}

function ReminderCell({ sentAt }: { sentAt: string | null }) {
  if (sentAt) {
    return (
      <div className="flex items-center gap-1 text-green-700">
        <BellRing className="h-3 w-3 shrink-0" />
        <span className="text-[10px] leading-tight">{fmtDatetime(sentAt)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-gray-400">
      <BellOff className="h-3 w-3 shrink-0" />
      <span className="text-[10px]">Belum</span>
    </div>
  );
}

export default function WhatsAppSend() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeSite: currentSite } = useSite();

  const [testPhone, setTestPhone] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [blastResult, setBlastResult] = useState<BlastResult | null>(null);
  const [blastLinkResult, setBlastLinkResult] = useState<BlastResult | null>(null);
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const [newGroupJid, setNewGroupJid] = useState("");

  const { data: waGroups = [] } = useQuery<WaGroup[]>({
    queryKey: ["settings-wa-groups"],
    queryFn: () => apiFetch("/api/settings").then(r => r.json()).then(d => d.waGroups ?? []),
  });

  const saveGroupsMut = useMutation({
    mutationFn: (groups: WaGroup[]) =>
      apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waGroups: groups }),
      }).then(r => {
        if (!r.ok) throw new Error("Gagal menyimpan");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings-wa-groups"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => toast({ title: "Gagal", description: "Gagal menyimpan daftar grup.", variant: "destructive" }),
  });

  const handleAddGroup = () => {
    const label = newGroupLabel.trim();
    const jid = newGroupJid.trim();
    if (!label || !jid) {
      toast({ title: "Lengkapi data", description: "Nama grup dan Group JID wajib diisi.", variant: "destructive" });
      return;
    }
    if (!jid.includes("@g.")) {
      toast({ title: "Format JID salah", description: "Group JID harus diakhiri @g.us (contoh: 12036xxxx@g.us).", variant: "destructive" });
      return;
    }
    saveGroupsMut.mutate([...waGroups, { label, jid }]);
    setNewGroupLabel("");
    setNewGroupJid("");
  };

  const handleRemoveGroup = (jid: string) => {
    saveGroupsMut.mutate(waGroups.filter(g => g.jid !== jid));
  };

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<WaStatus>({
    queryKey: ["wa-status"],
    queryFn: () => apiFetch("/api/whatsapp/status").then(r => r.json()),
    refetchInterval: 60000,
  });

  const { data: invoicesData, isLoading: invoicesLoading } = useQuery<{ data: Invoice[] }>({
    queryKey: ["invoices-overdue", currentSite?.id],
    queryFn: () => apiFetch(`/api/tenant-invoices?status=overdue&limit=50`).then(r => r.json()),
  });

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery<{ data: WaLog[] }>({
    queryKey: ["wa-logs", currentSite?.id],
    queryFn: () => apiFetch("/api/whatsapp/logs").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: reminderData, isLoading: reminderLoading, refetch: refetchReminder } = useQuery<{ data: ReminderInvoice[] }>({
    queryKey: ["wa-reminder-status", currentSite?.id],
    queryFn: () => apiFetch("/api/whatsapp/reminder-status").then(r => r.json()),
    refetchInterval: 60000,
  });

  const overdueInvoices = invoicesData?.data ?? [];
  const reminderInvoices = reminderData?.data ?? [];

  const blastOverdueMut = useMutation({
    mutationFn: () => apiFetch("/api/whatsapp/blast-overdue", { method: "POST" }).then(r => r.json()),
    onSuccess: (data: BlastResult) => {
      setBlastResult(data);
      void qc.invalidateQueries({ queryKey: ["wa-logs"] });
      void qc.invalidateQueries({ queryKey: ["wa-reminder-status"] });
      toast({
        title: data.skipped ? "WA Tidak Terkirim" : data.ok ? "Blast Selesai" : "Blast Gagal",
        description: data.message ?? data.error,
        variant: data.ok && !data.skipped ? "default" : "destructive",
      });
    },
    onError: () => toast({ title: "Gagal", description: "Terjadi kesalahan saat blast WA.", variant: "destructive" }),
  });

  const blastLinkMut = useMutation({
    mutationFn: () => apiFetch("/api/whatsapp/blast-link-unpaid", { method: "POST" }).then(r => r.json()),
    onSuccess: (data: BlastResult) => {
      setBlastLinkResult(data);
      void qc.invalidateQueries({ queryKey: ["wa-logs"] });
      toast({
        title: data.skipped ? "WA Tidak Terkirim" : data.ok ? "Blast Link Selesai" : "Blast Gagal",
        description: data.message ?? data.error,
        variant: data.ok && !data.skipped ? "default" : "destructive",
      });
    },
    onError: () => toast({ title: "Gagal", description: "Terjadi kesalahan saat blast link.", variant: "destructive" }),
  });

  const testSendMut = useMutation({
    mutationFn: () =>
      apiFetch("/api/whatsapp/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: testPhone, message: testMsg || undefined }),
      }).then(r => r.json()),
    onSuccess: (data: { ok: boolean; pending?: boolean; isGroup?: boolean; message?: string; detail?: string; error?: string }) => {
      void qc.invalidateQueries({ queryKey: ["wa-logs"] });
      if (data.pending) {
        toast({
          title: data.isGroup ? "🕐 Pesan ke Grup Masuk Antrian" : "🕐 Pesan Masuk Antrian CST WA Gateway",
          description: data.message ?? "Pesan sudah diterima CST WA Gateway dan akan dikirim ke penerima dalam beberapa saat.",
        });
      } else {
        toast({
          title: data.ok ? "✅ Pesan Terkirim" : "Gagal Kirim",
          description: data.message ?? data.error,
          variant: data.ok ? "default" : "destructive",
        });
      }
    },
    onError: () => toast({ title: "Gagal", description: "Terjadi kesalahan.", variant: "destructive" }),
  });

  const sendInvoiceMut = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/whatsapp/invoice/${id}/overdue-reminder`, { method: "POST" }).then(r => r.json()),
    onSuccess: (data: { ok: boolean; pending?: boolean; message?: string; error?: string }) => {
      void qc.invalidateQueries({ queryKey: ["wa-logs"] });
      void qc.invalidateQueries({ queryKey: ["wa-reminder-status"] });
      if (data.pending) {
        toast({
          title: "🕐 Pengingat Masuk Antrian CST WA Gateway",
          description: "Pesan sudah diterima CST WA Gateway dan akan dikirim ke tenant dalam beberapa saat.",
        });
      } else {
        toast({
          title: data.ok ? "Pengingat Terkirim" : "Gagal",
          description: data.message ?? data.error,
          variant: data.ok ? "default" : "destructive",
        });
      }
    },
  });

  const statusColor = status?.connected === true
    ? "text-green-600"
    : status?.connected === false
      ? "text-red-500"
      : "text-yellow-500";

  const StatusIcon = status?.connected === true ? Wifi : status?.connected === false ? WifiOff : Wifi;

  const reminderSent = reminderInvoices.filter(i => i.dueReminder3dAt || i.dueReminder1dAt || i.lastOverdueReminderAt).length;
  const reminderNone = reminderInvoices.filter(i => !i.dueReminder3dAt && !i.dueReminder1dAt && !i.lastOverdueReminderAt).length;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-green-600" />
          Kirim WhatsApp
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Kirim notifikasi, pengingat, dan blast pesan ke tenant via WhatsApp melalui CST WA Gateway.
        </p>
      </div>

      {/* Status Koneksi */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Status Koneksi WhatsApp Tenant POS</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void refetchStatus(); void qc.invalidateQueries({ queryKey: ["wa-status"] }); }}
              disabled={statusLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${statusLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {statusLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Memeriksa koneksi...
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <StatusIcon className={`h-5 w-5 mt-0.5 shrink-0 ${statusColor}`} />
                <div className="flex-1 min-w-0">
                  <p className={`font-medium text-sm ${statusColor}`}>
                    {status?.connected === true ? "Terhubung — WhatsApp siap digunakan" : status?.connected === false ? "Tidak Terhubung — WhatsApp tidak siap" : "Status koneksi belum dapat dipastikan"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{status?.message}</p>
                  <p className="text-xs text-muted-foreground mt-1">{status?.connected === true ? "Perangkat online menurut CST WA Gateway. Pesan dapat dikirim melalui perangkat ini." : status?.connected === false ? "Perangkat tidak online atau belum terdaftar. Periksa pengaturan dan koneksi WhatsApp." : "Sistem belum berhasil membaca status perangkat. Ini bukan bukti bahwa WhatsApp terputus; periksa izin API Client dan coba Refresh."}</p>
                  {status?.onlineWorkers != null && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Worker online: {status.onlineWorkers}
                      {status.queueCount != null && ` · Antrian: ${status.queueCount}`}
                    </p>
                  )}
                  {!status?.configured && (
                    <p className="text-xs text-amber-600 mt-1">
                      ⚠ CST_WA_GATEWAY_TOKEN belum dikonfigurasi untuk Tenant-POS.
                    </p>
                  )}
                </div>
              </div>

              {(status?.queueCount ?? 0) > 50 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-2">
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    Antrian gateway tinggi — {(status?.queueCount ?? 0).toLocaleString("id-ID")} pesan
                  </p>
                  <p>
                    Pengelolaan device, reconnect, dan retry dilakukan terpusat di CST WA Gateway agar
                    kredensial admin gateway tidak dibagikan ke Tenant-POS.
                  </p>
                  <a
                    href="https://wa.cstlogistic.co.id/admin"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-medium"
                  >
                    Buka panel CST WA Gateway
                  </a>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Blast Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Blast Overdue */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Blast Pengingat Overdue
            </CardTitle>
            <CardDescription className="text-xs">
              Kirim pesan pengingat ke semua tenant yang invoicenya sudah melewati jatuh tempo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="text-xs">
                {overdueInvoices.length} invoice overdue
              </Badge>
            </div>
            {blastResult && (
              <div className={`text-xs p-2 rounded border ${blastResult.ok && !blastResult.skipped ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"}`}>
                {blastResult.message}
              </div>
            )}
            <Button
              className="w-full"
              variant="destructive"
              size="sm"
              onClick={() => blastOverdueMut.mutate()}
              disabled={blastOverdueMut.isPending || overdueInvoices.length === 0}
            >
              {blastOverdueMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Megaphone className="h-3.5 w-3.5 mr-1.5" />}
              {blastOverdueMut.isPending ? "Mengirim..." : "Blast Pengingat Overdue"}
            </Button>
          </CardContent>
        </Card>

        {/* Blast Link Pembayaran */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Link2 className="h-4 w-4 text-blue-500" />
              Blast Link Pembayaran
            </CardTitle>
            <CardDescription className="text-xs">
              Kirim link pembayaran ke semua tenant dengan invoice belum lunas (unpaid, partial, overdue).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">
                Belum lunas semua status
              </Badge>
            </div>
            {blastLinkResult && (
              <div className={`text-xs p-2 rounded border ${blastLinkResult.ok && !blastLinkResult.skipped ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"}`}>
                {blastLinkResult.message}
              </div>
            )}
            <Button
              className="w-full"
              variant="outline"
              size="sm"
              onClick={() => blastLinkMut.mutate()}
              disabled={blastLinkMut.isPending}
            >
              {blastLinkMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
              {blastLinkMut.isPending ? "Mengirim..." : "Blast Link Pembayaran"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Kirim Pesan Tes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-green-600" />
            Kirim Pesan Uji Coba
          </CardTitle>
          <CardDescription className="text-xs">
            Kirim pesan tes ke nomor HP tertentu untuk memverifikasi koneksi WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Nomor HP Tujuan / Group JID</Label>
              <Input
                placeholder="0812xxxx / 628xx / 12036xxxx@g.us"
                value={testPhone}
                onChange={e => setTestPhone(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </div>
          {waGroups.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Atau pilih grup tersimpan</Label>
              <div className="flex flex-wrap gap-1.5">
                {waGroups.map(g => (
                  <Badge
                    key={g.jid}
                    variant="outline"
                    className={`cursor-pointer text-xs ${testPhone === g.jid ? "bg-green-100 border-green-300 text-green-700" : ""}`}
                    onClick={() => setTestPhone(g.jid)}
                  >
                    <Users className="h-3 w-3 mr-1" />
                    {g.label}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Pesan (opsional — dikosongkan = pesan default)</Label>
            <Textarea
              placeholder="Ketik pesan tes di sini, atau kosongkan untuk menggunakan pesan default..."
              value={testMsg}
              onChange={e => setTestMsg(e.target.value)}
              rows={3}
              className="text-sm resize-none"
            />
          </div>
          <Button
            size="sm"
            onClick={() => testSendMut.mutate()}
            disabled={testSendMut.isPending || !testPhone.trim()}
          >
            {testSendMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
            {testSendMut.isPending ? "Mengirim..." : "Kirim Pesan Tes"}
          </Button>
        </CardContent>
      </Card>

      {/* Grup WA Favorit */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-500" />
            Grup WhatsApp Favorit
          </CardTitle>
          <CardDescription className="text-xs">
            Simpan Group JID (format: xxxxxxxxx@g.us) supaya bisa dipilih cepat saat kirim pesan tes ke grup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {waGroups.length > 0 && (
            <div className="divide-y text-sm border rounded-md">
              {waGroups.map(g => (
                <div key={g.jid} className="flex items-center justify-between px-3 py-2 gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{g.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{g.jid}</p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={() => handleRemoveGroup(g.jid)}
                    disabled={saveGroupsMut.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_auto] gap-2">
            <Input
              placeholder="Nama grup (mis. Grup Admin Mall)"
              value={newGroupLabel}
              onChange={e => setNewGroupLabel(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="Group JID (mis. 12036xxxx@g.us)"
              value={newGroupJid}
              onChange={e => setNewGroupJid(e.target.value)}
              className="h-8 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddGroup}
              disabled={saveGroupsMut.isPending}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Tambah
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Daftar Invoice Overdue */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Invoice Overdue — Kirim Per Tenant
          </CardTitle>
          <CardDescription className="text-xs">
            Klik tombol kirim di baris untuk mengirim pengingat ke masing-masing tenant.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat data...
            </div>
          ) : overdueInvoices.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              Tidak ada invoice overdue saat ini.
            </div>
          ) : (
            <div className="divide-y text-sm">
              {overdueInvoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between py-3 gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{inv.businessName}</p>
                    <p className="text-xs text-muted-foreground">{inv.invoiceNumber} · {fmtRp(inv.outstandingAmount ?? inv.totalAmount)}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.phone ? inv.phone : <span className="text-red-400">Nomor tidak ada</span>}
                      {inv.dueDate && ` · Jatuh tempo: ${new Date(inv.dueDate).toLocaleDateString("id-ID")}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 h-7 text-xs"
                    disabled={!inv.phone || sendInvoiceMut.isPending}
                    onClick={() => sendInvoiceMut.mutate(inv.id)}
                  >
                    <Send className="h-3 w-3 mr-1" />
                    Kirim WA
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Status Reminder Per Invoice */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-purple-500" />
                Status Reminder Per Invoice
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Kapan reminder H-3, H-1, dan overdue dikirim untuk setiap invoice yang belum lunas.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetchReminder()}
              disabled={reminderLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reminderLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {reminderLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat data...
            </div>
          ) : reminderInvoices.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              Tidak ada invoice belum lunas saat ini.
            </div>
          ) : (
            <>
              {/* Ringkasan */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">
                  {reminderInvoices.length} invoice belum lunas
                </Badge>
                {reminderSent > 0 && (
                  <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">
                    <BellRing className="h-3 w-3 mr-1" />
                    {reminderSent} sudah terkirim reminder
                  </Badge>
                )}
                {reminderNone > 0 && (
                  <Badge className="bg-gray-100 text-gray-500 border-gray-200 text-xs">
                    <BellOff className="h-3 w-3 mr-1" />
                    {reminderNone} belum ada reminder
                  </Badge>
                )}
              </div>

              {/* Tabel */}
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">Tenant</th>
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">No Invoice</th>
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">Jatuh Tempo</th>
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">Status</th>
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-0.5 text-blue-600">H-3</span>
                      </th>
                      <th className="text-left font-medium text-muted-foreground pb-2 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-0.5 text-orange-600">H-1</span>
                      </th>
                      <th className="text-left font-medium text-muted-foreground pb-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-0.5 text-red-600">Overdue</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {reminderInvoices.map((inv) => {
                      const isOverdue = inv.status === "overdue";
                      const dueDate = inv.dueDate ? new Date(inv.dueDate) : null;
                      const today = new Date();
                      const daysUntilDue = dueDate
                        ? Math.ceil((dueDate.getTime() - today.setHours(0,0,0,0)) / 86400000)
                        : null;

                      return (
                        <tr key={inv.id} className={`${isOverdue ? "bg-red-50/40" : ""}`}>
                          <td className="py-2.5 pr-3">
                            <p className="font-medium truncate max-w-[120px]">{inv.businessName}</p>
                            {inv.phone
                              ? <p className="text-muted-foreground text-[10px]">{inv.phone}</p>
                              : <p className="text-red-400 text-[10px]">No HP kosong</p>
                            }
                          </td>
                          <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">{inv.invoiceNumber}</td>
                          <td className="py-2.5 pr-3 whitespace-nowrap">
                            <p>{fmtDate(inv.dueDate)}</p>
                            {daysUntilDue !== null && !isOverdue && (
                              <p className={`text-[10px] ${daysUntilDue <= 1 ? "text-red-500 font-medium" : daysUntilDue <= 3 ? "text-orange-500" : "text-muted-foreground"}`}>
                                {daysUntilDue === 0 ? "Hari ini" : daysUntilDue < 0 ? `${Math.abs(daysUntilDue)} hari lewat` : `${daysUntilDue} hari lagi`}
                              </p>
                            )}
                          </td>
                          <td className="py-2.5 pr-3">
                            <InvoiceStatusBadge status={inv.status} />
                          </td>
                          <td className="py-2.5 pr-3">
                            <ReminderCell sentAt={inv.dueReminder3dAt} />
                          </td>
                          <td className="py-2.5 pr-3">
                            <ReminderCell sentAt={inv.dueReminder1dAt} />
                          </td>
                          <td className="py-2.5">
                            <ReminderCell sentAt={inv.lastOverdueReminderAt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-[10px] text-muted-foreground mt-3">
                * Reminder H-3 dan H-1 dikirim otomatis oleh sistem 30 menit setelah server start dan setiap 12 jam.
                Overdue dikirim saat invoice melewati jatuh tempo.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Riwayat Pengiriman WA */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4 text-blue-500" />
                Riwayat Pengiriman WA
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                100 pengiriman terakhir. Diperbarui otomatis setiap 30 detik.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetchLogs()}
              disabled={logsLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${logsLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat riwayat...
            </div>
          ) : !logsData?.data.length ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <History className="h-5 w-5 opacity-30" />
              Belum ada riwayat pengiriman WA.
            </div>
          ) : (
            <div className="divide-y text-sm max-h-80 overflow-y-auto">
              {logsData.data.map((log) => (
                <div key={log.id} className="flex items-start gap-3 py-2.5">
                  <StatusBadge status={log.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-xs">
                        {MESSAGE_TYPE_LABELS[log.messageType] ?? log.messageType}
                      </span>
                      <span className="text-xs text-muted-foreground">→ {log.phone}</span>
                    </div>
                    {log.errorMessage && (
                      <p className="text-xs text-red-500 mt-0.5 truncate">{log.errorMessage}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(log.createdAt).toLocaleString("id-ID")}
                      {log.sentBy && ` · oleh ${log.sentBy}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
