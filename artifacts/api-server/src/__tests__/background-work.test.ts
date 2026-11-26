import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IRouter, Request, Response } from "express";
import { getBackgroundWorkMode } from "../lib/background-work-policy";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  readFromSheet: vi.fn(),
  createInvoices: vi.fn(),
  sendInvoice: vi.fn(),
  sendDue: vi.fn(),
  sendOverdue: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    execute: mocks.execute,
    select: mocks.select,
    insert: mocks.insert,
    update: mocks.update,
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() },
}));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/auto-invoice", () => ({
  createAllInvoicesForBooking: mocks.createInvoices,
  countContractBillingPeriods: vi.fn(),
}));
vi.mock("../lib/whatsapp", () => ({
  sendInvoiceNotification: mocks.sendInvoice,
  sendOverdueReminder: mocks.sendOverdue,
  sendDueReminder: mocks.sendDue,
  getAdminNotifyPhones: vi.fn(),
  getSiteCompanyName: vi.fn(),
  notifyAdminGroup: vi.fn(),
}));
vi.mock("../lib/app-url", () => ({ getBaseUrl: vi.fn() }));
vi.mock("../services/google-sheets", () => ({
  readFromSheet: mocks.readFromSheet,
  extractSheetId: vi.fn((id: string) => id),
}));
vi.mock("../services/bank-matcher", () => ({
  normalizeDescription: vi.fn(),
  extractOrderId: vi.fn(),
  detectProvider: vi.fn(),
  buildMutationKey: vi.fn(),
  runMatchingForMutation: vi.fn(),
}));

function selection(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function routeRequest(router: IRouter, method: string, url: string, role?: string, body?: Record<string, unknown>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    // Test session only; execute the actual router and its role/user middleware.
    const req = {
      method, url, originalUrl: url, headers: {}, body,
      isAuthenticated: () => Boolean(role),
      user: role ? { dbId: "dev-test-user", role, name: "DEV test" } : undefined,
    };
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Record<string, unknown>) { resolve({ status: this.statusCode, body }); },
    };
    router(req as Request, res as unknown as Response, (error?: unknown) => {
      reject(error ?? new Error("Test request did not match a route"));
    });
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TENANT_POS_BACKGROUND_MODE", "");
  mocks.execute.mockResolvedValue({ rows: [] });
  mocks.select.mockImplementation((fields: Record<string, unknown>) => selection(
    "forceLogoutAt" in fields ? [{ status: "active", forceLogoutAt: null }] : [],
  ));
  mocks.readFromSheet.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("background work mode", () => {
  it.each([
    [{}, "on-demand"],
    [{ NODE_ENV: "development" }, "on-demand"],
    [{ NODE_ENV: "test" }, "on-demand"],
    [{ NODE_ENV: "production" }, "scheduled"],
    [{ NODE_ENV: "production", APP_ENV: "development" }, "on-demand"],
    [{ NODE_ENV: "production", TENANT_POS_BACKGROUND_MODE: "on-demand" }, "on-demand"],
    [{ NODE_ENV: "development", TENANT_POS_BACKGROUND_MODE: "scheduled" }, "scheduled"],
  ])("resolves %j to %s", (env, expected) => {
    expect(getBackgroundWorkMode(env)).toBe(expected);
  });

  it("rejects an unknown mode instead of starting scheduled work", () => {
    expect(() => getBackgroundWorkMode({ TENANT_POS_BACKGROUND_MODE: "ondemand" }))
      .toThrow("TENANT_POS_BACKGROUND_MODE must be on-demand or scheduled");
  });
});

describe("on-demand background jobs", () => {
  it.each(["", "on-demand"])("keeps idle DEV free of business timers and DB scans (mode=%s)", async (mode) => {
    vi.stubEnv("TENANT_POS_BACKGROUND_MODE", mode);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T07:00:00Z"));
    const overdue = await import("../lib/overdue-scheduler");
    const sheets = await import("../lib/sheet-sync-scheduler");

    overdue.startOverdueScheduler();
    sheets.startSheetSyncScheduler();
    overdue.startOverdueScheduler();
    sheets.startSheetSyncScheduler();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.readFromSheet).not.toHaveBeenCalled();
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.sendInvoice).not.toHaveBeenCalled();
    expect(mocks.sendDue).not.toHaveBeenCalled();
    expect(mocks.sendOverdue).not.toHaveBeenCalled();
    expect(overdue.getBlastStatus()).toMatchObject({
      backgroundMode: "on-demand", nextScheduledHoursUtc: [], isRunning: false, lastRunAt: null,
    });
  });

  it("runs an explicitly requested Sheet sync once without starting a timer", async () => {
    vi.useFakeTimers();
    const sheets = await import("../lib/sheet-sync-scheduler");
    sheets.startSheetSyncScheduler();

    await expect(sheets.runSheetSync({ spreadsheetId: "dev-fixture" })).resolves.toMatchObject({
      newRows: 0, totalRows: 0,
    });
    expect(mocks.readFromSheet).toHaveBeenCalledTimes(1);
    expect(mocks.readFromSheet).toHaveBeenCalledWith({ spreadsheetId: "dev-fixture", range: "A:Z" });
    const readsAfterRequest = mocks.select.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mocks.select).toHaveBeenCalledTimes(readsAfterRequest);
    expect(mocks.readFromSheet).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps billing authenticated, executes one request, and rejects overlap", async () => {
    const { default: blastRouter } = await import("../routes/blast-tagihan");
    const overdue = await import("../lib/overdue-scheduler");

    expect((await routeRequest(blastRouter, "POST", "/blast-tagihan/trigger")).status).toBe(401);
    expect((await routeRequest(blastRouter, "POST", "/blast-tagihan/trigger", "cashier")).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();

    let release!: (value: { rows: unknown[] }) => void;
    mocks.execute.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    expect((await routeRequest(blastRouter, "POST", "/blast-tagihan/trigger", "finance")).status).toBe(200);
    expect(overdue.getBlastStatus().isRunning).toBe(true);
    expect((await routeRequest(blastRouter, "POST", "/blast-tagihan/trigger", "finance")).status).toBe(409);
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    release({ rows: [] });
    await vi.waitFor(() => expect(overdue.getBlastStatus().isRunning).toBe(false));
    expect(overdue.getBlastHistory()).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const status = await routeRequest(blastRouter, "GET", "/blast-tagihan/status", "finance");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      backgroundMode: "on-demand", nextScheduledHoursUtc: [], scheduledTimesWib: [], isRunning: false,
    });
  });
});

describe("scheduled mode compatibility", () => {
  it("preserves production catch-up and Sheet scheduling by default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T07:00:00Z"));
    const overdue = await import("../lib/overdue-scheduler");
    const sheets = await import("../lib/sheet-sync-scheduler");
    overdue.startOverdueScheduler();
    sheets.startSheetSyncScheduler();
    expect(overdue.getBlastStatus()).toMatchObject({ backgroundMode: "scheduled", nextScheduledHoursUtc: [1] });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(overdue.getBlastHistory()).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    mocks.select.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.readFromSheet).not.toHaveBeenCalled();
  });

  it("preserves a single daily billing run in the scheduled window", async () => {
    vi.stubEnv("TENANT_POS_BACKGROUND_MODE", "scheduled");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T00:59:00Z"));
    const overdue = await import("../lib/overdue-scheduler");
    overdue.startOverdueScheduler();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(overdue.getBlastHistory().filter((run) => run.label === "cron 1:00 UTC")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(overdue.getBlastHistory().filter((run) => run.label === "cron 1:00 UTC")).toHaveLength(1);
  });
});

describe("Sheet sync configuration mode", () => {
  it.each(["on-demand", "scheduled"])("reports the runtime mode with no stored config (mode=%s)", async (mode) => {
    vi.stubEnv("TENANT_POS_BACKGROUND_MODE", mode);
    const { default: bankRouter } = await import("../routes/bank-reconciliation");

    const response = await routeRequest(bankRouter, "GET", "/bank-reconciliation/sync-config", "finance");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      backgroundMode: mode, enabled: false, spreadsheetId: "", intervalMinutes: 5,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reports the current process mode without mutating stored configuration", async () => {
    const storedConfig = Object.freeze({ enabled: true, spreadsheetId: "dev-fixture", backgroundMode: "scheduled" });
    mocks.select.mockReturnValue(selection([{ value: storedConfig }]));
    const { default: bankRouter } = await import("../routes/bank-reconciliation");

    const response = await routeRequest(bankRouter, "GET", "/bank-reconciliation/sync-config", "finance");
    expect(response.body).toEqual({ ...storedConfig, backgroundMode: "on-demand" });
    expect(storedConfig.backgroundMode).toBe("scheduled");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps config writes authenticated and excludes runtime mode from persisted values", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.insert.mockReturnValue({ values });
    const { default: bankRouter } = await import("../routes/bank-reconciliation");
    const url = "/bank-reconciliation/sync-config";
    const config = {
      enabled: true, spreadsheetId: "dev-fixture", sheetName: "", bankAccountId: "", intervalMinutes: 5,
    };
    const requestBody = { ...config, backgroundMode: "scheduled" };

    expect((await routeRequest(bankRouter, "POST", url, undefined, requestBody)).status).toBe(401);
    expect((await routeRequest(bankRouter, "POST", url, "cashier", requestBody)).status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect((await routeRequest(bankRouter, "POST", url, "finance", requestBody)).status).toBe(200);
    expect(values).toHaveBeenCalledExactlyOnceWith({ key: "bank_rekon_sync_config", value: config });
  });
});
