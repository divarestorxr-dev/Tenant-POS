import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { tenantPaymentsTable } from "@workspace/db/schema";
import { createTestApp } from "./helpers/app";
import { createTenant, createTestInvoice, cleanupTestData } from "./helpers/factory";

vi.mock("../lib/supabase-storage", () => ({
  getPaymentProofBucket: () => "test-proof-bucket",
  uploadToStorage: vi.fn(async () => "e2e-test/proof.png"),
}));

const app = createTestApp("owner");
let tenantIds: number[] = [];
afterEach(async () => { await cleanupTestData(tenantIds); tenantIds = []; });

describe("admin direct payment date and evidence contract", () => {
  it("uses actual payment date, preserves record date, and persists proof", async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const invoice = await createTestInvoice(tenant.id);
    const result = await request(app).post("/api/tenant-invoices/" + invoice.id + "/payment")
      .field("amountPaid", "3000000")
      .field("paymentMethod", "transfer")
      .field("paymentDate", "2026-10-01")
      .field("notes", "Backdated bank receipt regression")
      .attach("proof", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: "transfer.png", contentType: "image/png" });

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const [payment] = await db.select().from(tenantPaymentsTable).where(eq(tenantPaymentsTable.id, result.body.payment.id));
    expect(payment).toBeTruthy();
    expect(payment.paidAt?.toISOString()).toBe("2026-10-01T05:00:00.000Z");
    expect(payment.createdAt!.getTime()).toBeGreaterThan(payment.paidAt!.getTime());
    expect(payment.proofUrl).toBe("e2e-test/proof.png");
    expect(payment.proofImageUrl).toBe("e2e-test/proof.png");
    expect(result.body.invoiceStatus).toBe("partial");
    expect(Number(result.body.outstandingAmount)).toBe(2000000);
  });

  it("rejects a future payment date before creating any payment", async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const invoice = await createTestInvoice(tenant.id);
    const res = await request(app).post("/api/tenant-invoices/" + invoice.id + "/payment")
      .send({ amountPaid: 100000, paymentMethod: "transfer", paymentDate: "2099-01-01" });
    expect(res.status).toBe(400);
    const rows = await db.select().from(tenantPaymentsTable).where(eq(tenantPaymentsTable.invoiceId, invoice.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects impossible calendar dates", async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const invoice = await createTestInvoice(tenant.id);
    const res = await request(app).post("/api/tenant-invoices/" + invoice.id + "/payment")
      .send({ amountPaid: 100000, paymentMethod: "transfer", paymentDate: "2026-02-30" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid proof MIME instead of silently recording a payment", async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const invoice = await createTestInvoice(tenant.id);
    const res = await request(app).post("/api/tenant-invoices/" + invoice.id + "/payment")
      .field("amountPaid", "100000")
      .field("paymentMethod", "transfer")
      .field("paymentDate", "2026-10-01")
      .attach("proof", Buffer.from("unsafe"), { filename: "invalid.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    const rows = await db.select().from(tenantPaymentsTable).where(eq(tenantPaymentsTable.invoiceId, invoice.id));
    expect(rows).toHaveLength(0);
  });
});