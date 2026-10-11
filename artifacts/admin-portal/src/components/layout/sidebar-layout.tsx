import React, { Suspense, useRef, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Building2, Store, CalendarRange, Calculator, BarChart3, LogOut, FileText, Shield, ChevronDown, GitCompare, Dumbbell, MapPin, Check, Layers, ClipboardCheck, LayoutGrid, Users, Bell, AlertTriangle, Clock, LayoutDashboard, Settings, MessageCircle, BookTemplate, ClipboardList, FileSpreadsheet, Landmark, Database, FileSignature, BookOpen, TrendingDown, TrendingUp, History, ScanLine } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useAuth, useLogout, ROLE_LABELS, type UserRole } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSite, type MallSite, ALL_SITES_SENTINEL } from "@/contexts/site-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { arrayField } from "@/lib/api-shape";

const ROLE_COLORS: Record<UserRole, string> = {
  owner:       "bg-purple-100 text-purple-800",
  admin:       "bg-blue-100 text-blue-800",
  finance:     "bg-green-100 text-green-800",
  cashier:     "bg-orange-100 text-orange-800",
  tenant_user: "bg-teal-100 text-teal-800",
};

const SITE_TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  mall_tenant: {
    label: "Mal",
    icon: <Building2 className="h-3.5 w-3.5" />,
    color: "text-blue-700",
    bg: "bg-blue-50 border-blue-200",
  },
  sport_center: {
    label: "Sport",
    icon: <Dumbbell className="h-3.5 w-3.5" />,
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
  },
  all: {
    label: "Semua",
    icon: <Layers className="h-3.5 w-3.5" />,
    color: "text-slate-600",
    bg: "bg-slate-50 border-slate-200",
  },
};

function SiteIcon({ type, className }: { type: string; className?: string }) {
  const cfg = SITE_TYPE_CONFIG[type];
  if (!cfg) return <MapPin className={className ?? "h-3.5 w-3.5"} />;
  return <span className={className}>{cfg.icon}</span>;
}

function SiteTypeBadge({ type }: { type: string }) {
  const cfg = SITE_TYPE_CONFIG[type];
  if (!cfg) return <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal">{type}</Badge>;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px] font-semibold tracking-wide ${cfg.color} ${cfg.bg}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

// Kelompokkan sites berdasarkan tipe
function groupSites(sites: MallSite[]) {
  const groups: { label: string; sites: MallSite[] }[] = [];
  const mal = sites.filter(s => s.type === "mall_tenant");
  const sport = sites.filter(s => s.type === "sport_center");
  const other = sites.filter(s => s.type !== "mall_tenant" && s.type !== "sport_center");
  if (mal.length) groups.push({ label: "Mal", sites: mal });
  if (sport.length) groups.push({ label: "Sport Center", sites: sport });
  if (other.length) groups.push({ label: "Lainnya", sites: other });
  return groups;
}

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <SidebarNav>{children}</SidebarNav>
    </SidebarProvider>
  );
}

function SidebarNav({ children }: { children: React.ReactNode }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => { if (isMobile) setOpenMobile(false); };

  const [location] = useLocation();
  const { data: user } = useAuth();
  const logout = useLogout();
  const { activeSite, sites, setActiveSite } = useSite();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const role = user?.role as UserRole | undefined;
  const can = (...roles: UserRole[]) => !!role && roles.includes(role);
  const [backgroundReady, setBackgroundReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ready = () => {
      if (!cancelled) setBackgroundReady(true);
    };
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(ready, { timeout: 1500 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(id);
      };
    }
    const id = window.setTimeout(ready, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [activeSite?.id, location]);

  const { data: pendingCount = 0 } = useQuery<number>({
    queryKey: ["pending-payments-sidebar-count", activeSite?.id ?? null],
    queryFn: async () => {
      const res = await apiFetch("/api/pending-payments/count");
      if (!res.ok) return 0;
      const d = await res.json();
      return d.count ?? 0;
    },
    refetchInterval: 30_000,
    enabled: backgroundReady && can("owner", "admin", "finance") && !!activeSite,
  });

  // ── Polling: jumlah calon tenant pending (self-register) ──────────────────
  type PendingRegistrationData = { success: boolean; pendingCount: number; latestCreatedAt: string | null };
  const prevPendingRegistrationCount = useRef<number | undefined>(undefined);

  const { data: pendingRegistrationData } = useQuery<PendingRegistrationData>({
    queryKey: ["pending-registration-count", activeSite?.id ?? null],
    queryFn: async () => {
      const res = await apiFetch("/api/calon-tenant/pending-count");
      if (!res.ok) throw new Error("Gagal mengambil data pending registrasi");
      return res.json();
    },
    refetchInterval: 30_000,
    enabled: backgroundReady && can("owner", "admin") && !!activeSite,
  });

  const pendingRegistrationCount = pendingRegistrationData?.pendingCount ?? 0;

  useEffect(() => {
    if (pendingRegistrationData === undefined) return;
    const prev = prevPendingRegistrationCount.current;
    if (prev !== undefined && pendingRegistrationCount > prev) {
      const tambah = pendingRegistrationCount - prev;
      toast({
        title: "Ada pendaftar tenant baru",
        description: `${tambah} pendaftaran baru menunggu ditinjau di Draf Perjanjian.`,
      });
    }
    prevPendingRegistrationCount.current = pendingRegistrationCount;
  }, [pendingRegistrationCount, pendingRegistrationData]);

  type UpcomingItem = {
    id: number;
    invoiceNumber: string;
    dueDate: string | null;
    outstandingAmount: string;
    status: string;
    tenantName: string | null;
    ownerName: string | null;
  };
  type UpcomingData = {
    count: number;
    overdueCount: number;
    upcomingCount: number;
    overdue: UpcomingItem[];
    upcoming: UpcomingItem[];
  };

  const { data: upcomingData } = useQuery<UpcomingData>({
    queryKey: ["invoice-upcoming-notification", activeSite?.id ?? null],
    queryFn: async () => {
      const res = await apiFetch("/api/tenant-invoices/upcoming");
      if (!res.ok) return { count: 0, overdueCount: 0, upcomingCount: 0, overdue: [], upcoming: [] };
      const data = await res.json();
      return {
        ...data,
        count: Number(data?.count ?? 0),
        overdueCount: Number(data?.overdueCount ?? 0),
        upcomingCount: Number(data?.upcomingCount ?? 0),
        overdue: arrayField<UpcomingItem>(data, "overdue"),
        upcoming: arrayField<UpcomingItem>(data, "upcoming"),
      };
    },
    refetchInterval: 60_000,
    enabled: can("owner", "admin", "finance") && !!activeSite,
  });

  const notifCount = upcomingData?.count ?? 0;
  const grouped = groupSites(Array.isArray(sites) ? sites : []);

  // Warm Data Tenant for the CURRENT site first, then the other sites.
  // This makes a normal sidebar click into Data Tenant render from React Query
  // cache immediately instead of starting both API calls only after navigation.
  useEffect(() => {
    if (!backgroundReady || !activeSite || !can("owner", "admin") || sites.length === 0) return;

    let cancelled = false;

    const prefetchSite = async (siteId: number) => {
      const siteHeaders = { "x-site-id": String(siteId) };
      await Promise.all([
        queryClient.prefetchQuery({
          queryKey: ["/api/tenants", siteId],
          queryFn: async () => {
            const res = await apiFetch("/api/tenants", { headers: siteHeaders });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          },
          staleTime: 60_000,
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/mall-units", siteId],
          queryFn: async () => {
            const res = await apiFetch("/api/mall-units", { headers: siteHeaders });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          },
          staleTime: 60_000,
        }),
      ]).catch(() => undefined);
    };

    const run = async () => {
      // Current site has priority because this is the dataset the next sidebar
      // navigation is most likely to need.
      await prefetchSite(activeSite.id);
      if (cancelled) return;

      for (const site of sites) {
        if (cancelled || site.id === activeSite.id) continue;
        await prefetchSite(site.id);
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [backgroundReady, activeSite?.id, role, sites, queryClient]);

  return (
    <>
      <Sidebar>
        <SidebarHeader className="flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-row items-center gap-2">
            <img src="/logo-cst.png" alt="Logo CST" className="h-8 w-8 object-contain shrink-0" />
            <span className="text-lg font-bold text-sidebar-foreground">
              Portal Admin
            </span>
          </div>

          {/* Site switcher — tab buttons per lokasi */}
          {activeSite && (
            <div className="flex flex-col gap-1">
              {sites.length > 1 && (
                <div className="flex gap-1 flex-wrap">
                  {sites.map((site) => {
                    const isActive = activeSite.code !== "ALL" && activeSite.id === site.id;
                    const cfg = SITE_TYPE_CONFIG[site.type];
                    return (
                      <button
                        key={site.id}
                        onClick={() => setActiveSite(site)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all flex-1 min-w-0 ${
                          isActive
                            ? `${cfg?.bg ?? "bg-primary/10 border-primary/30"} ${cfg?.color ?? "text-primary"} shadow-sm`
                            : "bg-sidebar border-sidebar-border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                        }`}
                      >
                        <span className="shrink-0">
                          <SiteIcon type={site.type} />
                        </span>
                        <span className="truncate">{site.name}</span>
                        {isActive && <Check className="h-3 w-3 shrink-0 ml-auto" />}
                      </button>
                    );
                  })}
                </div>
              )}
              {sites.length === 1 && (
                <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border ${SITE_TYPE_CONFIG[activeSite.type]?.bg ?? "bg-muted"}`}>
                  <span className={`shrink-0 ${SITE_TYPE_CONFIG[activeSite.type]?.color ?? "text-muted-foreground"}`}>
                    <SiteIcon type={activeSite.type} />
                  </span>
                  <span className={`text-xs font-semibold truncate ${SITE_TYPE_CONFIG[activeSite.type]?.color ?? ""}`}>
                    {activeSite.name}
                  </span>
                </div>
              )}
            </div>
          )}
        </SidebarHeader>
        <SidebarContent onClick={closeMobile}>
          {can("owner", "admin", "finance") && (
            <SidebarGroup>
              <SidebarGroupLabel>RINGKASAN</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/dashboard"}
                    data-testid="nav-dashboard"
                  >
                    <Link href="/dashboard">
                      <LayoutDashboard className="mr-2 h-4 w-4" />
                      <span>Dashboard</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
          {can("owner", "admin", "finance", "cashier") && (
            <SidebarGroup>
              <SidebarGroupLabel>PENYEWA TENAN</SidebarGroupLabel>
              <SidebarMenu>
                {can("owner", "admin") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/data-tenant"}
                      data-testid="nav-data-tenant"
                    >
                      <Link href="/data-tenant">
                        <Store className="mr-2 h-4 w-4" />
                        <span>Data Tenant</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/unit-tenant"}
                      data-testid="nav-unit-tenant"
                    >
                      <Link href="/unit-tenant">
                        <LayoutGrid className="mr-2 h-4 w-4" />
                        <span>Unit Kantin</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/booking-tenant"}
                      data-testid="nav-booking-tenant"
                    >
                      <Link href="/booking-tenant">
                        <CalendarRange className="mr-2 h-4 w-4" />
                        <span>Booking Tenant</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/draf-perjanjian"}
                      data-testid="nav-draf-perjanjian"
                    >
                      <Link href="/draf-perjanjian" className="flex items-center justify-between w-full">
                        <span className="flex items-center">
                          <FileSignature className="mr-2 h-4 w-4" />
                          <span>Draf Perjanjian</span>
                        </span>
                        {pendingRegistrationCount > 0 && (
                          <Badge className="ml-auto h-5 min-w-5 text-[10px] bg-blue-500 hover:bg-blue-500 text-white px-1.5 border-0">
                            {pendingRegistrationCount}
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance", "cashier") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/tenant-pos"}
                      data-testid="nav-tenant-pos"
                    >
                      <Link href="/tenant-pos">
                        <Calculator className="mr-2 h-4 w-4" />
                        <span>POS Tenant</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/tenant-invoices"}
                      data-testid="nav-tenant-invoices"
                    >
                      <Link href="/tenant-invoices">
                        <FileText className="mr-2 h-4 w-4" />
                        <span>Invoice Tenant</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/invoice-konsolidasi"}
                      data-testid="nav-invoice-konsolidasi"
                    >
                      <Link href="/invoice-konsolidasi">
                        <Layers className="mr-2 h-4 w-4" />
                        <span>Invoice Konsolidasi</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/tinjau-pembayaran"}
                      data-testid="nav-tinjau-pembayaran"
                    >
                      <Link href="/tinjau-pembayaran" className="flex items-center justify-between w-full">
                        <span className="flex items-center">
                          <ClipboardCheck className="mr-2 h-4 w-4" />
                          <span>Tinjau Pembayaran</span>
                        </span>
                        {pendingCount > 0 && (
                          <Badge className="ml-auto h-5 min-w-5 text-[10px] bg-amber-500 hover:bg-amber-500 text-white px-1.5 border-0">
                            {pendingCount}
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/riwayat-pembayaran"}
                      data-testid="nav-riwayat-pembayaran"
                    >
                      <Link href="/riwayat-pembayaran">
                        <History className="mr-2 h-4 w-4" />
                        <span>Riwayat Pembayaran</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroup>
          )}
          {can("owner", "admin", "finance") && (
            <SidebarGroup>
              <SidebarGroupLabel>LAPORAN &amp; SISTEM</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/rekap-tenant"}
                    data-testid="nav-rekap-tenant"
                  >
                    <Link href="/rekap-tenant">
                      <Users className="mr-2 h-4 w-4" />
                      <span>Rekap Tenant</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/laporan"}
                    data-testid="nav-laporan"
                  >
                    <Link href="/laporan">
                      <BarChart3 className="mr-2 h-4 w-4" />
                      <span>Laporan Keuangan</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/pengeluaran-operasional"}
                    data-testid="nav-pengeluaran-operasional"
                  >
                    <Link href="/pengeluaran-operasional">
                      <TrendingDown className="mr-2 h-4 w-4" />
                      <span>Pengeluaran Operasional</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/pemasukan-lain"}
                    data-testid="nav-pemasukan-lain"
                  >
                    <Link href="/pemasukan-lain">
                      <TrendingUp className="mr-2 h-4 w-4" />
                      <span>Pemasukan Lain-lain</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/buku-jurnal"}
                    data-testid="nav-buku-jurnal"
                  >
                    <Link href="/buku-jurnal">
                      <BookOpen className="mr-2 h-4 w-4" />
                      <span>Buku Jurnal</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/rekonsiliasi-bank"}
                      data-testid="nav-rekonsiliasi-bank"
                    >
                      <Link href="/rekonsiliasi-bank">
                        <ScanLine className="mr-2 h-4 w-4" />
                        <span>Rekonsiliasi Bank</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/kelola-coa"}
                      data-testid="nav-kelola-coa"
                    >
                      <Link href="/kelola-coa">
                        <Layers className="mr-2 h-4 w-4" />
                        <span>Kelola CoA</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner", "admin", "finance") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/compare-sites"}
                      data-testid="nav-compare-sites"
                    >
                      <Link href="/compare-sites">
                        <GitCompare className="mr-2 h-4 w-4" />
                        <span>Perbandingan Lokasi</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/kirim-wa"}
                    data-testid="nav-kirim-wa"
                  >
                    <Link href="/kirim-wa">
                      <MessageCircle className="mr-2 h-4 w-4" />
                      <span>Kirim WA</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/template-wa"}
                    data-testid="nav-template-wa"
                  >
                    <Link href="/template-wa">
                      <BookTemplate className="mr-2 h-4 w-4" />
                      <span>Template WA</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {can("owner", "admin") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/audit-logs"}
                      data-testid="nav-audit-logs"
                    >
                      <Link href="/audit-logs">
                        <Shield className="mr-2 h-4 w-4" />
                        <span>Audit Log</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/users"}
                      data-testid="nav-users"
                    >
                      <Link href="/users">
                        <Users className="mr-2 h-4 w-4" />
                        <span>Manajemen User</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/db-monitoring"}
                      data-testid="nav-db-monitoring"
                    >
                      <Link href="/db-monitoring">
                        <Database className="mr-2 h-4 w-4" />
                        <span>Monitoring DB</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {can("owner") && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location === "/settings"}
                      data-testid="nav-settings"
                    >
                      <Link href="/settings">
                        <Settings className="mr-2 h-4 w-4" />
                        <span>Pengaturan</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroup>
          )}
        </SidebarContent>
        {user && role && (
          <SidebarFooter className="border-t px-3 py-3">
            <div className="flex items-center gap-2 mb-2">
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.name}
                  className="h-7 w-7 rounded-full object-cover"
                />
              ) : (
                <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-sidebar-foreground truncate">{user.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{user.email}</p>
              </div>
              <Badge className={`text-[10px] px-1.5 py-0 h-4 shrink-0 border-0 ${ROLE_COLORS[role]}`}>
                {ROLE_LABELS[role]}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 h-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="text-xs">{logout.isPending ? "Keluar..." : "Keluar"}</span>
            </Button>
          </SidebarFooter>
        )}
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 sm:h-16 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarTrigger className="shrink-0" />
          <Separator orientation="vertical" className="mr-1 sm:mr-2 h-4" />
          <span className="text-xs sm:text-sm font-medium text-muted-foreground flex-1 truncate min-w-0">
            {activeSite?.name ?? "Manajemen Tenan"}
          </span>

          {/* Bell notification — invoice overdue + jatuh tempo 7 hari */}
          {can("owner", "admin", "finance") && (
            <Popover>
              <PopoverTrigger asChild>
                <button className="relative p-2 rounded-md hover:bg-muted transition-colors" aria-label="Notifikasi invoice">
                  <Bell className="h-5 w-5 text-muted-foreground" />
                  {notifCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1 leading-none">
                      {notifCount > 99 ? "99+" : notifCount}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[calc(100vw-2rem)] max-w-80 p-0" sideOffset={8}>
                <div className="flex items-center justify-between px-4 py-3 border-b">
                  <p className="text-sm font-semibold">Notifikasi Invoice</p>
                  {notifCount > 0 && (
                    <Badge variant="destructive" className="text-[10px] h-5 px-1.5">{notifCount} invoice</Badge>
                  )}
                </div>
                <ScrollArea className="max-h-80">
                  {notifCount === 0 ? (
                    <div className="flex flex-col items-center py-8 text-muted-foreground gap-2">
                      <Bell className="h-8 w-8 opacity-20" />
                      <p className="text-xs">Tidak ada invoice mendesak</p>
                    </div>
                  ) : (
                    <div className="py-1">
                      {(upcomingData?.overdue ?? []).length > 0 && (
                        <>
                          <div className="flex items-center gap-1.5 px-4 py-2 bg-red-50">
                            <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                            <p className="text-xs font-semibold text-red-700">Sudah Lewat Jatuh Tempo ({upcomingData!.overdueCount})</p>
                          </div>
                          {upcomingData!.overdue.map(item => (
                            <Link key={item.id} href="/tenant-invoices">
                              <div className="flex flex-col px-4 py-2.5 hover:bg-muted/50 cursor-pointer border-b last:border-0">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium truncate text-red-700">{item.tenantName ?? "—"}</span>
                                  <span className="text-xs font-semibold text-red-600 shrink-0">
                                    Rp {Number(item.outstandingAmount).toLocaleString("id-ID")}
                                  </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground mt-0.5">{item.invoiceNumber}</span>
                                <span className="text-[10px] text-red-500 mt-0.5">
                                  Jatuh tempo: {item.dueDate ? new Date(item.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </>
                      )}
                      {(upcomingData?.upcoming ?? []).length > 0 && (
                        <>
                          <div className="flex items-center gap-1.5 px-4 py-2 bg-amber-50">
                            <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                            <p className="text-xs font-semibold text-amber-700">Jatuh Tempo ≤ 7 Hari ({upcomingData!.upcomingCount})</p>
                          </div>
                          {upcomingData!.upcoming.map(item => (
                            <Link key={item.id} href="/tenant-invoices">
                              <div className="flex flex-col px-4 py-2.5 hover:bg-muted/50 cursor-pointer border-b last:border-0">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium truncate">{item.tenantName ?? "—"}</span>
                                  <span className="text-xs font-semibold text-orange-600 shrink-0">
                                    Rp {Number(item.outstandingAmount).toLocaleString("id-ID")}
                                  </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground mt-0.5">{item.invoiceNumber}</span>
                                <span className="text-[10px] text-amber-600 mt-0.5">
                                  Jatuh tempo: {item.dueDate ? new Date(item.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </ScrollArea>
                {notifCount > 0 && (
                  <div className="border-t px-4 py-2.5">
                    <Link href="/tenant-invoices">
                      <button className="text-xs text-primary hover:underline w-full text-center">
                        Lihat semua invoice →
                      </button>
                    </Link>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
        </header>
        <main className="flex-1 p-3 sm:p-5 md:p-6 bg-muted/20 min-w-0 overflow-x-hidden">
          <Suspense
            fallback={
              <div className="space-y-4 animate-pulse" aria-label="Memuat halaman">
                <div className="h-8 w-52 rounded-md bg-muted" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="h-24 rounded-xl bg-muted" />
                  <div className="h-24 rounded-xl bg-muted" />
                  <div className="h-24 rounded-xl bg-muted" />
                </div>
                <div className="h-64 rounded-xl bg-muted" />
              </div>
            }
          >
            {children}
          </Suspense>
        </main>
      </SidebarInset>
    </>
  );
}
