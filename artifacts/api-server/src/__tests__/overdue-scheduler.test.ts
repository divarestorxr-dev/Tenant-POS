import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@workspace/db";
import { tenantInvoicesTable, waLogsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { createTenant, createTestInvoice, cleanupTestData } from "./helpers/factory";

vi.mock("../lib/whatsapp", () => ({
  sendInvoiceNotification: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
  sendOverdueReminder: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
  sendDueReminder: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
  getAdminNotifyPhones: vi.fn().mockResolvedValue([]),
  getSiteCompanyName: vi.fn().mockResolvedValue("Test Company"),
  notifyAdminGroup: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
}));

import { runMonthlyDailyReminderCheck, runOverdueCheck } from "../lib/overdue-scheduler";
import { sendDueReminder, sendOverdueReminder } from "../lib/whatsapp";

describe("overdue invoice scheduler", () => {
  let tenantIds: number[] = [];

  beforeEach(() => {
    tenantIds = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (tenantIds.length > 0) {
      await db.delete(waLogsTable).where(inArray(waLogsTable.tenantId, tenantIds)).catch(() => {});
    }
    await cleanupTestData(tenantIds);
  });

  it("mengirim semua invoice overdue tenant aktif lintas bulan, sekali per hari, dan berhenti setelah lunas", async () => {
    const activeTenant = await createTenant({
      phone: "6281200000001",
      status: "active",
    });
    const inactiveTenant = await createTenant({
      phone: "6281200000002",
      status: "inactive",
    });
    tenantIds.push(activeTenant.id, inactiveTenant.id);

    const eligible = await createTestInvoice(activeTenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-ELIGIBLE-${Date.now()}`,
      dueDate: "2026-09-01",
      status: "unpaid",
      outstandingAmount: "100000",
    });
    await createTestInvoice(inactiveTenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-INACTIVE-${Date.now()}`,
      dueDate: "2026-09-01",
      status: "unpaid",
      outstandingAmount: "100000",
    });
    await createTestInvoice(activeTenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-AUGUST-${Date.now()}`,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      dueDate: "2026-08-31",
      status: "unpaid",
      outstandingAmount: "100000",
    });
    await createTestInvoice(activeTenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-PAID-${Date.now()}`,
      dueDate: "2026-09-01",
      status: "paid",
      paidAmount: "100000",
      outstandingAmount: "0",
    });
    await createTestInvoice(activeTenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-ZERO-${Date.now()}`,
      dueDate: "2026-09-01",
      status: "overdue",
      outstandingAmount: "0",
    });

    const firstRun = await runOverdueCheck();
    const sendMock = vi.mocked(sendOverdueReminder);
    const eligibleCalls = () =>
      sendMock.mock.calls.filter(([params]) => params.invoiceNumber === eligible.invoiceNumber);

    expect(firstRun).toBeGreaterThanOrEqual(1);
    expect(eligibleCalls()).toHaveLength(1);
    expect(sendMock.mock.calls.some(([params]) => params.invoiceNumber?.includes("INACTIVE"))).toBe(false);
    expect(sendMock.mock.calls.some(([params]) => params.invoiceNumber?.includes("AUGUST"))).toBe(true);
    expect(sendMock.mock.calls.some(([params]) => params.invoiceNumber?.includes("PAID"))).toBe(false);
    expect(sendMock.mock.calls.some(([params]) => params.invoiceNumber?.includes("ZERO"))).toBe(false);

    const deliveryLogs = await db
      .select()
      .from(waLogsTable)
      .where(eq(waLogsTable.invoiceId, eligible.id));
    expect(
      deliveryLogs.some(
        (row) => row.messageType === "overdue_reminder" && row.status === "accepted",
      ),
    ).toBe(true);

    // Menjalankan scheduler lagi pada hari yang sama tidak boleh mengirim invoice target dua kali.
    await runOverdueCheck();
    expect(eligibleCalls()).toHaveLength(1);

    // Setelah saldo menjadi lunas, invoice tidak boleh dikirim lagi meskipun claim hariannya dihapus.
    await db
      .update(tenantInvoicesTable)
      .set({
        status: "paid",
        paidAmount: "100000",
        outstandingAmount: "0",
        lastOverdueReminderAt: null,
      })
      .where(eq(tenantInvoicesTable.id, eligible.id));

    await runOverdueCheck();
    expect(eligibleCalls()).toHaveLength(1);
  });

  it("mempertahankan claim dan menghitung queued sekali saat CST WA Gateway queued", async () => {
    const tenant = await createTenant({
      phone: "6281200000099",
      status: "active",
    });
    tenantIds.push(tenant.id);

    const invoice = await createTestInvoice(tenant.id, undefined, {
      invoiceNumber: `INV-OVERDUE-PENDING-${Date.now()}`,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      dueDate: "2026-09-01",
      status: "unpaid",
      outstandingAmount: "100000",
      lastOverdueReminderAt: null,
    });

    vi.mocked(sendOverdueReminder).mockResolvedValueOnce({
      ok: true,
      skipped: false,
      pending: true,
    });

    const sent = await runOverdueCheck();
    expect(sent).toBeGreaterThanOrEqual(1);

    const [updated] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, invoice.id));
    expect(updated?.lastOverdueReminderAt).not.toBeNull();

    // Queued provider response tetap diklaim sebagai percobaan hari ini supaya
    // scheduler tidak mengirim ulang invoice yang sama berkali-kali.
    await runOverdueCheck();
    const pendingCalls = vi.mocked(sendOverdueReminder).mock.calls.filter(
      ([params]) => params.invoiceNumber === invoice.invoiceNumber,
    );
    expect(pendingCalls).toHaveLength(1);

    const deliveryLogs = await db
      .select()
      .from(waLogsTable)
      .where(eq(waLogsTable.invoiceId, invoice.id));
    expect(
      deliveryLogs.some(
        (row) =>
          row.messageType === "overdue_reminder" &&
          row.status === "queued" &&
          row.errorMessage === "CST WA Gateway queued",
      ),
    ).toBe(true);
  });
});

describe("daily reminder periode aktif", () => {
  let tenantIds: number[] = [];

  beforeEach(() => {
    tenantIds = [];
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T01:00:00.000Z"));
  });

  afterEach(async () => {
    if (tenantIds.length > 0) {
      await db.delete(waLogsTable).where(inArray(waLogsTable.tenantId, tenantIds)).catch(() => {});
    }
    await cleanupTestData(tenantIds);
    vi.useRealTimers();
  });

  it("mengirim reminder harian sebelum jatuh tempo dan tidak dobel di hari yang sama", async () => {
    const tenant = await createTenant({
      phone: "6281200000011",
      status: "active",
    });
    tenantIds.push(tenant.id);

    const invoice = await createTestInvoice(tenant.id, undefined, {
      invoiceNumber: `INV-DUE-H3-${Date.now()}`,
      periodStart: "2026-09-24",
      periodEnd: "2026-10-23",
      dueDate: "2026-09-27",
      status: "unpaid",
      outstandingAmount: "100000",
      lastPaymentReminderAt: null,
      invoiceNotifiedAt: new Date("2026-09-23T01:00:00.000Z"),
    });

    const first = await runMonthlyDailyReminderCheck();
    const sendMock = vi.mocked(sendDueReminder);
    const calls = () =>
      sendMock.mock.calls.filter(([params]) => params.invoiceNumber === invoice.invoiceNumber);

    expect(first.h3).toBeGreaterThanOrEqual(1);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.[0].daysUntilDue).toBe(3);

    await runMonthlyDailyReminderCheck();
    expect(calls()).toHaveLength(1);
  });

  it("mempertahankan claim reminder harian saat CST WA Gateway queued agar tidak dobel", async () => {
    const tenant = await createTenant({
      phone: "6281200000012",
      status: "active",
    });
    tenantIds.push(tenant.id);

    const invoice = await createTestInvoice(tenant.id, undefined, {
      invoiceNumber: `INV-DUE-H3-PENDING-${Date.now()}`,
      periodStart: "2026-09-24",
      periodEnd: "2026-10-23",
      dueDate: "2026-09-27",
      status: "unpaid",
      outstandingAmount: "100000",
      lastPaymentReminderAt: null,
      invoiceNotifiedAt: new Date("2026-09-23T01:00:00.000Z"),
    });

    vi.mocked(sendDueReminder).mockResolvedValueOnce({
      ok: true,
      skipped: false,
      pending: true,
    });

    const result = await runMonthlyDailyReminderCheck();
    expect(result.h3).toBeGreaterThanOrEqual(1);

    const [updated] = await db
      .select()
      .from(tenantInvoicesTable)
      .where(eq(tenantInvoicesTable.id, invoice.id));
    expect(updated?.lastPaymentReminderAt).not.toBeNull();

    await runMonthlyDailyReminderCheck();
    const pendingCalls = vi.mocked(sendDueReminder).mock.calls.filter(
      ([params]) => params.invoiceNumber === invoice.invoiceNumber,
    );
    expect(pendingCalls).toHaveLength(1);

    const deliveryLogs = await db
      .select()
      .from(waLogsTable)
      .where(eq(waLogsTable.invoiceId, invoice.id));
    expect(
      deliveryLogs.some(
        (row) =>
          row.messageType === "due_reminder" &&
          row.status === "queued" &&
          row.errorMessage === "CST WA Gateway queued",
      ),
    ).toBe(true);
  });

  it("tidak mengirim reminder sebelum period_start", async () => {
    const tenant = await createTenant({
      phone: "6281200000013",
      status: "active",
    });
    tenantIds.push(tenant.id);

    const invoice = await createTestInvoice(tenant.id, undefined, {
      invoiceNumber: `INV-FUTURE-${Date.now()}`,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      dueDate: "2026-10-10",
      status: "unpaid",
      outstandingAmount: "100000",
      invoiceNotifiedAt: null,
      lastPaymentReminderAt: null,
    });

    await runMonthlyDailyReminderCheck();
    const calls = vi.mocked(sendDueReminder).mock.calls.filter(
      ([params]) => params.invoiceNumber === invoice.invoiceNumber,
    );
    expect(calls).toHaveLength(0);
  });

  it("tidak mengirim reminder kedua pada hari tagihan awal baru dikirim", async () => {
    const tenant = await createTenant({
      phone: "6281200000014",
      status: "active",
    });
    tenantIds.push(tenant.id);

    const invoice = await createTestInvoice(tenant.id, undefined, {
      invoiceNumber: `INV-FIRST-DAY-${Date.now()}`,
      periodStart: "2026-09-24",
      periodEnd: "2026-10-23",
      dueDate: "2026-09-30",
      status: "unpaid",
      outstandingAmount: "100000",
      invoiceNotifiedAt: new Date("2026-09-24T01:00:00.000Z"),
      lastPaymentReminderAt: null,
    });

    await runMonthlyDailyReminderCheck();
    const calls = vi.mocked(sendDueReminder).mock.calls.filter(
      ([params]) => params.invoiceNumber === invoice.invoiceNumber,
    );
    expect(calls).toHaveLength(0);
  });

});

describe("overdue scheduler daily window guard", () => {
  beforeEach(() => {
    vi.stubEnv("TENANT_POS_BACKGROUND_MODE", "scheduled");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.doUnmock("@workspace/db");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("menjalankan catch-up sekali saat app restart setelah 08:00 WIB", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T09:30:00.000Z")); // 16:30 WIB

    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const select = vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn().mockResolvedValue([]);
      return chain;
    });

    vi.resetModules();
    vi.doMock("@workspace/db", async () => {
      const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
      return {
        ...actual,
        db: {
          execute,
          select,
        },
      };
    });

    const scheduler = await import("../lib/overdue-scheduler");
    scheduler.startOverdueScheduler();

    // Jika service melewatkan 08:00 karena restart/downtime, startup tetap
    // menjalankan catch-up. Claim per invoice/reminder mencegah duplikasi.
    await vi.advanceTimersByTimeAsync(30_000);
    const catchups = scheduler.getBlastHistory().filter(
      (run) => run.label === "startup catch-up after 08:00 WIB",
    );
    expect(catchups).toHaveLength(1);
  });

  it("hanya menjalankan satu blast pada window UTC yang sama dan boleh jalan lagi pada window berikutnya", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T01:00:00.000Z"));

    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const select = vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn().mockResolvedValue([]);
      return chain;
    });

    vi.resetModules();
    vi.doMock("@workspace/db", async () => {
      const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
      return {
        ...actual,
        db: {
          execute,
          select,
        },
      };
    });

    const scheduler = await import("../lib/overdue-scheduler");
    scheduler.startOverdueScheduler();

    // Tick pertama di 01:05 UTC memulai blast untuk window 2026-09-20-01.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(
      scheduler.getBlastHistory().filter((run) => run.label === "cron 1:00 UTC"),
    ).toHaveLength(1);

    // Tick kedua masih pada jam UTC yang sama; tidak boleh blast lagi.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(
      scheduler.getBlastHistory().filter((run) => run.label === "cron 1:00 UTC"),
    ).toHaveLength(1);

    // Pindah ke window hari berikutnya pada jam UTC yang sama.
    vi.setSystemTime(new Date("2026-09-21T01:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(
      scheduler.getBlastHistory().filter((run) => run.label === "cron 1:00 UTC"),
    ).toHaveLength(2);
  });
});
