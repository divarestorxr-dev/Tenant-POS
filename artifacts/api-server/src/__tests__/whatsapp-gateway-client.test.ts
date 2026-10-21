import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCstWaGatewayStatus,
  isCstWaGatewayConfigured,
  normalizeWhatsappDestination,
  sendGatewayGroupText,
  sendGatewayText,
  verifyCstWaInboundEvent,
} from "../lib/whatsapp-gateway-client";

describe("CST WA Gateway client", () => {
  const original = {
    url: process.env.CST_WA_GATEWAY_URL,
    key: process.env.CST_WA_GATEWAY_TOKEN,
    device: process.env.CST_WA_DEVICE_ID,
    timeout: process.env.CST_WA_GATEWAY_TIMEOUT_MS,
  };

  beforeEach(() => {
    process.env.CST_WA_GATEWAY_URL = "https://wa.example.test";
    process.env.CST_WA_GATEWAY_TOKEN = "tenant-pos-test-key";
    process.env.CST_WA_DEVICE_ID = "tenant-pos-01";
    process.env.CST_WA_GATEWAY_TIMEOUT_MS = "1000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original.url === undefined) delete process.env.CST_WA_GATEWAY_URL;
    else process.env.CST_WA_GATEWAY_URL = original.url;
    if (original.key === undefined) delete process.env.CST_WA_GATEWAY_TOKEN;
    else process.env.CST_WA_GATEWAY_TOKEN = original.key;
    if (original.device === undefined) delete process.env.CST_WA_DEVICE_ID;
    else process.env.CST_WA_DEVICE_ID = original.device;
    if (original.timeout === undefined) delete process.env.CST_WA_GATEWAY_TIMEOUT_MS;
    else process.env.CST_WA_GATEWAY_TIMEOUT_MS = original.timeout;
  });

  it("normalizes Indonesian phone numbers and preserves group JID", () => {
    expect(normalizeWhatsappDestination("08123456789")).toBe("628123456789");
    expect(normalizeWhatsappDestination("+628123456789")).toBe("628123456789");
    expect(normalizeWhatsappDestination("12036341119221335@g.us")).toBe("12036341119221335@g.us");
  });

  it("sends text with client token, device id, and idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "queued", messageId: "msg-123" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendGatewayText("08123456789", "Halo", "invoice:123");

    expect(result).toMatchObject({ ok: true, queued: true, duplicate: false, messageId: "msg-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://wa.example.test/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tenant-pos-test-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "invoice:123",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      deviceId: "tenant-pos-01",
      to: "628123456789",
      type: "text",
      text: "Halo",
    });
  });

  it("routes raw group JID passed to sendGatewayText through gateway groupId lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            groups: [
              {
                id: "group-tenant-pos-raw",
                deviceId: "tenant-pos-01",
                jid: "120363426361032308@g.us",
                subject: "Admin TOD",
                isActive: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "queued", messageId: "msg-group-raw" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendGatewayText("120363426361032308@g.us", "test");
    expect(result).toMatchObject({ ok: true, queued: true, messageId: "msg-group-raw" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("https://wa.example.test/v1/messages");
    expect(JSON.parse(String(sendInit.body))).toEqual({
      deviceId: "tenant-pos-01",
      groupId: "group-tenant-pos-raw",
      type: "text",
      text: "test",
    });
  });

  it("resolves an allowed WhatsApp group and sends it by groupId", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            groups: [
              {
                id: "group-tenant-pos-123",
                deviceId: "tenant-pos-01",
                jid: "12036341119221335@g.us",
                subject: "Admin Tenant POS",
                isActive: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "queued", messageId: "msg-group-1" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendGatewayGroupText("12036341119221335@g.us", "Tes Group", "group:test:1"),
    ).resolves.toMatchObject({
      ok: true,
      queued: true,
      messageId: "msg-group-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [groupsUrl, groupsInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(groupsUrl).toBe("https://wa.example.test/v1/groups?deviceId=tenant-pos-01");
    expect(groupsInit.method).toBe("GET");
    expect((groupsInit.headers as Record<string, string>).Authorization).toBe("Bearer tenant-pos-test-key");

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("https://wa.example.test/v1/messages");
    expect(sendInit.headers).toMatchObject({
      Authorization: "Bearer tenant-pos-test-key",
      "Idempotency-Key": "group:test:1",
    });
    expect(JSON.parse(String(sendInit.body))).toEqual({
      deviceId: "tenant-pos-01",
      groupId: "group-tenant-pos-123",
      type: "text",
      text: "Tes Group",
    });
  });

  it("does not send when the configured admin group is not available to the Tenant POS device", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          groups: [
            {
              id: "other-group",
              deviceId: "tenant-pos-01",
              jid: "120363400000000000@g.us",
              subject: "Other Group",
              isActive: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendGatewayGroupText("120363499999999999@g.us", "Tes Group"),
    ).resolves.toMatchObject({
      ok: false,
      error: "CST WA Gateway: GROUP_NOT_FOUND_FOR_TENANT_POS_DEVICE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats gateway duplicate response as accepted queued delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "duplicate", messageId: "msg-existing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(sendGatewayText("628123456789", "Halo", "same-key")).resolves.toMatchObject({
      ok: true,
      queued: true,
      duplicate: true,
      messageId: "msg-existing",
    });
  });

  it("skips outbound safely when client API key is missing", async () => {
    delete process.env.CST_WA_GATEWAY_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(isCstWaGatewayConfigured()).toBe(false);
    await expect(sendGatewayText("628123456789", "Halo")).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the authenticated Tenant POS device online", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      devices: [{ deviceId: "tenant-pos-01", enabled: true, status: "ONLINE", workerId: "worker-01:tenant-pos-01" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getCstWaGatewayStatus();
    expect(result).toMatchObject({ configured: true, connected: true, provider: "CST WA Gateway", onlineWorkers: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/devices");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it("reports offline when assigned device is not ONLINE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      devices: [{ deviceId: "tenant-pos-01", enabled: true, status: "QR_REQUIRED" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCstWaGatewayStatus()).toMatchObject({ configured: true, connected: false, onlineWorkers: 0 });
  });

  it("reports unknown when client lacks device read permissions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "FORBIDDEN" }), { status: 403, headers: { "content-type": "application/json" } })));
    const result = await getCstWaGatewayStatus();
    expect(result).toMatchObject({ configured: true, connected: null });
    expect(result.message).toContain("messages:read");
  });

  it("verifies inbound event payload through the client-scoped gateway endpoint", async () => {
    const payload = {
      event: "message.received",
      deviceId: "tenant-pos-01",
      senderPhone: "628123456789",
      message: { key: { remoteJid: "628123456789@s.whatsapp.net" }, message: { conversation: "SETUJU 10" } },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deliveryId: "evt-1", payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyCstWaInboundEvent("evt-1", payload)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://wa.example.test/v1/inbound-events/evt-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tenant-pos-test-key");
  });
});
