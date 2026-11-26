import { db } from "@workspace/db";
import { bankMutationsTable, systemSettingsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { readFromSheet, extractSheetId } from "../services/google-sheets";
import {
  normalizeDescription,
  extractOrderId,
  detectProvider,
  buildMutationKey,
  runMatchingForMutation,
  type MatchContext,
} from "../services/bank-matcher";
import { logger } from "./logger";
import { getBackgroundWorkMode } from "./background-work-policy";

const SYNC_CONFIG_KEY = "bank_rekon_sync_config";

let _timer: ReturnType<typeof setTimeout> | null = null;
let _isRunning = false;

export function startSheetSyncScheduler(): void {
  if (getBackgroundWorkMode() === "on-demand") {
    logger.info("[sheet-sync] Mode on-demand aktif — menunggu permintaan sinkronisasi terautentikasi");
    return;
  }
  scheduleNext();
  logger.info("[sheet-sync] Scheduler sinkronisasi Google Sheets aktif");
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);

  _timer = setTimeout(async () => {
    await runSyncIfEnabled();
    scheduleNext();
  }, 60_000);
}

async function runSyncIfEnabled(): Promise<void> {
  if (_isRunning) return;

  try {
    const cfgRow = await db
      .select({ value: systemSettingsTable.value })
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, SYNC_CONFIG_KEY))
      .limit(1);

    const cfg = cfgRow[0]?.value as Record<string, unknown> | undefined;
    if (!cfg?.enabled) return;

    const intervalMinutes = Number(cfg.intervalMinutes ?? 5);
    const lastSyncAt = cfg.lastSyncAt ? new Date(cfg.lastSyncAt as string).getTime() : 0;
    const now = Date.now();
    const elapsedMinutes = (now - lastSyncAt) / 60_000;

    if (elapsedMinutes < intervalMinutes) return;

    const rawId = String(cfg.spreadsheetId ?? "");
    if (!rawId) return;

    const spreadsheetId = extractSheetId(rawId);
    if (!spreadsheetId) return;

    const sheetName = cfg.sheetName ? String(cfg.sheetName) : undefined;
    const bankAccountId = cfg.bankAccountId ? String(cfg.bankAccountId) : undefined;

    _isRunning = true;
    logger.info({ spreadsheetId }, "[sheet-sync] Memulai sinkronisasi otomatis");

    await runSheetSync({ spreadsheetId, sheetName, bankAccountId });
  } catch (err) {
    logger.warn({ err }, "[sheet-sync] Error saat cek/jalankan sinkronisasi");
  } finally {
    _isRunning = false;
  }
}

export async function runSheetSync(opts: {
  spreadsheetId: string;
  sheetName?: string;
  bankAccountId?: string;
}): Promise<{ newRows: number; totalRows: number; skipped: number; autoMatched: number; error?: string }> {
  const { spreadsheetId, sheetName, bankAccountId } = opts;

  let rows: string[][];
  try {
    const range = sheetName ? `'${sheetName}'!A:Z` : "A:Z";
    rows = await readFromSheet({ spreadsheetId, range });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn({ error }, "[sheet-sync] Gagal membaca sheet");
    await persistSyncResult({ success: false, newRows: 0, totalRows: 0, error });
    return { newRows: 0, totalRows: 0, skipped: 0, autoMatched: 0, error };
  }

  if (!rows || rows.length < 2) {
    await persistSyncResult({ success: true, newRows: 0, totalRows: 0 });
    return { newRows: 0, totalRows: 0, skipped: 0, autoMatched: 0 };
  }

  const parsed = parseSheetRows(rows);
  const totalRows = parsed.length;

  if (totalRows === 0) {
    await persistSyncResult({ success: true, newRows: 0, totalRows: 0 });
    return { newRows: 0, totalRows: 0, skipped: 0, autoMatched: 0 };
  }

  // mutation_key is intentionally unique per account (and globally for rows
  // without bank_account_id). Deduplicate the sheet itself before querying DB;
  // otherwise two identical keys in one batch can violate the partial unique
  // index even when neither key existed before this sync started.
  const uniqueByMutationKey = new Map<string, typeof parsed[number]>();
  for (const mutation of parsed) {
    if (!uniqueByMutationKey.has(mutation.mutationKey)) {
      uniqueByMutationKey.set(mutation.mutationKey, mutation);
    }
  }
  const uniqueParsed = Array.from(uniqueByMutationKey.values());

  const parsedKeys = uniqueParsed.map((m) => m.mutationKey);
  const existingRows = await db
    .select({ mutationKey: bankMutationsTable.mutationKey })
    .from(bankMutationsTable)
    .where(inArray(bankMutationsTable.mutationKey, parsedKeys));
  const existingKeys = new Set(existingRows.map((r) => r.mutationKey));

  const newMutations = uniqueParsed.filter((m) => !existingKeys.has(m.mutationKey));
  const preInsertSkipped = totalRows - newMutations.length;

  if (newMutations.length === 0) {
    await persistSyncResult({ success: true, newRows: 0, totalRows });
    return { newRows: 0, totalRows, skipped: preInsertSkipped, autoMatched: 0 };
  }

  const toInsert = newMutations.map((m) => ({
    ...m,
    bankAccountId: bankAccountId ?? null,
    siteId: null,
    ownerApp: "tenant_management",
    sourceApp: "tenant_management",
    ownerTenantId: null,
    ownerCompanyId: null,
  }));

  // Keep the sync idempotent under races (manual import / another worker /
  // previous run). Do not weaken or drop the DB uniqueness invariant.
  const inserted = await db
    .insert(bankMutationsTable)
    .values(toInsert)
    .onConflictDoNothing()
    .returning({ id: bankMutationsTable.id });
  const ids = inserted.map((r) => r.id);
  const skipped = totalRows - ids.length;

  const mc: MatchContext = { ownerTenantId: null, sourceApp: null };
  const matchResults = await Promise.allSettled(ids.map((id) => runMatchingForMutation(id, mc)));
  const autoMatched = matchResults.filter((r) => r.status === "fulfilled" && (r.value as any).autoMatched).length;

  logger.info({ newRows: ids.length, skipped, autoMatched, totalRows }, "[sheet-sync] Sinkronisasi selesai");
  await persistSyncResult({ success: true, newRows: ids.length, totalRows });
  return { newRows: ids.length, totalRows, skipped, autoMatched };
}

async function persistSyncResult(result: { success: boolean; newRows: number; totalRows: number; error?: string }) {
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
    // fire-and-forget
  }
}

function parseSheetRows(rows: string[][]): Array<typeof bankMutationsTable.$inferInsert> {
  const header = rows[0]?.map((h) => (h ?? "").trim().toLowerCase()) ?? [];
  const idx = (candidates: string[]) =>
    candidates.map((c) => header.indexOf(c)).find((i) => i >= 0) ?? -1;

  const dateIdx   = idx(["tanggal", "date", "tgl", "transaction_date"]);
  const descIdx   = idx(["keterangan", "description", "desc", "deskripsi", "ket"]);
  const creditIdx = idx(["kredit", "credit", "cr", "masuk", "credit_amount"]);
  const debitIdx  = idx(["debet", "debit", "db", "keluar", "debit_amount"]);
  const amountIdx = idx(["nominal", "amount", "jumlah"]);

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
      direction = "IN"; amount = credit;
    } else if (debit > 0 && credit === 0) {
      direction = "OUT"; amount = debit;
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
      transactionDate:        date,
      description,
      creditAmount:           String(credit),
      debitAmount:            String(debit),
      amount:                 String(amount),
      direction,
      mutationKey:            mutKey,
      normalizedDescription:  normDesc,
      providerName:           provider ?? undefined,
      providerOrderId:        orderId ?? undefined,
      rawPayload:             Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])) as Record<string, unknown>,
      status:                 "unmatched",
    }];
  });
}
