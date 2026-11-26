import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import {
  bankMutationsTable,
  bankReconciliationMatchesTable,
  accountingEntriesTable,
  bankAccountBalancesTable,
  bankReconAuditLogsTable,
  bankClosingPeriodsTable,
  bankCoaRulesTable,
  tenantPaymentsTable,
  tenantInvoicesTable,
  tenantBookingsTable,
  tenantsTable,
  mallSitesTable,
  financePaymentEventsTable,
  systemSettingsTable,
} from "@workspace/db/schema";
import { eq, and, desc, asc, sql, inArray, isNull, gt, gte, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { logBankReconAudit } from "../lib/bank-recon-audit";
import { writeToSheet, readFromSheet, extractSheetId, getServiceAccountEmail } from "../services/google-sheets";
import { sendReconciliationReminder, notifyAdminGroup } from "../lib/whatsapp";
import {
  normalizeDescription,
  extractOrderId,
  detectProvider,
  buildMutationKey,
  runMatchingForMutation,
  computeMatchCandidates,
  type MatchContext,
} from "../services/bank-matcher";
import { writePaymentEvent, normalizePaymentMethod } from "../lib/payment-events";
import { postAccountingJournal } from "../lib/accounting-journal";
import { recordPayment, LedgerError } from "../lib/payment-ledger";
import { postTenantPaymentAccountingEntry } from "../lib/accounting-entry";
import { appContextMiddleware, type AppContext } from "../middlewares/app-context";
import { requireAnyRole } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { getBackgroundWorkMode } from "../lib/background-work-policy";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Scope context + write-guard to bank-reconciliation prefix only so that
// other routers (e.g. /tenant-pos/payments) mounted after this one are NOT
// inadvertently intercepted.
router.use("/bank-reconciliation", appContextMiddleware);

// GET routes tetap terbuka untuk tenant_user (data di-scope via appContextMiddleware).
// Operasi write (POST/PUT/DELETE) hanya untuk owner, admin, finance.
router.use("/bank-reconciliation", (req, res, next) => {
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    return requireAnyRole("owner", "admin", "finance")(req, res, next);
  }
  return next();
});

// ── Context helpers ───────────────────────────────────────────────────────────

function appCtx(req: Request): AppContext {
  return req.appContext ?? {
    ownerApp: "tenant_management",
    sourceApp: "tenant_management",
    ownerCompanyId: null,
    ownerTenantId: null,
    role: "admin",
    isBizPortal: false,
    isFullAccess: false,
    sourceAppFilterBypass: false,
  };
}

type CompanyReadScope = {
  companyId: number | null;
  allCompanies: boolean;
};

/**
 * Financial reads must have an exact, middleware-verified company context.
 * The sole exception is an owner explicitly requesting the ALL site/company
 * portfolio. A missing/invalid site must never silently become an unscoped
 * company query.
 */
function companyReadScope(req: Request, res: Response): CompanyReadScope | null {
  const ctx = appCtx(req);
  if (ctx.ownerCompanyId != null && ctx.ownerCompanyId > 0) {
    return { companyId: ctx.ownerCompanyId, allCompanies: false };
  }

  const queryScope = String(
    req.query.company_scope ?? req.query.companyScope ?? req.query.companyId ?? "",
  ).toLowerCase();
  const explicitlyAll =
    queryScope === "all"
    || String(req.headers["x-site-code"] ?? "").toUpperCase() === "ALL";

  if (explicitlyAll && ctx.isFullAccess) {
    return { companyId: null, allCompanies: true };
  }

  res.status(400).json({
    error: "Pilih company yang valid. Tampilan lintas company hanya tersedia untuk owner dengan scope ALL.",
  });
  return null;
}

function mutationCompanySql(scope: CompanyReadScope) {
  if (scope.allCompanies) return sql``;
  return sql`AND COALESCE(bm.company_id, bm.owner_company_id) = ${scope.companyId}`;
}

function accountingCompanySql(scope: CompanyReadScope, alias: "ae" | "accounting_entries" = "ae") {
  if (scope.allCompanies) return sql``;
  return alias === "ae"
    ? sql`AND ae.company_id = ${scope.companyId}`
    : sql`AND accounting_entries.company_id = ${scope.companyId}`;
}

function matchCtx(ctx: AppContext): MatchContext {
  return {
    ownerTenantId: ctx.isFullAccess ? null : ctx.ownerTenantId,
    // BizPortal (owner & Finance/Admin BizPortal) boleh match ke semua sourceApp
    sourceApp: ctx.sourceAppFilterBypass ? null : ctx.sourceApp,
  };
}

/** Returns Drizzle conditions scoping bank_mutations by tenant context */
function mutationTenantConds(ctx: AppContext) {
  const conds: ReturnType<typeof eq>[] = [];
  if (ctx.isFullAccess) return conds;
  if (ctx.ownerTenantId != null) {
    conds.push(
      or(
        isNull(bankMutationsTable.ownerTenantId),
        eq(bankMutationsTable.ownerTenantId, ctx.ownerTenantId),
      ) as any
    );
  }
  // sourceApp filter hanya untuk non-BizPortal:
  // - BizPortal (Finance/Admin/Owner) boleh lihat semua sourceApp
  // - Finance Tenant App: hanya tenant_management
  // - Cashier: hanya tenant_pos
  if (!ctx.sourceAppFilterBypass) {
    if (ctx.role === "cashier") {
      conds.push(eq(bankMutationsTable.sourceApp, "tenant_pos") as any);
    } else if (ctx.role === "finance") {
      conds.push(
        or(
          isNull(bankMutationsTable.sourceApp),
          eq(bankMutationsTable.sourceApp, "tenant_management"),
        ) as any
      );
    }
  }
  return conds;
}

/** Returns Drizzle conditions scoping finance_payment_events by tenant context */
function fpeTenantConds(ctx: AppContext) {
  const conds: ReturnType<typeof eq>[] = [];
  if (ctx.isFullAccess) return conds;
  if (ctx.ownerTenantId != null) {
    conds.push(
      or(
        isNull(financePaymentEventsTable.ownerTenantId),
        eq(financePaymentEventsTable.ownerTenantId, ctx.ownerTenantId),
      ) as any
    );
  }
  // sourceApp filter hanya untuk non-BizPortal
  if (!ctx.sourceAppFilterBypass) {
    if (ctx.role === "cashier") {
      conds.push(eq(financePaymentEventsTable.sourceApp, "tenant_pos") as any);
    } else if (ctx.role === "finance") {
      // Finance Tenant App hanya boleh lihat event dari tenant_management
      conds.push(
        or(
          isNull(financePaymentEventsTable.sourceApp),
          eq(financePaymentEventsTable.sourceApp, "tenant_management"),
        ) as any
      );
    }
  }
  return conds;
}

/** Returns raw SQL fragment for bank_mutations (for raw sql queries using alias "bm") */
function mutationRawTenantSql(ctx: AppContext) {
  if (ctx.isFullAccess) return sql``;
  const parts: ReturnType<typeof sql>[] = [];
  if (ctx.ownerTenantId != null) {
    parts.push(sql`AND (bm.owner_tenant_id IS NULL OR bm.owner_tenant_id = ${ctx.ownerTenantId})`);
  }
  // sourceApp filter hanya untuk non-BizPortal
  if (!ctx.sourceAppFilterBypass) {
    if (ctx.role === "cashier") {
      parts.push(sql`AND bm.source_app = 'tenant_pos'`);
    } else if (ctx.role === "finance") {
      parts.push(sql`AND (bm.source_app IS NULL OR bm.source_app = 'tenant_management')`);
    }
  }
  if (parts.length === 0) return sql``;
  return parts.reduce((acc, p) => sql`${acc} ${p}`, sql``);
}

/** Returns raw SQL fragment for tenant_invoices (using alias "ti") */
function invoiceRawTenantSql(ctx: AppContext) {
  if (ctx.isFullAccess) return sql``;
  if (ctx.ownerTenantId != null) {
    return sql`AND (ti.tenant_id IS NULL OR ti.tenant_id = ${ctx.ownerTenantId})`;
  }
  return sql``;
}

/** Returns raw SQL fragment for finance_payment_events (using alias "fpe") */
function fpeRawTenantSql(ctx: AppContext) {
  if (ctx.isFullAccess) return sql``;
  const parts: ReturnType<typeof sql>[] = [];
  if (ctx.ownerTenantId != null) {
    parts.push(sql`AND (fpe.owner_tenant_id IS NULL OR fpe.owner_tenant_id = ${ctx.ownerTenantId})`);
  }
  // sourceApp filter hanya untuk non-BizPortal
  if (!ctx.sourceAppFilterBypass) {
    if (ctx.role === "cashier") {
      parts.push(sql`AND fpe.source_app = 'tenant_pos'`);
    } else if (ctx.role === "finance") {
      parts.push(sql`AND (fpe.source_app IS NULL OR fpe.source_app = 'tenant_management')`);
    }
  }
  if (parts.length === 0) return sql``;
  return parts.reduce((acc, p) => sql`${acc} ${p}`, sql``);
}

/**
 * Ownership check: returns true if the mutation is accessible by this context.
 * Strict: if mutation has ownerTenantId set and context has ownerTenantId set, they must match.
 */
function checkMutationOwnership(
  mutation: { ownerTenantId: number | null },
  ctx: AppContext
): boolean {
  if (ctx.isFullAccess) return true;
  if (ctx.ownerTenantId == null) return true;
  if (mutation.ownerTenantId == null) return true;
  return mutation.ownerTenantId === ctx.ownerTenantId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseRows(rows: string[][]): Array<typeof bankMutationsTable.$inferInsert> {
  const header = rows[0]?.map((h) => (h ?? "").trim().toLowerCase()) ?? [];

  const idx = (candidates: string[]) =>
    candidates.map((c) => header.indexOf(c)).find((i) => i >= 0) ?? -1;

  const dateIdx    = idx(["tanggal", "date", "tgl", "transaction_date"]);
  const descIdx    = idx(["keterangan", "description", "desc", "deskripsi", "ket"]);
  const creditIdx  = idx(["kredit", "credit", "cr", "masuk", "credit_amount"]);
  const debitIdx   = idx(["debet", "debit", "db", "keluar", "debit_amount"]);
  const amountIdx  = idx(["nominal", "amount", "jumlah"]);

  return rows.slice(1).flatMap((row) => {
    const raw = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const num = (s: string) => parseFloat(s.replace(/[^0-9.-]/g, "")) || 0;

    const date = raw(dateIdx);
    if (!date) return [];

    const credit = num(raw(creditIdx));
    const debit  = num(raw(debitIdx));
    let amount   = num(raw(amountIdx));
    let direction: string;

    if (credit > 0 && debit === 0) {
      direction = "IN";
      amount = credit;
    } else if (debit > 0 && credit === 0) {
      direction = "OUT";
      amount = debit;
    } else if (amount > 0) {
      direction = "IN";
    } else {
      return [];
    }

    const description = raw(descIdx);
    const normDesc    = normalizeDescription(description);
    const provider    = detectProvider(description);
    const orderId     = extractOrderId(description);
    const mutKey      = buildMutationKey(date, amount, direction);

    return [{
      transactionDate:      date,
      description,
      creditAmount:         String(credit),
      debitAmount:          String(debit),
      amount:               String(amount),
      direction,
      mutationKey:          mutKey,
      normalizedDescription: normDesc,
      providerName:         provider ?? undefined,
      providerOrderId:      orderId ?? undefined,
      rawPayload:           Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])) as Record<string, unknown>,
      status:               "unmatched",
    }];
  });
}

// ── GET /bank-reconciliation/context ─────────────────────────────────────────

router.get("/bank-reconciliation/context", (req, res) => {
  const ctx = appCtx(req);
  res.json({
    ownerApp: ctx.ownerApp,
    sourceApp: ctx.sourceApp,
    ownerTenantId: ctx.ownerTenantId,
    ownerCompanyId: ctx.ownerCompanyId,
    role: ctx.role,
    isBizPortal: ctx.isBizPortal,
    isFullAccess: ctx.isFullAccess,
    sourceAppFilterBypass: ctx.sourceAppFilterBypass,
  });
});

router.get("/bank-reconciliation/info", (_req, res) => {
  res.json({ serviceAccountEmail: getServiceAccountEmail() });
});

// ── POST /bank-reconciliation/preview-from-sheet ─────────────────────────────
// Baca data dari Google Sheets dan kembalikan preview tanpa menyimpan ke DB.

const previewSheetSchema = z.object({
  spreadsheetId: z.string().min(1),
  sheetName: z.string().optional(),
  bankAccountId: z.string().optional(),
});

router.post("/bank-reconciliation/preview-from-sheet", async (req, res) => {
  const parsed = previewSheetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Format tidak valid", detail: parsed.error.issues });
    return;
  }
  const { spreadsheetId: rawId, sheetName, bankAccountId } = parsed.data;
  const spreadsheetId = extractSheetId(rawId);
  if (!spreadsheetId) {
    res.status(400).json({ error: "URL atau ID spreadsheet tidak valid" });
    return;
  }

  try {
    const range = sheetName ? `'${sheetName}'!A:Z` : "A:Z";
    const rows = await readFromSheet({ spreadsheetId, range });
    if (!rows || rows.length < 2) {
      res.status(400).json({ error: "Sheet kosong atau tidak memiliki data (minimal 1 baris header + 1 baris data)" });
      return;
    }
    const mutations = parseRows(rows);
    res.json({
      success: true,
      spreadsheetId,
      sheetName: sheetName ?? null,
      bankAccountId: bankAccountId ?? null,
      totalRows: rows.length - 1,
      validRows: mutations.length,
      headers: rows[0] ?? [],
      preview: mutations.slice(0, 5).map((m) => ({
        transactionDate: m.transactionDate,
        description: m.description,
        amount: m.amount,
        direction: m.direction,
        providerName: m.providerName ?? null,
        providerOrderId: m.providerOrderId ?? null,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg }, "[preview-from-sheet]");
    const isProduction = process.env.NODE_ENV === "production";
    res.status(500).json({ error: "Gagal membaca spreadsheet. Pastikan sheet sudah di-share ke service account dan ID/URL benar.", ...(isProduction ? {} : { detail: msg }) });
  }
});

// ── POST /bank-reconciliation/import-from-sheet ───────────────────────────────
// Baca dari Google Sheets, insert ke DB, jalankan auto-matching.

const importSheetSchema = z.object({
  spreadsheetId: z.string().min(1),
  sheetName: z.string().optional(),
  bankAccountId: z.string().optional(),
});

router.post("/bank-reconciliation/import-from-sheet", async (req, res) => {
  const parsed = importSheetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Format tidak valid", detail: parsed.error.issues });
    return;
  }
  const { spreadsheetId: rawId, sheetName, bankAccountId } = parsed.data;
  const spreadsheetId = extractSheetId(rawId);
  if (!spreadsheetId) {
    res.status(400).json({ error: "URL atau ID spreadsheet tidak valid" });
    return;
  }

  let rows: string[][];
  try {
    const range = sheetName ? `'${sheetName}'!A:Z` : "A:Z";
    rows = await readFromSheet({ spreadsheetId, range });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg }, "[import-from-sheet] readFromSheet error:");
    const isProduction = process.env.NODE_ENV === "production";
    res.status(500).json({ error: "Gagal membaca spreadsheet. Pastikan sheet sudah di-share ke service account dan ID/URL benar.", ...(isProduction ? {} : { detail: msg }) });
    return;
  }

  if (!rows || rows.length < 2) {
    res.status(400).json({ error: "Sheet kosong atau tidak memiliki data (minimal 1 baris header + 1 baris data)" });
    return;
  }

  const mutations = parseRows(rows);
  if (mutations.length === 0) {
    res.status(400).json({ error: "Tidak ada baris mutasi valid yang bisa diproses. Pastikan kolom Tanggal dan nominal (Kredit/Debet) ada di sheet." });
    return;
  }

  const ctx = appCtx(req);
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const toInsert = mutations.map((m) => ({
    ...m,
    bankAccountId: bankAccountId ?? null,
    siteId: siteId ?? null,
    ownerApp: ctx.ownerApp,
    sourceApp: ctx.sourceApp,
    ownerTenantId: ctx.ownerTenantId ?? null,
    ownerCompanyId: ctx.ownerCompanyId ?? null,
  }));

  const inserted = await db.insert(bankMutationsTable).values(toInsert).returning({ id: bankMutationsTable.id });
  const ids = inserted.map((r) => r.id);

  logAudit(req, {
    action: "bank_mutation_import",
    entityType: "bank_mutations",
    afterData: { count: ids.length, bankAccountId, source: "google_sheets", spreadsheetId, ownerTenantId: ctx.ownerTenantId },
  });
  logBankReconAudit(req, ctx, "import_mutasi", {
    metadata: { count: ids.length, bankAccountId, source: "google_sheets", spreadsheetId },
    sourceModule: "bank_reconciliation",
  });

  const mc = matchCtx(ctx);
  const matchResults = await Promise.allSettled(ids.map((id) => runMatchingForMutation(id, mc)));
  const autoMatched = matchResults.filter(
    (r) => r.status === "fulfilled" && (r.value as any).autoMatched
  ).length;
  const duplicates = matchResults.filter(
    (r) => r.status === "fulfilled" && (r.value as any).status === "duplicate_need_review"
  ).length;

  matchResults.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      const v = r.value as any;
      if (v.status === "duplicate_need_review") {
        logBankReconAudit(req, ctx, "need_review", {
          mutationId: ids[idx],
          metadata: { trigger: "import_sheet", candidatesCount: v.candidatesCount },
          sourceModule: "bank_reconciliation",
        });
      } else if (v.autoMatched) {
        logBankReconAudit(req, ctx, "auto_match", {
          mutationId: ids[idx],
          matchId: v.matchId ?? null,
          metadata: { candidateType: v.candidateType, candidateId: v.candidateId, source: "google_sheets" },
          sourceModule: "bank_reconciliation",
        });
      }
    }
  });

  res.json({ success: true, imported: ids.length, autoMatched, duplicates });
});

// ── POST /bank-reconciliation/import ─────────────────────────────────────────

const importJsonSchema = z.object({
  rows: z.array(z.array(z.string())).min(2),
  bankAccountId: z.string().optional(),
});

router.post("/bank-reconciliation/import", upload.single("file"), async (req, res) => {
  let rows: string[][];
  let bankAccountId: string | undefined;

  if (req.file) {
    const text = req.file.buffer.toString("utf-8");
    rows = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
    bankAccountId = (req.body?.bankAccountId as string | undefined) ?? undefined;
  } else {
    const parsed = importJsonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Format tidak valid", detail: parsed.error.issues });
      return;
    }
    rows = parsed.data.rows;
    bankAccountId = parsed.data.bankAccountId;
  }

  const mutations = parseRows(rows);
  if (mutations.length === 0) {
    res.status(400).json({ error: "Tidak ada baris valid yang bisa diproses" });
    return;
  }

  const ctx = appCtx(req);
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const toInsert = mutations.map((m) => ({
    ...m,
    bankAccountId: bankAccountId ?? null,
    siteId: siteId ?? null,
    ownerApp: ctx.ownerApp,
    sourceApp: ctx.sourceApp,
    ownerTenantId: ctx.ownerTenantId ?? null,
    ownerCompanyId: ctx.ownerCompanyId ?? null,
  }));

  const inserted = await db.insert(bankMutationsTable).values(toInsert).returning({ id: bankMutationsTable.id });
  const ids = inserted.map((r) => r.id);

  logAudit(req, {
    action: "bank_mutation_import",
    entityType: "bank_mutations",
    afterData: { count: ids.length, bankAccountId, ownerTenantId: ctx.ownerTenantId, sourceApp: ctx.sourceApp },
  });
  logBankReconAudit(req, ctx, "import_mutasi", {
    metadata: { count: ids.length, bankAccountId },
    sourceModule: "bank_reconciliation",
  });

  const mc = matchCtx(ctx);
  const matchResults = await Promise.allSettled(ids.map((id) => runMatchingForMutation(id, mc)));
  const autoMatched = matchResults.filter(
    (r) => r.status === "fulfilled" && (r.value as any).autoMatched
  ).length;
  const duplicates = matchResults.filter(
    (r) => r.status === "fulfilled" && (r.value as any).status === "duplicate_need_review"
  ).length;

  matchResults.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      const v = r.value as any;
      if (v.status === "duplicate_need_review") {
        logBankReconAudit(req, ctx, "need_review", {
          mutationId: ids[idx],
          metadata: { trigger: "import", candidatesCount: v.candidatesCount },
          sourceModule: "bank_reconciliation",
        });
      } else if (v.autoMatched) {
        logBankReconAudit(req, ctx, "auto_match", {
          mutationId: ids[idx],
          matchId: v.matchId ?? null,
          metadata: { candidateType: v.candidateType, candidateId: v.candidateId },
          sourceModule: "bank_reconciliation",
        });
      }
    }
  });

  if (duplicates > 0) {
    logAudit(req, {
      action: "bank_mutation_duplicate_detected",
      entityType: "bank_mutations",
      afterData: { duplicateCount: duplicates },
    });
  }
  if (autoMatched > 0) {
    logAudit(req, {
      action: "bank_mutation_auto_match",
      entityType: "bank_mutations",
      afterData: { autoMatched },
    });
  }

  res.json({ success: true, imported: ids.length, autoMatched, duplicates });
});

// ── GET /bank-reconciliation/kpi ──────────────────────────────────────────────

router.get("/bank-reconciliation/kpi", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;

  const mutConds = [];
  if (siteId) mutConds.push(eq(bankMutationsTable.siteId, siteId));
  if (!companyScope.allCompanies) {
    mutConds.push(
      or(
        eq(bankMutationsTable.companyId, companyScope.companyId!),
        and(
          isNull(bankMutationsTable.companyId),
          eq(bankMutationsTable.ownerCompanyId, companyScope.companyId!),
        ),
      ) as any,
    );
  }
  mutConds.push(...mutationTenantConds(ctx));

  const fpeConds = [];
  if (siteId) fpeConds.push(eq(financePaymentEventsTable.siteId, siteId));
  if (!companyScope.allCompanies) {
    fpeConds.push(eq(financePaymentEventsTable.ownerCompanyId, companyScope.companyId!) as any);
  }
  fpeConds.push(...fpeTenantConds(ctx));

  const invConds = [];
  if (siteId) invConds.push(eq(tenantInvoicesTable.siteId, siteId));
  if (!companyScope.allCompanies) {
    invConds.push(
      sql`EXISTS (
        SELECT 1 FROM tenants company_tenant
        WHERE company_tenant.id = ${tenantInvoicesTable.tenantId}
          AND company_tenant.company_id = ${companyScope.companyId}
      )` as any,
    );
  }
  if (!ctx.isFullAccess && ctx.ownerTenantId != null) {
    invConds.push(
      or(isNull(tenantInvoicesTable.tenantId), eq(tenantInvoicesTable.tenantId, ctx.ownerTenantId)) as any
    );
  }

  const [mutStats, eventStats, invoiceStats] = await Promise.all([
    db
      .select({
        status: bankMutationsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(bankMutationsTable)
      .where(mutConds.length ? and(...mutConds) : undefined)
      .groupBy(bankMutationsTable.status),

    db
      .select({
        paymentStatus: financePaymentEventsTable.paymentStatus,
        count: sql<number>`count(*)::int`,
        totalAmount: sql<string>`coalesce(sum(amount::numeric), 0)::text`,
      })
      .from(financePaymentEventsTable)
      .where(fpeConds.length ? and(...fpeConds) : undefined)
      .groupBy(financePaymentEventsTable.paymentStatus),

    db
      .select({
        status: tenantInvoicesTable.status,
        count: sql<number>`count(*)::int`,
        totalPaid: sql<string>`coalesce(sum(paid_amount::numeric), 0)::text`,
      })
      .from(tenantInvoicesTable)
      .where(invConds.length ? and(...invConds) : undefined)
      .groupBy(tenantInvoicesTable.status),
  ]);

  const mutMap = Object.fromEntries(mutStats.map((r) => [r.status, r.count]));
  const evtMap = Object.fromEntries(eventStats.map((r) => [r.paymentStatus, { count: r.count, amount: parseFloat(r.totalAmount) }]));
  const invMap = Object.fromEntries(invoiceStats.map((r) => [r.status, { count: r.count, totalPaid: parseFloat(r.totalPaid) }]));

  res.json({
    mutations: {
      unmatched: mutMap["unmatched"] ?? 0,
      matched: mutMap["matched"] ?? 0,
      approved: mutMap["approved"] ?? 0,
      rejected: mutMap["rejected"] ?? 0,
      duplicateNeedReview: mutMap["duplicate_need_review"] ?? 0,
      total: Object.values(mutMap).reduce((a, b) => a + b, 0),
    },
    paymentEvents: {
      pending: evtMap["pending"]?.count ?? 0,
      waitingConfirmation: evtMap["waiting_confirmation"]?.count ?? 0,
      confirmed: evtMap["confirmed"]?.count ?? 0,
      rejected: evtMap["rejected"]?.count ?? 0,
      total: Object.values(evtMap).reduce((a, b) => a + b.count, 0),
      totalConfirmedAmount: evtMap["confirmed"]?.amount ?? 0,
    },
    invoices: {
      paid: invMap["paid"]?.count ?? 0,
      partial: invMap["partial"]?.count ?? 0,
      unpaid: invMap["unpaid"]?.count ?? 0,
      overdue: invMap["overdue"]?.count ?? 0,
      totalPaidAmount: invMap["paid"]?.totalPaid ?? 0,
      totalPartialPaidAmount: invMap["partial"]?.totalPaid ?? 0,
    },
  });
});

// ── GET /bank-reconciliation/cek-kesesuaian ──────────────────────────────────
// Laporan kesesuaian mutasi bank vs bukti transfer/faktur

router.get("/bank-reconciliation/cek-kesesuaian", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const { dateFrom, dateTo, status: filterStatus } = req.query as Record<string, string>;

  const mutTenantSql = mutationRawTenantSql(ctx);
  const fpeTenantSql = fpeRawTenantSql(ctx);

  const siteCond = siteId ? sql`AND bm.site_id = ${siteId}` : sql``;
  const companyCond = mutationCompanySql(companyScope);
  const fpeCompanyJoin = companyScope.allCompanies
    ? sql``
    : sql`AND fpe.owner_company_id = ${companyScope.companyId}`;
  const invoiceCompanyJoin = companyScope.allCompanies
    ? sql``
    : sql`AND EXISTS (
        SELECT 1 FROM tenants invoice_company_tenant
        WHERE invoice_company_tenant.id = ti.tenant_id
          AND invoice_company_tenant.company_id = ${companyScope.companyId}
      )`;
  const paymentCompanyJoin = companyScope.allCompanies
    ? sql``
    : sql`AND EXISTS (
        SELECT 1 FROM tenants payment_company_tenant
        WHERE payment_company_tenant.id = tp.tenant_id
          AND payment_company_tenant.company_id = ${companyScope.companyId}
      )`;
  const dateFromCond = dateFrom ? sql`AND bm.transaction_date >= ${dateFrom}` : sql``;
  const dateToCond = dateTo ? sql`AND bm.transaction_date <= ${dateTo}` : sql``;
  const statusCond = filterStatus && filterStatus !== "all" ? sql`AND bm.status = ${filterStatus}` : sql``;

  const rows = await db.execute(sql`
    SELECT
      bm.id,
      bm.transaction_date,
      bm.description,
      bm.amount::numeric              AS amount,
      bm.direction,
      bm.status,
      bm.provider_name,
      bm.provider_order_id,
      bm.bank_account_id,
      bm.owner_tenant_id,
      brm.id                          AS match_id,
      brm.candidate_type,
      brm.candidate_id,
      brm.match_score,
      brm.amount_match,
      -- Referensi berdasarkan candidate_type
      CASE
        WHEN brm.candidate_type = 'payment_event' THEN fpe.amount::numeric
        WHEN brm.candidate_type = 'invoice'       THEN ti.total_amount::numeric
        WHEN brm.candidate_type = 'payment'       THEN tp.amount::numeric
      END                             AS ref_amount,
      CASE
        WHEN brm.candidate_type = 'payment_event' THEN fpe.payment_method
        WHEN brm.candidate_type = 'payment'       THEN tp.method
        ELSE NULL
      END                             AS ref_method,
      CASE
        WHEN brm.candidate_type = 'payment_event' THEN fpe.payment_reference
        WHEN brm.candidate_type = 'payment'       THEN tp.payment_number
        WHEN brm.candidate_type = 'invoice'       THEN ti.invoice_number
      END                             AS ref_reference,
      CASE
        WHEN brm.candidate_type = 'payment_event' THEN COALESCE(fpe_t.business_name, fpe_t.owner_name)
        WHEN brm.candidate_type = 'invoice'       THEN COALESCE(inv_t.business_name, inv_t.owner_name)
        WHEN brm.candidate_type = 'payment'       THEN COALESCE(pay_t.business_name, pay_t.owner_name)
      END                             AS ref_tenant,
      CASE
        WHEN brm.candidate_type = 'payment_event' THEN fpe.payment_status
        WHEN brm.candidate_type = 'invoice'       THEN ti.status
        ELSE NULL
      END                             AS ref_status,
      -- Selisih nominal (hanya jika ada match)
      CASE
        WHEN brm.id IS NOT NULL THEN
          bm.amount::numeric - CASE
            WHEN brm.candidate_type = 'payment_event' THEN COALESCE(fpe.amount::numeric, 0)
            WHEN brm.candidate_type = 'invoice'       THEN COALESCE(ti.total_amount::numeric, 0)
            WHEN brm.candidate_type = 'payment'       THEN COALESCE(tp.amount::numeric, 0)
            ELSE 0
          END
        ELSE NULL
      END                             AS selisih
    FROM bank_mutations bm
    LEFT JOIN bank_reconciliation_matches brm
      ON brm.mutation_id = bm.id AND brm.status = 'applied'
    LEFT JOIN finance_payment_events fpe
      ON brm.candidate_type = 'payment_event' AND fpe.id = brm.candidate_id
      ${fpeCompanyJoin}
      ${fpeTenantSql}
    LEFT JOIN tenants fpe_t ON fpe.tenant_id = fpe_t.id
    LEFT JOIN tenant_invoices ti
      ON brm.candidate_type = 'invoice' AND ti.id = brm.candidate_id
      ${invoiceCompanyJoin}
    LEFT JOIN tenants inv_t ON ti.tenant_id = inv_t.id
    LEFT JOIN tenant_payments tp
      ON brm.candidate_type = 'payment' AND tp.id = brm.candidate_id
      ${paymentCompanyJoin}
    LEFT JOIN tenants pay_t ON tp.tenant_id = pay_t.id
    WHERE 1=1
      ${siteCond}
      ${companyCond}
      ${mutTenantSql}
      ${dateFromCond}
      ${dateToCond}
      ${statusCond}
    ORDER BY bm.transaction_date DESC, bm.id DESC
    LIMIT 500
  `);

  const data = ((rows as any).rows as any[]).map((r: any) => ({
    id: Number(r.id),
    transactionDate: r.transaction_date as string,
    description: r.description as string,
    amount: String(r.amount ?? "0"),
    direction: r.direction as string,
    status: r.status as string,
    providerName: r.provider_name as string | null,
    providerOrderId: r.provider_order_id as string | null,
    bankAccountId: r.bank_account_id as string | null,
    ownerTenantId: r.owner_tenant_id as number | null,
    matchId: r.match_id != null ? Number(r.match_id) : null,
    candidateType: r.candidate_type as string | null,
    candidateId: r.candidate_id != null ? Number(r.candidate_id) : null,
    matchScore: r.match_score != null ? Number(r.match_score) : null,
    amountMatch: r.amount_match as boolean | null,
    refAmount: r.ref_amount != null ? String(r.ref_amount) : null,
    refMethod: r.ref_method as string | null,
    refReference: r.ref_reference as string | null,
    refTenant: r.ref_tenant as string | null,
    refStatus: r.ref_status as string | null,
    selisih: r.selisih != null ? String(r.selisih) : null,
  }));

  const total = data.length;
  const approved = data.filter((r) => r.status === "approved").length;
  const unmatched = data.filter((r) => r.status === "unmatched").length;
  const withSelisih = data.filter((r) => r.selisih != null && Math.abs(parseFloat(r.selisih)) > 1).length;

  res.json({ summary: { total, approved, unmatched, withSelisih }, rows: data });
});

// ── GET /bank-reconciliation/mutations ───────────────────────────────────────

router.get("/bank-reconciliation/mutations", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const { status, direction, provider, dateFrom, dateTo, amountMin, amountMax } = req.query as Record<string, string>;

  const conditions = [];
  if (siteId) conditions.push(eq(bankMutationsTable.siteId, siteId));
  if (!companyScope.allCompanies) {
    conditions.push(
      or(
        eq(bankMutationsTable.companyId, companyScope.companyId!),
        and(
          isNull(bankMutationsTable.companyId),
          eq(bankMutationsTable.ownerCompanyId, companyScope.companyId!),
        ),
      ) as any,
    );
  }
  conditions.push(...mutationTenantConds(ctx));
  if (status && status !== "all") conditions.push(eq(bankMutationsTable.status, status));
  if (direction && direction !== "all") conditions.push(eq(bankMutationsTable.direction, direction));
  if (provider) conditions.push(sql`lower(${bankMutationsTable.providerName}) like ${"%" + provider.toLowerCase() + "%"}`);
  if (dateFrom) conditions.push(sql`${bankMutationsTable.transactionDate} >= ${dateFrom}`);
  if (dateTo)   conditions.push(sql`${bankMutationsTable.transactionDate} <= ${dateTo}`);
  if (amountMin) conditions.push(sql`${bankMutationsTable.amount}::numeric >= ${parseFloat(amountMin)}`);
  if (amountMax) conditions.push(sql`${bankMutationsTable.amount}::numeric <= ${parseFloat(amountMax)}`);

  const rows = await db
    .select()
    .from(bankMutationsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bankMutationsTable.transactionDate), desc(bankMutationsTable.id))
    .limit(500);

  res.json(rows);
});

// ── GET /bank-reconciliation/matches/:mutationId ─────────────────────────────

router.get("/bank-reconciliation/matches/:mutationId", async (req, res) => {
  const mutationId = parseInt(req.params.mutationId, 10);
  if (isNaN(mutationId)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const mutationConditions: any[] = [eq(bankMutationsTable.id, mutationId)];
  mutationConditions.push(...mutationTenantConds(ctx));
  if ((req as any).siteId > 0) {
    mutationConditions.push(eq(bankMutationsTable.siteId, (req as any).siteId));
  }
  if (!companyScope.allCompanies) {
    mutationConditions.push(
      or(
        eq(bankMutationsTable.companyId, companyScope.companyId!),
        and(
          isNull(bankMutationsTable.companyId),
          eq(bankMutationsTable.ownerCompanyId, companyScope.companyId!),
        ),
      ),
    );
  }

  const [mutation] = await db
    .select()
    .from(bankMutationsTable)
    .where(and(...mutationConditions))
    .limit(1);

  if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }

  if (!checkMutationOwnership(mutation, ctx)) {
    res.status(403).json({ error: "Akses ditolak. Mutasi ini milik tenant lain." });
    return;
  }

  const matches = await db
    .select()
    .from(bankReconciliationMatchesTable)
    .where(eq(bankReconciliationMatchesTable.mutationId, mutationId))
    .orderBy(desc(bankReconciliationMatchesTable.matchScore));

  const enriched = await Promise.all(
    matches.map(async (m) => {
      let detail: Record<string, unknown> = {};
      if (m.candidateType === "payment") {
        const [p] = await db
          .select({
            id: tenantPaymentsTable.id,
            amount: tenantPaymentsTable.amount,
            paidAt: tenantPaymentsTable.paidAt,
            method: tenantPaymentsTable.method,
            notes: tenantPaymentsTable.notes,
            tenantName: tenantsTable.businessName,
            ownerName: tenantsTable.ownerName,
            paymentNumber: tenantPaymentsTable.paymentNumber,
          })
          .from(tenantPaymentsTable)
          .leftJoin(tenantsTable, eq(tenantPaymentsTable.tenantId, tenantsTable.id))
          .where(and(
            eq(tenantPaymentsTable.id, m.candidateId),
            ...(!companyScope.allCompanies
              ? [eq(tenantsTable.companyId, companyScope.companyId!)]
              : []),
          ))
          .limit(1);
        if (p) detail = p as Record<string, unknown>;
      } else if (m.candidateType === "invoice") {
        const [inv] = await db
          .select({
            id: tenantInvoicesTable.id,
            invoiceNumber: tenantInvoicesTable.invoiceNumber,
            totalAmount: tenantInvoicesTable.totalAmount,
            outstandingAmount: tenantInvoicesTable.outstandingAmount,
            dueDate: tenantInvoicesTable.dueDate,
            status: tenantInvoicesTable.status,
            tenantName: tenantsTable.businessName,
            ownerName: tenantsTable.ownerName,
          })
          .from(tenantInvoicesTable)
          .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
          .where(and(
            eq(tenantInvoicesTable.id, m.candidateId),
            ...(!companyScope.allCompanies
              ? [eq(tenantsTable.companyId, companyScope.companyId!)]
              : []),
          ))
          .limit(1);
        if (inv) detail = inv as Record<string, unknown>;
      } else if (m.candidateType === "payment_event") {
        const [fpe] = await db
          .select({
            id: financePaymentEventsTable.id,
            amount: financePaymentEventsTable.amount,
            paymentMethod: financePaymentEventsTable.paymentMethod,
            paymentReference: financePaymentEventsTable.paymentReference,
            paymentStatus: financePaymentEventsTable.paymentStatus,
            sourceModule: financePaymentEventsTable.sourceModule,
            createdAt: financePaymentEventsTable.createdAt,
            tenantName: tenantsTable.businessName,
            ownerName: tenantsTable.ownerName,
          })
          .from(financePaymentEventsTable)
          .leftJoin(tenantsTable, eq(financePaymentEventsTable.tenantId, tenantsTable.id))
          .where(and(
            eq(financePaymentEventsTable.id, m.candidateId),
            ...(!companyScope.allCompanies
              ? [eq(financePaymentEventsTable.ownerCompanyId, companyScope.companyId!)]
              : []),
          ))
          .limit(1);
        if (fpe) detail = fpe as Record<string, unknown>;
      }
      return { ...m, detail };
    })
  );

  res.json({ mutation, matches: enriched });
});

// ── POST /bank-reconciliation/:mutationId/approve ────────────────────────────

const approveSchema = z.object({
  matchId: z.number().int().positive(),
});

router.post("/bank-reconciliation/:mutationId/approve", async (req, res) => {
  const mutationId = parseInt(req.params.mutationId, 10);
  if (isNaN(mutationId)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Parameter tidak valid", detail: parsed.error.issues }); return; }

  const { matchId } = parsed.data;
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;

  try {
  const mutationConditions: any[] = [eq(bankMutationsTable.id, mutationId)];
  mutationConditions.push(...mutationTenantConds(ctx));
  if (req.siteId > 0) mutationConditions.push(eq(bankMutationsTable.siteId, req.siteId));
  if (!companyScope.allCompanies) {
    mutationConditions.push(or(
      eq(bankMutationsTable.companyId, companyScope.companyId!),
      and(
        isNull(bankMutationsTable.companyId),
        eq(bankMutationsTable.ownerCompanyId, companyScope.companyId!),
      ),
    ));
  }
  const [[match], [mutation]] = await Promise.all([
    db.select().from(bankReconciliationMatchesTable)
      .where(and(
        eq(bankReconciliationMatchesTable.id, matchId),
        eq(bankReconciliationMatchesTable.mutationId, mutationId),
      )).limit(1),
    db.select().from(bankMutationsTable)
      .where(and(...mutationConditions)).limit(1),
  ]);

  if (!match) { res.status(404).json({ error: "Kandidat match tidak ditemukan" }); return; }
  if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }

  if (!checkMutationOwnership(mutation, ctx)) {
    res.status(403).json({ error: "Akses ditolak. Mutasi ini milik tenant lain." });
    return;
  }

  let candidateCompanyId: number | null = null;
  let candidateTenantId: number | null = null;
  if (match.candidateType === "invoice") {
    const [candidate] = await db
      .select({
        companyId: sql<number | null>`COALESCE(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId})`,
        tenantId: tenantInvoicesTable.tenantId,
      })
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, tenantInvoicesTable.tenantId))
      .where(eq(tenantInvoicesTable.id, match.candidateId))
      .limit(1);
    candidateCompanyId = candidate?.companyId ?? null;
    candidateTenantId = candidate?.tenantId ?? null;
  } else if (match.candidateType === "payment") {
    const [candidate] = await db
      .select({
        companyId: sql<number | null>`COALESCE(${tenantInvoicesTable.companyId}, ${tenantsTable.companyId}, ${tenantPaymentsTable.companyId})`,
        tenantId: sql<number | null>`COALESCE(${tenantInvoicesTable.tenantId}, ${tenantPaymentsTable.tenantId})`,
      })
      .from(tenantPaymentsTable)
      .leftJoin(tenantInvoicesTable, eq(tenantInvoicesTable.id, tenantPaymentsTable.invoiceId))
      .leftJoin(tenantsTable, eq(tenantsTable.id, tenantPaymentsTable.tenantId))
      .where(eq(tenantPaymentsTable.id, match.candidateId))
      .limit(1);
    candidateCompanyId = candidate?.companyId ?? null;
    candidateTenantId = candidate?.tenantId ?? null;
  } else if (match.candidateType === "payment_event") {
    const [candidate] = await db
      .select({
        companyId: sql<number | null>`COALESCE(${financePaymentEventsTable.ownerCompanyId}, ${tenantsTable.companyId}, ${mallSitesTable.companyId})`,
        tenantId: sql<number | null>`COALESCE(${financePaymentEventsTable.ownerTenantId}, ${financePaymentEventsTable.tenantId})`,
      })
      .from(financePaymentEventsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, financePaymentEventsTable.tenantId))
      .leftJoin(mallSitesTable, eq(mallSitesTable.id, financePaymentEventsTable.siteId))
      .where(eq(financePaymentEventsTable.id, match.candidateId))
      .limit(1);
    candidateCompanyId = candidate?.companyId ?? null;
    candidateTenantId = candidate?.tenantId ?? null;
  }

  if (
    ["invoice", "payment", "payment_event"].includes(match.candidateType)
    && (
      candidateCompanyId == null
      || (!companyScope.allCompanies && candidateCompanyId !== companyScope.companyId)
      || (ctx.ownerTenantId != null && candidateTenantId != null && candidateTenantId !== ctx.ownerTenantId)
    )
  ) {
    res.status(404).json({ error: "Kandidat match tidak ditemukan dalam company aktif" });
    return;
  }

  // Cashier POS tidak boleh approve invoice tenant atau payment tenant
  // (hanya boleh approve payment_event dari POS)
  if (ctx.role === "cashier" && (match.candidateType === "invoice" || match.candidateType === "payment")) {
    res.status(403).json({ error: "Cashier POS tidak bisa menyetujui invoice atau pembayaran tenant. Hanya payment event POS yang diizinkan." });
    return;
  }

  // Check candidate ownership for payment_event
  if (!ctx.isFullAccess && ctx.ownerTenantId != null && match.candidateType === "payment_event") {
    const [fpe] = await db
      .select({ ownerTenantId: financePaymentEventsTable.ownerTenantId })
      .from(financePaymentEventsTable)
      .where(eq(financePaymentEventsTable.id, match.candidateId))
      .limit(1);

    if (fpe?.ownerTenantId != null && fpe.ownerTenantId !== ctx.ownerTenantId) {
      res.status(403).json({ error: "Akses ditolak. Kandidat ini milik tenant lain." });
      return;
    }
  }

  // Check candidate ownership for invoice/payment
  if (!ctx.isFullAccess && ctx.ownerTenantId != null && match.candidateType === "invoice") {
    const [inv] = await db
      .select({ tenantId: tenantInvoicesTable.tenantId })
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, match.candidateId))
      .limit(1);

    if (inv?.tenantId != null && inv.tenantId !== ctx.ownerTenantId) {
      res.status(403).json({ error: "Akses ditolak. Invoice ini milik tenant lain." });
      return;
    }
  }

  if (!ctx.isFullAccess && ctx.ownerTenantId != null && match.candidateType === "payment") {
    const [pmt] = await db
      .select({ tenantId: tenantPaymentsTable.tenantId })
      .from(tenantPaymentsTable)
      .where(eq(tenantPaymentsTable.id, match.candidateId))
      .limit(1);

    if (pmt?.tenantId != null && pmt.tenantId !== ctx.ownerTenantId) {
      res.status(403).json({ error: "Akses ditolak. Pembayaran ini milik tenant lain." });
      return;
    }
  }

  const now = new Date();
  let newPaymentId: number | null = null;

  await db.transaction(async (tx) => {
    await tx.update(bankReconciliationMatchesTable)
      .set({ status: "approved" })
      .where(eq(bankReconciliationMatchesTable.id, matchId));

    await tx.update(bankReconciliationMatchesTable)
      .set({ status: "rejected" })
      .where(and(
        eq(bankReconciliationMatchesTable.mutationId, mutationId),
        sql`${bankReconciliationMatchesTable.id} != ${matchId}`,
      ));

    const updateData: Partial<typeof bankMutationsTable.$inferInsert> = {
      status: "approved",
      updatedAt: now,
    };

    if (match.candidateType === "payment") {
      updateData.matchedPaymentId = match.candidateId;

      await tx.update(financePaymentEventsTable)
        .set({
          paymentStatus: "confirmed",
          bankMutationId: mutationId,
          isReconciled: true,
          reconciledAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(financePaymentEventsTable.sourceTable, "tenant_payments"),
          eq(financePaymentEventsTable.sourceId, match.candidateId),
        ));

    } else if (match.candidateType === "invoice") {
      updateData.matchedOrderId = match.candidateId;

      const [invoice] = await tx
        .select()
        .from(tenantInvoicesTable)
        .where(eq(tenantInvoicesTable.id, match.candidateId))
        .for("update");

      if (invoice && invoice.status !== "cancelled" && invoice.status !== "paid") {
        const mutAmount = parseFloat(String(mutation.amount));

        const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
        const prefix = `REKON-PAY-${datePart}-`;
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tenantPaymentsTable)
          .where(sql`receipt_number LIKE ${prefix + "%"}`);
        const seq = ((countRow?.count ?? 0) + 1).toString().padStart(4, "0");
        const receiptNumber = `${prefix}${seq}`;

        const ledger = await recordPayment(tx, {
          invoiceId: invoice.id,
          amount: mutAmount,
          paymentMethod: "transfer",
          sourceType: "bank",
          receiptNumber,
          referenceId: `RECON-${mutationId}`,
          siteId: mutation.siteId ?? null,
          tenantId: invoice.tenantId ?? null,
          bookingId: invoice.bookingId ?? null,
          paidAt: new Date(mutation.transactionDate),
          referenceNumber: mutation.providerOrderId ?? mutation.description?.slice(0, 100) ?? null,
          notes: `Disetujui via rekonsiliasi bank. Mutasi ID: ${mutationId}`,
        });

        newPaymentId = ledger.ledgerEntryId;

        updateData.matchedPaymentId = newPaymentId ?? undefined;
      }
    } else if (match.candidateType === "payment_event") {
      updateData.matchedOrderId = match.candidateId;

      await tx.update(financePaymentEventsTable)
        .set({
          paymentStatus: "confirmed",
          bankMutationId: mutationId,
          isReconciled: true,
          reconciledAt: now,
          updatedAt: now,
        })
        .where(eq(financePaymentEventsTable.id, match.candidateId));
    }

    await tx.update(bankMutationsTable)
      .set(updateData)
      .where(eq(bankMutationsTable.id, mutationId));
  });

  if (match.candidateType === "invoice" && newPaymentId) {
    const [invoiceInfo] = await db
      .select({
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        businessName: tenantsTable.businessName,
        ownerName: tenantsTable.ownerName,
      })
      .from(tenantInvoicesTable)
      .leftJoin(tenantsTable, eq(tenantInvoicesTable.tenantId, tenantsTable.id))
      .where(eq(tenantInvoicesTable.id, match.candidateId));

    notifyAdminGroup({
      eventType: "payment_approved",
      businessName: invoiceInfo?.businessName ?? "Tenant",
      ownerName: invoiceInfo?.ownerName ?? "-",
      invoiceNumber: invoiceInfo?.invoiceNumber ?? null,
      amount: mutation.amount,
      paymentMethod: "transfer",
    }).catch(() => {});

    await writePaymentEvent({
      sourceApp: ctx.sourceApp,
      ownerApp: ctx.ownerApp,
      sourceModule: "tenant_invoice",
      sourceTable: "tenant_payments",
      sourceId: newPaymentId,
      tenantId: ctx.ownerTenantId ?? null,
      siteId: mutation.siteId ?? null,
      invoiceId: match.candidateId,
      amount: parseFloat(String(mutation.amount)),
      direction: "IN",
      paymentMethod: "bank_transfer",
      paymentReference: mutation.providerOrderId ?? undefined,
      paymentStatus: "confirmed",
      isReconciled: true,
      reconciledAt: now,
      bankMutationId: mutationId,
      metadata: {
        mutationId,
        mutationDescription: mutation.description,
        transactionDate: mutation.transactionDate,
        approvedBy: req.user?.name ?? req.user?.email ?? "Admin",
        ownerTenantId: ctx.ownerTenantId,
      },
    });

    await postTenantPaymentAccountingEntry({
      paymentId: newPaymentId,
      siteId: mutation.siteId ?? null,
      invoiceNumber: null,
      businessName: null,
      amountPaid: parseFloat(String(mutation.amount)),
      paymentMethod: "transfer",
      transactionDate: new Date(mutation.transactionDate),
      receiptNumber: `REKON-PAY-${mutationId}`,
      sourceModule: "bank_reconciliation",
    });
  }

  if (match.candidateType === "payment") {
    const [paymentInfo] = await db
      .select({
        amount: tenantPaymentsTable.amount,
        paidAt: tenantPaymentsTable.paidAt,
        paymentMethod: tenantPaymentsTable.paymentMethod,
        receiptNumber: tenantPaymentsTable.receiptNumber,
        siteId: tenantPaymentsTable.siteId,
        invoiceNumber: tenantInvoicesTable.invoiceNumber,
        businessName: tenantsTable.businessName,
      })
      .from(tenantPaymentsTable)
      .leftJoin(tenantInvoicesTable, eq(tenantInvoicesTable.id, tenantPaymentsTable.invoiceId))
      .leftJoin(tenantsTable, eq(tenantsTable.id, tenantPaymentsTable.tenantId))
      .where(eq(tenantPaymentsTable.id, match.candidateId))
      .limit(1);
    if (!paymentInfo) {
      res.status(409).json({ error: "Pembayaran kandidat tidak ditemukan setelah approval" });
      return;
    }
    await postTenantPaymentAccountingEntry({
      paymentId: match.candidateId,
      siteId: paymentInfo.siteId,
      invoiceNumber: paymentInfo.invoiceNumber,
      businessName: paymentInfo.businessName,
      amountPaid: Number(paymentInfo.amount),
      paymentMethod: paymentInfo.paymentMethod ?? "transfer",
      transactionDate: paymentInfo.paidAt ?? new Date(mutation.transactionDate),
      receiptNumber: paymentInfo.receiptNumber ?? `REKON-PAY-${mutationId}`,
      sourceModule: "bank_reconciliation",
    });
  }

  const approvedByRole = ctx.role;
  const approvedByApp  = ctx.ownerApp;

  await db.update(bankMutationsTable)
    .set({ approvedByApp, approvedByRole, updatedAt: now })
    .where(eq(bankMutationsTable.id, mutationId));

  const tenantPaymentId =
    match.candidateType === "invoice"
      ? newPaymentId
      : match.candidateType === "payment"
        ? match.candidateId
        : null;
  const { journalId, alreadyPosted } = tenantPaymentId
    ? { journalId: `tenant-payment-${tenantPaymentId}`, alreadyPosted: match.candidateType === "payment" }
    : await postAccountingJournal({
    mutationId,
    transactionDate: mutation.transactionDate,
    description: mutation.description,
    amount: parseFloat(String(mutation.amount)),
    direction: (mutation.direction?.toUpperCase() === "OUT" ? "OUT" : "IN") as "IN" | "OUT",
    bankAccountId: mutation.bankAccountId ?? `site-${mutation.siteId ?? 0}`,
    companyId: (mutation as any).companyId ?? null,
    ownerApp: ctx.ownerApp,
    sourceApp: ctx.sourceApp,
    sourceModule: "bank_reconciliation",
    createdBy: req.user?.name ?? req.user?.email ?? "Admin",
    siteId: mutation.siteId ?? null,
    metadata: {
      matchId,
      candidateType: match.candidateType,
      candidateId: match.candidateId,
      newPaymentId,
      approvedBy: req.user?.name ?? req.user?.email ?? "Admin",
      ownerTenantId: ctx.ownerTenantId,
    },
      });

  logAudit(req, {
    action: "bank_mutation_approved",
    entityType: "bank_mutations",
    entityId: mutationId,
    afterData: {
      matchId,
      candidateType: match.candidateType,
      candidateId: match.candidateId,
      newPaymentId,
      journalId,
      alreadyPosted,
      ownerTenantId: ctx.ownerTenantId,
    },
  });
  logBankReconAudit(req, ctx, "approved", {
    mutationId,
    matchId,
    journalId: journalId ?? null,
    afterValue: {
      candidateType: match.candidateType,
      candidateId: match.candidateId,
      newPaymentId,
      journalId,
      alreadyPosted,
    },
    sourceModule: "bank_reconciliation",
  });

  res.json({ success: true, newPaymentId, journalId, alreadyPosted });
  } catch (err) {
    if (err instanceof LedgerError) {
      const httpCode = err.code === "OVERPAYMENT" ? 400 : 409;
      res.status(httpCode).json({ error: err.message, code: err.code });
      return;
    }
    const e = err as Error & { status?: number };
    if (e.status) {
      res.status(e.status).json({ error: e.message });
    } else {
      logger.error({ err: err }, "[bank-recon approve]");
      res.status(500).json({ error: "Gagal memproses rekonsiliasi" });
    }
  }
});

// ── POST /bank-reconciliation/:mutationId/reject ─────────────────────────────

router.post("/bank-reconciliation/:mutationId/reject", async (req, res) => {
  const mutationId = parseInt(req.params.mutationId, 10);
  if (isNaN(mutationId)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const ctx = appCtx(req);

  const [mutation] = await db
    .select({ id: bankMutationsTable.id, ownerTenantId: bankMutationsTable.ownerTenantId })
    .from(bankMutationsTable)
    .where(eq(bankMutationsTable.id, mutationId))
    .limit(1);

  if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }

  if (!checkMutationOwnership(mutation, ctx)) {
    res.status(403).json({ error: "Akses ditolak. Mutasi ini milik tenant lain." });
    return;
  }

  await db.update(bankMutationsTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(bankMutationsTable.id, mutationId));

  await db.update(bankReconciliationMatchesTable)
    .set({ status: "rejected" })
    .where(eq(bankReconciliationMatchesTable.mutationId, mutationId));

  logAudit(req, {
    action: "bank_mutation_rejected",
    entityType: "bank_mutations",
    entityId: mutationId,
    afterData: { ownerTenantId: ctx.ownerTenantId },
  });
  logBankReconAudit(req, ctx, "rejected", {
    mutationId,
    sourceModule: "bank_reconciliation",
  });

  res.json({ success: true });
});

// ── POST /bank-reconciliation/run-matching ────────────────────────────────────

router.post("/bank-reconciliation/run-matching", async (req, res) => {
  try {
    const ctx = appCtx(req);
    const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;

    const conditions: any[] = [
      sql`${bankMutationsTable.status} IN ('unmatched', 'matched')`,
    ];
    if (siteId) conditions.push(eq(bankMutationsTable.siteId, siteId));
    conditions.push(...mutationTenantConds(ctx));

    const pending = await db
      .select({ id: bankMutationsTable.id })
      .from(bankMutationsTable)
      .where(and(...conditions))
      .limit(200);

    const mc = matchCtx(ctx);
    const results = await Promise.allSettled(
      pending.map((m) => runMatchingForMutation(m.id, mc))
    );

    const summary = { total: pending.length, autoMatched: 0, withCandidates: 0, unmatched: 0, duplicates: 0 };
    for (const r of results) {
      if (r.status === "fulfilled") {
        const v = r.value as any;
        if (v.autoMatched) summary.autoMatched++;
        else if (v.status === "duplicate_need_review") summary.duplicates++;
        else if (v.candidatesCount > 0) summary.withCandidates++;
        else summary.unmatched++;
      }
    }

    logAudit(req, {
      action: "bank_reconciliation_run_matching",
      entityType: "bank_mutations",
      afterData: { ...summary, ownerTenantId: ctx.ownerTenantId, sourceApp: ctx.sourceApp },
    });
    logBankReconAudit(req, ctx, "run_matching", {
      metadata: summary,
      sourceModule: "bank_reconciliation",
    });

    res.json({ success: true, ...summary });
  } catch (err) {
    logger.error({ err }, "run-matching gagal");
    res.status(500).json({ error: "Gagal menjalankan auto-matching" });
  }
});

// ── POST /bank-reconciliation/:mutationId/manual-match ───────────────────────

const manualMatchSchema = z.object({
  candidateType: z.enum(["payment", "invoice", "payment_event"]),
  candidateId: z.number().int().positive(),
});

router.post("/bank-reconciliation/:mutationId/manual-match", async (req, res) => {
  const mutationId = parseInt(req.params.mutationId, 10);
  if (isNaN(mutationId)) { res.status(400).json({ error: "ID tidak valid" }); return; }

  const parsed = manualMatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Parameter tidak valid" }); return; }

  const { candidateType, candidateId } = parsed.data;
  const ctx = appCtx(req);

  const [mutation] = await db
    .select({ id: bankMutationsTable.id, ownerTenantId: bankMutationsTable.ownerTenantId })
    .from(bankMutationsTable)
    .where(eq(bankMutationsTable.id, mutationId))
    .limit(1);

  if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }

  if (!checkMutationOwnership(mutation, ctx)) {
    res.status(403).json({ error: "Akses ditolak. Mutasi ini milik tenant lain." });
    return;
  }

  // Cashier POS tidak boleh manual-match ke invoice atau payment tenant
  if (ctx.role === "cashier" && (candidateType === "invoice" || candidateType === "payment")) {
    res.status(403).json({ error: "Cashier POS tidak bisa mem-match invoice atau pembayaran tenant." });
    return;
  }

  // Validate candidate belongs to same tenant
  if (!ctx.isFullAccess && ctx.ownerTenantId != null) {
    if (candidateType === "payment_event") {
      const [fpe] = await db
        .select({ ownerTenantId: financePaymentEventsTable.ownerTenantId })
        .from(financePaymentEventsTable)
        .where(eq(financePaymentEventsTable.id, candidateId))
        .limit(1);
      if (fpe?.ownerTenantId != null && fpe.ownerTenantId !== ctx.ownerTenantId) {
        res.status(403).json({ error: "Akses ditolak. Kandidat ini milik tenant lain." });
        return;
      }
    } else if (candidateType === "invoice") {
      const [inv] = await db
        .select({ tenantId: tenantInvoicesTable.tenantId })
        .from(tenantInvoicesTable)
        .where(eq(tenantInvoicesTable.id, candidateId))
        .limit(1);
      if (inv?.tenantId != null && inv.tenantId !== ctx.ownerTenantId) {
        res.status(403).json({ error: "Akses ditolak. Invoice ini milik tenant lain." });
        return;
      }
    } else if (candidateType === "payment") {
      const [pmt] = await db
        .select({ tenantId: tenantPaymentsTable.tenantId })
        .from(tenantPaymentsTable)
        .where(eq(tenantPaymentsTable.id, candidateId))
        .limit(1);
      if (pmt?.tenantId != null && pmt.tenantId !== ctx.ownerTenantId) {
        res.status(403).json({ error: "Akses ditolak. Pembayaran ini milik tenant lain." });
        return;
      }
    }
  }

  const [existing] = await db
    .select({ id: bankReconciliationMatchesTable.id })
    .from(bankReconciliationMatchesTable)
    .where(and(
      eq(bankReconciliationMatchesTable.mutationId, mutationId),
      eq(bankReconciliationMatchesTable.candidateType, candidateType),
      eq(bankReconciliationMatchesTable.candidateId, candidateId),
    ))
    .limit(1);

  let matchId: number;
  if (existing) {
    matchId = existing.id;
  } else {
    const [ins] = await db.insert(bankReconciliationMatchesTable).values({
      mutationId,
      candidateType,
      candidateId,
      matchScore: 100,
      matchReason: "manual match oleh admin",
      amountMatch: false,
      dateMatch: false,
      nameMatch: false,
      orderIdMatch: false,
      proofMatch: false,
      status: "candidate",
    }).returning({ id: bankReconciliationMatchesTable.id });
    matchId = ins.id;
  }

  await db.transaction(async (tx) => {
    await tx.update(bankReconciliationMatchesTable)
      .set({ status: "approved" })
      .where(eq(bankReconciliationMatchesTable.id, matchId));

    const updateData: Partial<typeof bankMutationsTable.$inferInsert> = {
      status: "approved",
      updatedAt: new Date(),
    };
    if (candidateType === "payment") updateData.matchedPaymentId = candidateId;
    else updateData.matchedOrderId = candidateId;

    await tx.update(bankMutationsTable)
      .set(updateData)
      .where(eq(bankMutationsTable.id, mutationId));
  });

  logAudit(req, {
    action: "bank_mutation_manual_match",
    entityType: "bank_mutations",
    entityId: mutationId,
    afterData: { candidateType, candidateId, ownerTenantId: ctx.ownerTenantId },
  });
  logBankReconAudit(req, ctx, "manual_match", {
    mutationId,
    afterValue: { candidateType, candidateId },
    sourceModule: "bank_reconciliation",
  });

  res.json({ success: true });
});

// ── GET /bank-reconciliation/audit ───────────────────────────────────────────

router.get("/bank-reconciliation/audit", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;

  const siteFilter = siteId ? sql`AND bm.site_id = ${siteId}` : sql``;
  const mutationCompanyFilter = mutationCompanySql(companyScope);
  const journalCompanyFilter = accountingCompanySql(companyScope, "accounting_entries");
  const invoiceCompanyFilter = companyScope.allCompanies
    ? sql``
    : sql`AND EXISTS (
        SELECT 1 FROM tenants company_tenant
        WHERE company_tenant.id = ti.tenant_id
          AND company_tenant.company_id = ${companyScope.companyId}
      )`;
  const fpeCompanyFilter = companyScope.allCompanies
    ? sql``
    : sql`AND fpe.owner_company_id = ${companyScope.companyId}`;
  const tenantFilter = mutationRawTenantSql(ctx);
  const invTenantFilter = invoiceRawTenantSql(ctx);
  const fpeTenantFilter = fpeRawTenantSql(ctx);

  const [
    approvedWithoutJournal,
    duplicateJournals,
    approvedWithoutBalance,
    mutationsWithoutCompany,
    journalsWithoutCompany,
    overpaidInvoices,
    needReviewCount,
    unmatchedCount,
    unpaidInvoiceCount,
    pendingPaymentEventCount,
  ] = await Promise.all([
    db.execute<{ id: number; mutation_key: string; amount: string; transaction_date: string }>(
      sql`SELECT bm.id, bm.mutation_key, bm.amount, bm.transaction_date
          FROM bank_mutations bm
          WHERE bm.status = 'approved'
            AND (bm.accounting_posted = false OR bm.accounting_posted IS NULL)
            ${siteFilter} ${mutationCompanyFilter} ${tenantFilter}
          ORDER BY bm.created_at DESC
          LIMIT 100`
    ),

    db.execute<{ journal_id: string; cnt: number }>(
      sql`SELECT correlation_id AS journal_id, count(*)::int AS cnt
          FROM accounting_entries
          WHERE source_module IN ('bank_reconciliation', 'pos_payment')
          ${journalCompanyFilter}
          GROUP BY correlation_id
          HAVING count(*) > 1
          LIMIT 50`
    ),

    db.execute<{ id: number; bank_account_id: string; site_id: number | null }>(
      sql`SELECT bm.id, bm.bank_account_id, bm.site_id
          FROM bank_mutations bm
          WHERE bm.status = 'approved'
            AND bm.accounting_posted = true
            AND bm.bank_account_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM bank_account_balances bab
              WHERE bab.bank_account_id = bm.bank_account_id
                AND (bab.site_id = bm.site_id OR (bab.site_id IS NULL AND bm.site_id IS NULL))
            )
            ${siteFilter} ${mutationCompanyFilter} ${tenantFilter}
          LIMIT 50`
    ),

    db.execute<{ id: number; mutation_key: string; status: string }>(
      sql`SELECT bm.id, bm.mutation_key, bm.status
          FROM bank_mutations bm
          WHERE bm.company_id IS NULL
            AND bm.status IN ('approved', 'matched')
            ${siteFilter} ${mutationCompanyFilter} ${tenantFilter}
          LIMIT 50`
    ),

    db.execute<{ id: number; journal_id: string }>(
      sql`SELECT id, correlation_id AS journal_id
          FROM accounting_entries
          WHERE source_module IN ('bank_reconciliation', 'pos_payment')
            AND company_id IS NULL
          ${journalCompanyFilter}
          LIMIT 50`
    ),

    db.execute<{ id: number; invoice_number: string; paid_amount: string; total_amount: string }>(
      sql`SELECT ti.id, ti.invoice_number, ti.paid_amount::text, ti.total_amount::text
          FROM tenant_invoices ti
          WHERE ti.paid_amount::numeric > ti.total_amount::numeric
            AND ti.total_amount::numeric > 0
            ${invoiceCompanyFilter}
            ${invTenantFilter}
          LIMIT 50`
    ),

    db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*)::text AS cnt FROM bank_mutations bm
          WHERE bm.status = 'duplicate_need_review' ${siteFilter} ${mutationCompanyFilter} ${tenantFilter}`
    ),

    db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*)::text AS cnt FROM bank_mutations bm
          WHERE bm.status = 'unmatched' ${siteFilter} ${mutationCompanyFilter} ${tenantFilter}`
    ),

    db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*)::text AS cnt FROM tenant_invoices ti
          WHERE ti.status IN ('unpaid','partial','overdue')
          ${siteId ? sql`AND ti.site_id = ${siteId}` : sql``}
          ${invoiceCompanyFilter}
          ${invTenantFilter}`
    ),

    db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*)::text AS cnt FROM finance_payment_events fpe
          WHERE fpe.payment_status IN ('pending','waiting_confirmation')
          ${siteId ? sql`AND fpe.site_id = ${siteId}` : sql``}
          ${fpeCompanyFilter}
          ${fpeTenantFilter}`
    ),
  ]);

  const issues = {
    legacyRouteActive: { count: 1, note: "POST /api/reconciliation/export, /reconciliation/notify masih aktif — sudah diberi warning log" },
    needReviewMutations: { count: parseInt(needReviewCount!.rows[0]?.cnt ?? "0") },
    unmatchedMutations: { count: parseInt(unmatchedCount!.rows[0]?.cnt ?? "0") },
    unpaidInvoices: { count: parseInt(unpaidInvoiceCount!.rows[0]?.cnt ?? "0") },
    pendingPaymentEvents: { count: parseInt(pendingPaymentEventCount!.rows[0]?.cnt ?? "0") },
    approvedWithoutJournal: {
      count: approvedWithoutJournal.rows.length,
      items: approvedWithoutJournal.rows,
    },
    duplicateJournalIds: {
      count: duplicateJournals.rows.length,
      items: duplicateJournals.rows,
    },
    approvedWithoutBalanceUpdate: {
      count: approvedWithoutBalance.rows.length,
      items: approvedWithoutBalance.rows,
    },
    mutationsWithoutCompanyId: {
      count: mutationsWithoutCompany.rows.length,
      items: mutationsWithoutCompany.rows,
    },
    journalsWithoutCompanyId: {
      count: journalsWithoutCompany.rows.length,
      items: journalsWithoutCompany.rows,
    },
    overpaidInvoices: {
      count: overpaidInvoices.rows.length,
      items: overpaidInvoices.rows,
    },
  };

  const totalIssues = Object.values(issues).reduce((sum, v) => sum + v.count, 0);

  res.json({
    ok: totalIssues === 0,
    totalIssues,
    checkedAt: new Date().toISOString(),
    scopedBy: {
      ownerTenantId: ctx.ownerTenantId,
      sourceApp: ctx.sourceApp,
      role: ctx.role,
      isFullAccess: ctx.isFullAccess,
    },
    issues,
  });
});

// ── POST /bank-reconciliation/export-google-sheet ─────────────────────────
const exportSheetSchema = z.object({
  spreadsheetId: z.string().min(1),
  sheetTitle: z.string().trim().min(1).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

router.post("/bank-reconciliation/export-google-sheet", async (req, res) => {
  const parsed = exportSheetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Parameter tidak valid", detail: parsed.error.issues });
    return;
  }
  const { spreadsheetId: rawId, sheetTitle: customTitle, dateFrom, dateTo } = parsed.data;
  const spreadsheetId = extractSheetId(rawId);
  const ctx = appCtx(req);
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;

  const MONTH_ID = ["","Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  const now = new Date();
  const tenantSuffix = ctx.ownerTenantId != null ? ` (Tenant ${ctx.ownerTenantId})` : "";
  const sheetTitle = customTitle ?? `Rekonsiliasi Bank ${MONTH_ID[now.getMonth() + 1]} ${now.getFullYear()}${tenantSuffix}`;

  const tenantFilter = mutationRawTenantSql(ctx);

  const mutations = await db.execute<{
    id: number; transaction_date: string; description: string; direction: string; amount: string;
    status: string; mutation_key: string; bank_account_id: string | null; provider_name: string | null;
    accounting_posted: boolean; journal_id: string | null; approved_by_role: string | null;
    approved_at: string | null; match_score: number | null; candidate_type: string | null;
    match_reason: string | null; invoice_number: string | null; total_amount: string | null;
    paid_amount: string | null; outstanding_amount: string | null; invoice_status: string | null;
    due_date: string | null; tenant_name: string | null; owner_name: string | null;
  }>(sql`
    SELECT
      bm.id, bm.transaction_date, bm.description, bm.direction, bm.amount,
      bm.status, bm.mutation_key, bm.bank_account_id, bm.provider_name,
      bm.accounting_posted, bm.journal_id, bm.approved_by_role,
      bm.updated_at AS approved_at,
      brm.match_score, brm.candidate_type, brm.match_reason,
      ti.invoice_number, ti.total_amount, ti.paid_amount, ti.outstanding_amount,
      ti.status AS invoice_status, ti.due_date,
      t.business_name AS tenant_name, t.owner_name
    FROM bank_mutations bm
    LEFT JOIN bank_reconciliation_matches brm
      ON brm.mutation_id = bm.id AND brm.status = 'approved'
    LEFT JOIN accounting_entries bje
      ON bje.source_id = bm.id AND bje.source_module = 'bank_reconciliation'
    LEFT JOIN tenant_invoices ti
      ON ti.id = bm.matched_order_id
    LEFT JOIN tenants t
      ON t.id = ti.tenant_id
    WHERE 1=1
      ${siteId ? sql`AND bm.site_id = ${siteId}` : sql``}
      ${tenantFilter}
      ${dateFrom ? sql`AND bm.transaction_date >= ${dateFrom}` : sql``}
      ${dateTo ? sql`AND bm.transaction_date <= ${dateTo}` : sql``}
    ORDER BY bm.transaction_date DESC, bm.id DESC
    LIMIT 2000
  `);

  const statusLabel: Record<string, string> = {
    unmatched: "Tidak Cocok", matched: "Ada Kandidat", approved: "Disetujui",
    rejected: "Ditolak", duplicate_need_review: "Duplikat - Perlu Review",
    need_review: "Perlu Review",
  };
  const invoiceStatusLabel: Record<string, string> = {
    paid: "Lunas", partial: "Sebagian", unpaid: "Belum Bayar",
    overdue: "Jatuh Tempo", cancelled: "Dibatalkan",
  };

  const headers = [
    "No", "Tanggal Mutasi", "Keterangan", "Arah", "Nominal (Rp)",
    "Status Rekonsiliasi", "Match Score", "Tipe Kandidat", "Alasan Match",
    "Nama Tenant", "No. Invoice", "Total Invoice (Rp)", "Sudah Bayar (Rp)", "Sisa (Rp)",
    "Status Invoice", "Jatuh Tempo",
    "Journal ID", "Akuntansi Posted",
    "Disetujui Oleh", "Tanggal Approve",
    "Catatan Audit",
  ];

  const rows = mutations.rows.map((r, i) => [
    i + 1,
    r.transaction_date ?? "",
    r.description ?? "",
    r.direction ?? "",
    parseFloat(r.amount ?? "0") || 0,
    statusLabel[r.status] ?? r.status ?? "",
    r.match_score ?? "",
    r.candidate_type ?? "",
    r.match_reason ?? "",
    r.tenant_name ?? "",
    r.invoice_number ?? "",
    parseFloat(r.total_amount ?? "0") || "",
    parseFloat(r.paid_amount ?? "0") || "",
    parseFloat(r.outstanding_amount ?? "0") || "",
    invoiceStatusLabel[r.invoice_status ?? ""] ?? r.invoice_status ?? "",
    r.due_date ?? "",
    r.journal_id ?? "",
    r.accounting_posted ? "Ya" : "Belum",
    r.approved_by_role ?? "",
    r.approved_at ? new Date(r.approved_at).toLocaleDateString("id-ID") : "",
    "",
  ]);

  try {
    await writeToSheet({ spreadsheetId, sheetTitle, headers, rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isProduction = process.env.NODE_ENV === "production";
    res.status(500).json({ error: "Gagal menulis ke Google Sheets", ...(isProduction ? {} : { detail: msg }) });
    return;
  }

  logAudit(req, {
    action: "bank_reconciliation_export_sheet",
    entityType: "bank_mutations",
    afterData: { sheetTitle, rowCount: rows.length, ownerTenantId: ctx.ownerTenantId },
  });
  logBankReconAudit(req, ctx, "export_sheet", {
    metadata: { sheetTitle, rowCount: rows.length },
    sourceModule: "bank_reconciliation",
  });

  res.json({
    success: true,
    sheetTitle,
    rowCount: rows.length,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  });
});

// ── POST /bank-reconciliation/send-reminder-wa ────────────────────────────
const sendReminderWaSchema = z.object({
  types: z.array(z.enum(["unpaid_invoice", "need_review", "unmatched", "approved_no_journal"])).min(1),
  daysThreshold: z.number().int().min(1).max(365).optional().default(3),
  monthLabel: z.string().optional(),
});

router.post("/bank-reconciliation/send-reminder-wa", async (req, res) => {
  const parsed = sendReminderWaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Parameter tidak valid", detail: parsed.error.issues });
    return;
  }
  const { types, monthLabel: customMonthLabel } = parsed.data;
  const ctx = appCtx(req);
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;

  const MONTH_ID = ["","Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  const now = new Date();
  const monthLabel = customMonthLabel ?? `${MONTH_ID[now.getMonth() + 1]} ${now.getFullYear()}`;

  const tenantFilter = mutationRawTenantSql(ctx);
  const invTenantFilter = invoiceRawTenantSql(ctx);

  const sent: string[] = [];
  const failed: Array<{ ref: string; error: string }> = [];
  const skipped: Array<{ ref: string; reason: string }> = [];
  const summary: Record<string, number> = {};

  if (types.includes("unpaid_invoice")) {
    const unpaidResult = await db.execute<{
      invoice_number: string; total_amount: string; outstanding_amount: string;
      due_date: string | null; owner_name: string | null; business_name: string | null; phone: string | null;
    }>(sql`
      SELECT ti.invoice_number, ti.total_amount, ti.outstanding_amount, ti.due_date,
             t.owner_name, t.business_name, t.phone
      FROM tenant_invoices ti
      LEFT JOIN tenants t ON t.id = ti.tenant_id
      WHERE ti.status IN ('unpaid', 'partial', 'overdue')
        ${siteId ? sql`AND ti.site_id = ${siteId}` : sql``}
        ${invTenantFilter}
      ORDER BY ti.due_date ASC
      LIMIT 100
    `);

    for (const inv of unpaidResult.rows) {
      if (!inv.phone) {
        skipped.push({ ref: inv.invoice_number, reason: "No HP tidak tersedia" });
        continue;
      }
      const result = await sendReconciliationReminder({
        ownerName: inv.owner_name ?? "Tenant",
        businessName: inv.business_name ?? "",
        invoiceNumber: inv.invoice_number,
        totalAmount: parseFloat(inv.total_amount ?? "0"),
        outstandingAmount: parseFloat(inv.outstanding_amount ?? "0"),
        dueDate: inv.due_date ?? "-",
        phone: inv.phone,
        monthLabel,
      });
      if (result.skipped) {
        skipped.push({ ref: inv.invoice_number, reason: "FONNTE_TOKEN / FONNTE_API_KEY belum dikonfigurasi" });
      } else if (result.ok) {
        sent.push(inv.invoice_number);
      } else {
        failed.push({ ref: inv.invoice_number, error: result.error ?? "Gagal kirim" });
      }
    }
    summary.unpaidInvoices = unpaidResult.rows.length;
  }

  if (types.includes("need_review")) {
    const r = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM bank_mutations bm
      WHERE bm.status = 'duplicate_need_review'
        ${siteId ? sql`AND bm.site_id = ${siteId}` : sql``}
        ${tenantFilter}
    `);
    summary.needReview = parseInt(r.rows[0]?.cnt ?? "0");
  }

  if (types.includes("unmatched")) {
    const r = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM bank_mutations bm
      WHERE bm.status = 'unmatched'
        ${siteId ? sql`AND bm.site_id = ${siteId}` : sql``}
        ${tenantFilter}
    `);
    summary.unmatched = parseInt(r.rows[0]?.cnt ?? "0");
  }

  if (types.includes("approved_no_journal")) {
    const r = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM bank_mutations bm
      WHERE bm.status = 'approved'
        AND (bm.accounting_posted = false OR bm.accounting_posted IS NULL)
        ${siteId ? sql`AND bm.site_id = ${siteId}` : sql``}
        ${tenantFilter}
    `);
    summary.approvedNoJournal = parseInt(r.rows[0]?.cnt ?? "0");
  }

  logAudit(req, {
    action: "bank_reconciliation_send_reminder_wa",
    entityType: "bank_mutations",
    afterData: {
      types,
      sent: sent.length,
      failed: failed.length,
      skipped: skipped.length,
      summary,
      ownerTenantId: ctx.ownerTenantId,
    },
  });
  logBankReconAudit(req, ctx, "send_reminder_wa", {
    metadata: { types, sent: sent.length, failed: failed.length, skipped: skipped.length },
    sourceModule: "bank_reconciliation",
  });

  res.json({ sent, failed, skipped, summary, monthLabel });
});


// ── GET /bank-reconciliation/audit-logs ──────────────────────────────────────

router.get("/bank-reconciliation/audit-logs", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const {
    mutation_id,
    action,
    owner_app,
    source_app,
    owner_tenant_id,
    date_from,
    date_to,
    user_id,
    page: pageStr = "1",
    limit: limitStr = "50",
  } = req.query as Record<string, string>;

  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));
  const offset = (page - 1) * limit;

  const conditions: ReturnType<typeof eq>[] = [];

  if (!companyScope.allCompanies) {
    conditions.push(eq(bankReconAuditLogsTable.ownerCompanyId, companyScope.companyId!) as any);
  }
  if (!ctx.isFullAccess) {
    if (ctx.ownerTenantId != null) {
      conditions.push(
        or(
          isNull(bankReconAuditLogsTable.ownerTenantId),
          eq(bankReconAuditLogsTable.ownerTenantId, ctx.ownerTenantId),
        ) as any
      );
    }
    if (ctx.role === "cashier") {
      conditions.push(eq(bankReconAuditLogsTable.sourceApp, "tenant_pos") as any);
    } else if (!ctx.sourceAppFilterBypass && ctx.role === "finance") {
      conditions.push(
        or(
          isNull(bankReconAuditLogsTable.sourceApp),
          eq(bankReconAuditLogsTable.sourceApp, "tenant_management"),
        ) as any
      );
    }
  }

  if (mutation_id) conditions.push(eq(bankReconAuditLogsTable.mutationId, parseInt(mutation_id, 10)) as any);
  if (action) conditions.push(eq(bankReconAuditLogsTable.action, action) as any);
  if (owner_app) conditions.push(eq(bankReconAuditLogsTable.ownerApp, owner_app) as any);
  if (source_app) conditions.push(eq(bankReconAuditLogsTable.sourceApp, source_app) as any);
  if (owner_tenant_id) conditions.push(eq(bankReconAuditLogsTable.ownerTenantId, parseInt(owner_tenant_id, 10)) as any);
  if (date_from) conditions.push(sql`${bankReconAuditLogsTable.createdAt} >= ${date_from}::timestamptz` as any);
  if (date_to) conditions.push(sql`${bankReconAuditLogsTable.createdAt} < (${date_to}::date + interval '1 day')` as any);
  if (user_id) conditions.push(eq(bankReconAuditLogsTable.actionUserId, user_id) as any);

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db.select().from(bankReconAuditLogsTable)
      .where(whereClause)
      .orderBy(desc(bankReconAuditLogsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` })
      .from(bankReconAuditLogsTable)
      .where(whereClause),
  ]);

  res.json({
    data: rows,
    total: countResult[0]?.count ?? 0,
    page,
    limit,
  });
});


// ── GET /bank-reconciliation/laporan ─────────────────────────────────────────
router.get("/bank-reconciliation/laporan", async (req, res) => {
  const ctx = appCtx(req);
  const companyScope = companyReadScope(req, res);
  if (!companyScope) return;
  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const { year } = req.query as Record<string, string>;
  const targetYear = year ? parseInt(year, 10) : new Date().getFullYear();
  const tenantFilter = mutationRawTenantSql(ctx);
  const companyFilter = mutationCompanySql(companyScope);

  const rows = await db.execute(sql`
    SELECT
      TO_CHAR(transaction_date::date, 'YYYY-MM') AS year_month,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE status = 'unmatched')::int AS unmatched,
      COUNT(*) FILTER (WHERE status = 'matched')::int AS matched,
      COUNT(*) FILTER (WHERE status = 'duplicate_need_review')::int AS duplicate,
      COALESCE(SUM(CASE WHEN direction = 'IN' THEN credit_amount::numeric ELSE 0 END), 0) AS total_in,
      COALESCE(SUM(CASE WHEN direction = 'OUT' THEN debit_amount::numeric ELSE 0 END), 0) AS total_out,
      COALESCE(SUM(CASE WHEN status = 'approved' AND direction = 'IN' THEN credit_amount::numeric ELSE 0 END), 0) AS approved_amount
    FROM bank_mutations bm
    WHERE EXTRACT(YEAR FROM bm.transaction_date::date) = ${targetYear}
      ${siteId ? sql`AND bm.site_id = ${siteId}` : sql``}
      ${companyFilter}
      ${tenantFilter}
    GROUP BY year_month
    ORDER BY year_month DESC
  `);

  res.json({ year: targetYear, rows: rows.rows });
});

// ── GET /bank-reconciliation/closing ─────────────────────────────────────────
router.get("/bank-reconciliation/closing", async (req, res) => {
  const rows = await db.select().from(bankClosingPeriodsTable)
    .orderBy(desc(bankClosingPeriodsTable.yearMonth));
  res.json(rows);
});

// ── POST /bank-reconciliation/closing/:yearMonth/lock ────────────────────────
router.post("/bank-reconciliation/closing/:yearMonth/lock", async (req, res) => {
  const { yearMonth } = req.params;
  const { notes } = req.body as { notes?: string };
  const ctx = appCtx(req);

  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    res.status(400).json({ error: "Format yearMonth tidak valid (YYYY-MM)" });
    return;
  }

  const existing = await db.select().from(bankClosingPeriodsTable)
    .where(eq(bankClosingPeriodsTable.yearMonth, yearMonth));

  if (existing.length > 0) {
    res.status(409).json({ error: `Periode ${yearMonth} sudah dikunci` });
    return;
  }

  const [row] = await db.insert(bankClosingPeriodsTable).values({
    yearMonth,
    lockedBy: ctx.ownerTenantId?.toString() ?? "system",
    lockedByRole: ctx.role,
    notes: notes ?? null,
  }).returning();

  logBankReconAudit(req, ctx, "closing_lock" as any, {
    metadata: { yearMonth, notes },
    sourceModule: "bank_closing",
  });

  res.json({ success: true, period: row });
});

// ── DELETE /bank-reconciliation/closing/:yearMonth/lock ──────────────────────
router.delete("/bank-reconciliation/closing/:yearMonth/lock", async (req, res) => {
  const { yearMonth } = req.params;
  const ctx = appCtx(req);

  const deleted = await db.delete(bankClosingPeriodsTable)
    .where(eq(bankClosingPeriodsTable.yearMonth, yearMonth))
    .returning();

  if (deleted.length === 0) {
    res.status(404).json({ error: `Periode ${yearMonth} tidak ditemukan` });
    return;
  }

  logBankReconAudit(req, ctx, "closing_unlock" as any, {
    metadata: { yearMonth },
    sourceModule: "bank_closing",
  });

  res.json({ success: true });
});

// ── GET /bank-reconciliation/coa-rules ───────────────────────────────────────
router.get("/bank-reconciliation/coa-rules", async (_req, res) => {
  const rows = await db.select().from(bankCoaRulesTable)
    .orderBy(bankCoaRulesTable.coaCode);
  res.json(rows);
});

// ── POST /bank-reconciliation/coa-rules ──────────────────────────────────────
router.post("/bank-reconciliation/coa-rules", async (req, res) => {
  const body = req.body as {
    providerName?: string;
    direction?: string;
    descriptionPattern?: string;
    coaCode: string;
    coaName: string;
    accountType?: string;
    description?: string;
    isActive?: boolean;
  };

  if (!body.coaCode?.trim() || !body.coaName?.trim()) {
    res.status(400).json({ error: "coaCode dan coaName wajib diisi" });
    return;
  }

  const [row] = await db.insert(bankCoaRulesTable).values({
    providerName: body.providerName?.trim() || null,
    direction: body.direction ?? "ALL",
    descriptionPattern: body.descriptionPattern?.trim() || null,
    coaCode: body.coaCode.trim(),
    coaName: body.coaName.trim(),
    accountType: body.accountType?.trim() || undefined,
    description: body.description?.trim() || null,
    isActive: body.isActive ?? true,
  }).returning();

  res.status(201).json(row);
});

// ── PUT /bank-reconciliation/coa-rules/:id ───────────────────────────────────
router.put("/bank-reconciliation/coa-rules/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body as {
    providerName?: string;
    direction?: string;
    descriptionPattern?: string;
    coaCode?: string;
    coaName?: string;
    accountType?: string;
    description?: string;
    isActive?: boolean;
  };

  const [row] = await db.update(bankCoaRulesTable).set({
    providerName: body.providerName?.trim() || null,
    direction: body.direction ?? "ALL",
    descriptionPattern: body.descriptionPattern?.trim() || null,
    coaCode: body.coaCode?.trim(),
    coaName: body.coaName?.trim(),
    accountType: body.accountType?.trim() || undefined,
    description: body.description?.trim() || null,
    isActive: body.isActive ?? true,
    updatedAt: new Date(),
  }).where(eq(bankCoaRulesTable.id, id)).returning();

  if (!row) {
    res.status(404).json({ error: "Aturan COA tidak ditemukan" });
    return;
  }

  res.json(row);
});

// ── DELETE /bank-reconciliation/coa-rules/:id ────────────────────────────────
router.delete("/bank-reconciliation/coa-rules/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await db.delete(bankCoaRulesTable)
    .where(eq(bankCoaRulesTable.id, id))
    .returning();

  if (deleted.length === 0) {
    res.status(404).json({ error: "Aturan COA tidak ditemukan" });
    return;
  }

  res.json({ success: true });
});

// ── GET /bank-reconciliation/account-balances ─────────────────────────────────

router.get("/bank-reconciliation/account-balances", async (req, res) => {
  try {
    const ctx = appCtx(req);
    const companyScope = companyReadScope(req, res);
    if (!companyScope) return;
    const conditions: any[] = [];

    if (!companyScope.allCompanies) {
      conditions.push(eq(bankAccountBalancesTable.companyId, companyScope.companyId!));
    }
    if (ctx.ownerTenantId != null) {
      conditions.push(eq(bankAccountBalancesTable.ownerTenantId, ctx.ownerTenantId));
    }

    const rows = await db.select()
      .from(bankAccountBalancesTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(bankAccountBalancesTable.updatedAt));

    res.json(rows);
  } catch (err) {
    logger.error({ err: err }, "account-balances error:");
    res.status(500).json({ error: "Gagal memuat saldo rekening" });
  }
});


// ── GET /bank-reconciliation/journal-entries ──────────────────────────────────
// Buku Jurnal: semua entri akuntansi double-entry untuk site aktif

router.get("/bank-reconciliation/journal-entries", async (req, res) => {
  try {
    const companyScope = companyReadScope(req, res);
    if (!companyScope) return;
    const {
      date_from,
      date_to,
      page: pageStr = "1",
      limit: limitStr = "50",
      search = "",
      source_type = "",
    } = req.query as Record<string, string>;

    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));
    const offset = (page - 1) * limit;

    const companyFilter = accountingCompanySql(companyScope);
    const dfFilter = date_from ? sql`AND ae.date >= ${date_from}::date` : sql``;
    const dtFilter = date_to   ? sql`AND ae.date <= ${date_to}::date`   : sql``;

    // Filter pencarian nomor jurnal atau keterangan
    const searchFilter = search.trim()
      ? sql`AND (ae.entry_number ILIKE ${"%" + search.trim() + "%"} OR ae.description ILIKE ${"%" + search.trim() + "%"} OR ae.ref ILIKE ${"%" + search.trim() + "%"})`
      : sql``;

    // Filter jenis jurnal berdasarkan prefix entry_number
    // pos → entry_number LIKE 'POS-%' OR 'SC-CSH/%' OR source_module LIKE 'pos%'
    // invoice → entry_number LIKE 'JNL/%' OR source = 'tenant_rent_payment'
    // bank → entry_number LIKE 'OCR/%' OR source LIKE '%bank%' OR source_module LIKE '%bank%'
    let sourceFilter = sql``;
    if (source_type === "pos") {
      sourceFilter = sql`AND (ae.entry_number LIKE 'POS-%' OR ae.entry_number LIKE 'SC-CSH/%' OR ae.source_module ILIKE 'pos%' OR ae.source_module ILIKE '%kasir%')`;
    } else if (source_type === "invoice") {
      sourceFilter = sql`AND (ae.entry_number LIKE 'JNL/%' OR ae.entry_number LIKE 'CSH-%' OR ae.entry_number LIKE 'BNK-%' OR ae.source = ${"tenant_rent_payment"}::accounting_entry_source)`;
    } else if (source_type === "bank") {
      sourceFilter = sql`AND (ae.entry_number LIKE 'OCR/%' OR ae.source_module ILIKE '%bank%' OR ae.source_module ILIKE '%recon%')`;
    }

    const [rowsRes, countRes, movementRes] = await Promise.all([
      db.execute(sql`
        SELECT
          ae.id,
          ae.entry_number        AS "journalId",
          NULL::integer          AS "mutationId",
          ae.date::text          AS "transactionDate",
          ae.description,
          ae.status,
          ae.source,
          ae.source_module       AS "sourceModule",
          ae.source_table        AS "sourceTable",
          ae.source_id           AS "sourceId",
          ae.ref,
          ae.correlation_id      AS "correlationId",
          ae.total_debit         AS "debitAmount",
          ae.total_credit        AS "creditAmount",
          ae.company_id          AS "companyId",
          ae.created_at          AS "createdAt",
          'IDR'                  AS currency,
          NULL::numeric          AS "taxAmount",
          NULL::text             AS "taxAccountId",
          NULL::text             AS "taxAccountName",
          (SELECT coa.code FROM accounting_entry_lines ael
           JOIN chart_of_accounts coa ON coa.id = ael.account_id
           WHERE ael.entry_id = ae.id AND ael.debit > 0
           ORDER BY ael.id LIMIT 1) AS "debitAccountId",
          (SELECT coa.name FROM accounting_entry_lines ael
           JOIN chart_of_accounts coa ON coa.id = ael.account_id
           WHERE ael.entry_id = ae.id AND ael.debit > 0
           ORDER BY ael.id LIMIT 1) AS "debitAccountName",
          (SELECT coa.code FROM accounting_entry_lines ael
           JOIN chart_of_accounts coa ON coa.id = ael.account_id
           WHERE ael.entry_id = ae.id AND ael.credit > 0
           ORDER BY ael.id LIMIT 1) AS "creditAccountId",
          (SELECT coa.name FROM accounting_entry_lines ael
           JOIN chart_of_accounts coa ON coa.id = ael.account_id
           WHERE ael.entry_id = ae.id AND ael.credit > 0
           ORDER BY ael.id LIMIT 1) AS "creditAccountName"
        FROM accounting_entries ae
        WHERE 1=1
          ${companyFilter}
          ${dfFilter}
          ${dtFilter}
          ${searchFilter}
          ${sourceFilter}
        ORDER BY ae.date DESC, ae.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM accounting_entries ae
        WHERE 1=1
          ${companyFilter}
          ${dfFilter}
          ${dtFilter}
          ${searchFilter}
          ${sourceFilter}
      `),
      db.execute(sql`
        SELECT
          COALESCE(SUM(ae.total_debit), 0)::text AS "debitMovement",
          COALESCE(SUM(ae.total_credit), 0)::text AS "creditMovement"
        FROM accounting_entries ae
        WHERE 1=1
          ${companyFilter}
          ${dfFilter}
          ${dtFilter}
          ${searchFilter}
          ${sourceFilter}
      `),
    ]);

    const rows = (rowsRes as any).rows ?? [];
    const total = ((countRes as any).rows ?? [])[0]?.count ?? 0;
    const movements = ((movementRes as any).rows ?? [])[0] ?? {
      debitMovement: "0",
      creditMovement: "0",
    };

    res.json({
      data: rows,
      total,
      page,
      limit,
      movements: {
        totalDebit: movements.debitMovement,
        totalCredit: movements.creditMovement,
      },
      companyScope: companyScope.allCompanies ? "all" : companyScope.companyId,
    });
  } catch (err) {
    logger.error({ err: err }, "journal-entries error:");
    res.status(500).json({ error: "Gagal memuat jurnal" });
  }
});


// ── GET /bank-reconciliation/sheet-preview ─────────────────────────────────────
// Ambil 5 baris pertama dari spreadsheet untuk preview sebelum sinkronisasi

router.get("/bank-reconciliation/sheet-preview", async (req, res) => {
  const rawId   = String(req.query.spreadsheetId ?? "").trim();
  const sheetName = String(req.query.sheetName ?? "").trim() || undefined;

  if (!rawId) {
    res.status(400).json({ error: "spreadsheetId wajib diisi" });
    return;
  }

  const spreadsheetId = extractSheetId(rawId);
  if (!spreadsheetId) {
    res.status(400).json({ error: "URL / ID spreadsheet tidak valid" });
    return;
  }

  try {
    const range = sheetName ? `'${sheetName}'!A1:Z6` : "A1:Z6";
    const rows  = await readFromSheet({ spreadsheetId, range });

    if (!rows || rows.length === 0) {
      res.json({ headers: [], rows: [], total: 0 });
      return;
    }

    const headers  = rows[0] ?? [];
    const dataRows = rows.slice(1, 6);
    res.json({ headers, rows: dataRows, total: rows.length - 1 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// ── SYNC CONFIG: GET & POST ───────────────────────────────────────────────────

const SYNC_CONFIG_KEY = "bank_rekon_sync_config";

router.get("/bank-reconciliation/sync-config", async (_req, res) => {
  try {
    const row = await db
      .select({ value: systemSettingsTable.value })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY))
      .limit(1);
    const config = row[0]?.value as Record<string, unknown> | null | undefined;
    res.json({
      ...(config ?? { enabled: false, spreadsheetId: "", sheetName: "", bankAccountId: "", intervalMinutes: 5, lastSyncAt: null, lastSyncResult: null }),
      backgroundMode: getBackgroundWorkMode(),
    });
  } catch {
    res.status(500).json({ error: "Gagal memuat konfigurasi sinkronisasi" });
  }
});

const syncConfigSchema = z.object({
  enabled: z.boolean(),
  spreadsheetId: z.string(),
  sheetName: z.string().optional().default(""),
  bankAccountId: z.string().optional().default(""),
  intervalMinutes: z.number().int().min(1).max(1440).default(5),
});

router.post("/bank-reconciliation/sync-config", async (req, res) => {
  const parsed = syncConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Format tidak valid", detail: parsed.error.issues });
    return;
  }
  try {
    const existing = await db
      .select({ value: systemSettingsTable.value })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY))
      .limit(1);

    const merged = { ...(existing[0]?.value as object ?? {}), ...parsed.data };

    if (existing.length > 0) {
      await db.update(systemSettingsTable)
        .set({ value: merged, updatedAt: new Date() })
        .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY));
    } else {
      await db.insert(systemSettingsTable).values({ key: SYNC_CONFIG_KEY, value: merged });
    }
    res.json({ success: true, config: merged });
  } catch {
    res.status(500).json({ error: "Gagal menyimpan konfigurasi" });
  }
});

// ── POST /bank-reconciliation/sync-now ────────────────────────────────────────
// Sinkronisasi dari Google Sheets — hanya insert baris yang belum ada (berdasarkan mutationKey)

router.post("/bank-reconciliation/sync-now", async (req, res) => {
  const ctx = appCtx(req);

  let spreadsheetId: string;
  let sheetName: string | undefined;
  let bankAccountId: string | undefined;

  // Bisa pakai config dari body atau dari system_settings
  if (req.body?.spreadsheetId) {
    spreadsheetId = extractSheetId(req.body.spreadsheetId) ?? "";
    sheetName = req.body.sheetName || undefined;
    bankAccountId = req.body.bankAccountId || undefined;
  } else {
    const cfgRow = await db
      .select({ value: systemSettingsTable.value })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY))
      .limit(1);
    const cfg = cfgRow[0]?.value as Record<string, unknown> | undefined;
    if (!cfg?.spreadsheetId) {
      res.status(400).json({ error: "Belum ada konfigurasi sinkronisasi. Atur URL spreadsheet terlebih dahulu." });
      return;
    }
    spreadsheetId = extractSheetId(String(cfg.spreadsheetId)) ?? "";
    sheetName = cfg.sheetName ? String(cfg.sheetName) : undefined;
    bankAccountId = cfg.bankAccountId ? String(cfg.bankAccountId) : undefined;
  }

  if (!spreadsheetId) {
    res.status(400).json({ error: "URL atau ID spreadsheet tidak valid" });
    return;
  }

  let rows: string[][];
  try {
    const range = sheetName ? `'${sheetName}'!A:Z` : "A:Z";
    rows = await readFromSheet({ spreadsheetId, range });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateSyncResult({ success: false, error: msg, newRows: 0, totalRows: 0, spreadsheetId });
    res.status(500).json({ error: "Gagal membaca spreadsheet: " + msg });
    return;
  }

  if (!rows || rows.length < 2) {
    await updateSyncResult({ success: true, newRows: 0, totalRows: 0, spreadsheetId });
    res.json({ success: true, newRows: 0, totalRows: 0, skipped: 0, autoMatched: 0, duplicates: 0 });
    return;
  }

  const parsed = parseRows(rows);
  const totalRows = parsed.length;

  if (totalRows === 0) {
    await updateSyncResult({ success: true, newRows: 0, totalRows: 0, spreadsheetId });
    res.json({ success: true, newRows: 0, totalRows: 0, skipped: 0, autoMatched: 0, duplicates: 0 });
    return;
  }

  // Ambil semua mutationKey yang sudah ada di DB agar tidak duplikat
  const parsedKeys = parsed.map((m) => m.mutationKey);
  const existingRows = await db
    .select({ mutationKey: bankMutationsTable.mutationKey })
    .from(bankMutationsTable)
    .where(inArray(bankMutationsTable.mutationKey, parsedKeys));
  const existingKeys = new Set(existingRows.map((r) => r.mutationKey));

  const newMutations = parsed.filter((m) => !existingKeys.has(m.mutationKey));
  const skipped = totalRows - newMutations.length;

  if (newMutations.length === 0) {
    await updateSyncResult({ success: true, newRows: 0, totalRows, spreadsheetId });
    res.json({ success: true, newRows: 0, totalRows, skipped, autoMatched: 0, duplicates: 0 });
    return;
  }

  const siteId: number | undefined = (req as any).siteId > 0 ? (req as any).siteId : undefined;
  const toInsert = newMutations.map((m) => ({
    ...m,
    bankAccountId: bankAccountId ?? null,
    siteId: siteId ?? null,
    ownerApp: ctx.ownerApp,
    sourceApp: ctx.sourceApp,
    ownerTenantId: ctx.ownerTenantId ?? null,
    ownerCompanyId: ctx.ownerCompanyId ?? null,
  }));

  const inserted = await db.insert(bankMutationsTable).values(toInsert).returning({ id: bankMutationsTable.id });
  const ids = inserted.map((r) => r.id);

  const mc = matchCtx(ctx);
  const matchResults = await Promise.allSettled(ids.map((id) => runMatchingForMutation(id, mc)));
  const autoMatched = matchResults.filter((r) => r.status === "fulfilled" && (r.value as any).autoMatched).length;
  const duplicates = matchResults.filter((r) => r.status === "fulfilled" && (r.value as any).status === "duplicate_need_review").length;

  await updateSyncResult({ success: true, newRows: ids.length, totalRows, spreadsheetId });

  logBankReconAudit(req, ctx, "import_mutasi", {
    metadata: { count: ids.length, bankAccountId, source: "sheet_sync", spreadsheetId, skipped },
    sourceModule: "bank_reconciliation",
  });

  res.json({ success: true, newRows: ids.length, totalRows, skipped, autoMatched, duplicates });
});

async function updateSyncResult(result: { success: boolean; newRows: number; totalRows: number; spreadsheetId: string; error?: string }) {
  try {
    const existing = await db
      .select({ value: systemSettingsTable.value })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY))
      .limit(1);

    if (existing.length === 0) return;

    const cfg = existing[0].value as Record<string, unknown>;
    const updated = {
      ...cfg,
      lastSyncAt: new Date().toISOString(),
      lastSyncResult: {
        success: result.success,
        newRows: result.newRows,
        totalRows: result.totalRows,
        error: result.error ?? null,
        at: new Date().toISOString(),
      },
    };
    await db.update(systemSettingsTable)
      .set({ value: updated, updatedAt: new Date() })
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY));
  } catch {
    // fire-and-forget, jangan sampai gagalkan response
  }
}

// ─── Journal Entries ─────────────────────────────────────────────────────────


// ─── COA Rules ───────────────────────────────────────────────────────────────

const coaRuleSchema = z.object({
  coaCode: z.string().min(1),
  coaName: z.string().min(1),
  accountType: z.string().min(1),
  providerName: z.string().optional().nullable(),
  direction: z.enum(["CREDIT", "DEBIT", "ALL"]).optional().default("ALL"),
  descriptionPattern: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

export { SYNC_CONFIG_KEY };
export default router;

