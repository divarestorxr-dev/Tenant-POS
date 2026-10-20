import { logger } from "./logger";

export interface GatewaySendResult {
  ok: boolean;
  skipped?: boolean;
  queued?: boolean;
  duplicate?: boolean;
  messageId?: string | null;
  response?: unknown;
  error?: string;
}

export interface GatewayStatus {
  configured: boolean;
  connected: boolean | null;
  provider: "CST WA Gateway";
  message: string;
  onlineWorkers?: number;
  queueCount?: number;
  workers?: Array<Record<string, unknown>>;
}

function gatewayBaseUrl(): string {
  return (process.env.CST_WA_GATEWAY_URL ?? "https://wa.cstlogistic.co.id").replace(/\/+$/, "");
}

function gatewayToken(): string {
  return process.env.CST_WA_GATEWAY_TOKEN?.trim() ?? "";
}

function gatewayDeviceId(): string | undefined {
  const value = process.env.CST_WA_DEVICE_ID?.trim();
  return value || undefined;
}

export function isCstWaGatewayConfigured(): boolean {
  // DEV/test must never contact a real gateway, even when a production token
  // happens to be present in the preview environment.
  // The reserved .test hostname is permitted only in unit tests with mocked fetch.
  const fixture = process.env.NODE_ENV === "test" &&
    gatewayBaseUrl() === "https://wa.example.test";
  if (!fixture && (
    process.env.NODE_ENV !== "production" ||
    process.env.APP_ENV === "development" ||
    process.env.DISABLE_WHATSAPP_SEND === "true"
  )) return false;
  return gatewayToken().length > 0;
}

export function normalizeWhatsappDestination(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9]+(?:-[0-9]+)?@g\.us$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("62")) return digits;
  return "62" + digits;
}

async function gatewayFetch(
  path: string,
  init: RequestInit = {},
  requireAuth = true,
): Promise<Response> {
  const key = gatewayToken();
  if (requireAuth && !key) {
    throw new Error("CST_WA_GATEWAY_TOKEN belum dikonfigurasi");
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.CST_WA_GATEWAY_TIMEOUT_MS ?? "15000");
  const timeoutId = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 15000);

  try {
    return await fetch(`${gatewayBaseUrl()}${path}`, {
      ...init,
      headers: {
        ...(requireAuth ? { Authorization: `Bearer ${key}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function responseError(data: Record<string, unknown>, status: number): string {
  const raw = data["error"] ?? data["message"] ?? data["detail"] ?? `HTTP ${status}`;
  return `CST WA Gateway: ${String(raw)}`;
}

async function sendPayload(
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<GatewaySendResult> {
  if (!isCstWaGatewayConfigured()) {
    logger.warn("[wa-gateway] CST_WA_GATEWAY_TOKEN belum dikonfigurasi");
    return { ok: true, skipped: true, error: "CST_WA_GATEWAY_TOKEN belum dikonfigurasi" };
  }

  try {
    const res = await gatewayFetch("/v1/messages", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      body: JSON.stringify({
        ...(gatewayDeviceId() ? { deviceId: gatewayDeviceId() } : {}),
        ...payload,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const error = responseError(data, res.status);
      logger.error({ status: res.status, data }, "[wa-gateway] pengiriman gagal");
      return { ok: false, error, response: data };
    }

    const status = String(data["status"] ?? "").toLowerCase();
    const messageId = typeof data["messageId"] === "string" ? data["messageId"] : null;
    const duplicate = status === "duplicate";
    const queued = status === "queued" || duplicate;

    if (!queued) {
      return {
        ok: false,
        error: `CST WA Gateway mengembalikan status tidak dikenal: ${status || "kosong"}`,
        response: data,
      };
    }

    return { ok: true, queued, duplicate, messageId, response: data };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const error = isTimeout
      ? "CST WA Gateway timeout"
      : err instanceof Error
        ? err.message
        : String(err);
    logger.error({ err }, "[wa-gateway] request gagal");
    return { ok: false, error };
  }
}

export async function sendGatewayText(
  to: string,
  text: string,
  idempotencyKey?: string,
): Promise<GatewaySendResult> {
  const normalized = normalizeWhatsappDestination(to);
  if (normalized.endsWith("@g.us")) {
    return sendGatewayGroupText(normalized, text, idempotencyKey);
  }

  return sendPayload(
    {
      to: normalized,
      type: "text",
      text,
    },
    idempotencyKey,
  );
}

type GatewayGroupRecord = {
  id: string;
  deviceId?: string;
  jid: string;
  name?: string | null;
  subject?: string | null;
  isActive?: boolean;
};

const groupIdCache = new Map<string, { groupId: string; expiresAt: number }>();
const GROUP_ID_CACHE_MS = 5 * 60 * 1000;

async function resolveGatewayGroupId(groupJid: string): Promise<string> {
  const normalizedJid = groupJid.trim();
  if (!/^[0-9]+(?:-[0-9]+)?@g\.us$/.test(normalizedJid)) {
    throw new Error("ADMIN_WA_GROUP format tidak valid");
  }

  const cached = groupIdCache.get(normalizedJid);
  if (cached && cached.expiresAt > Date.now()) return cached.groupId;
  if (cached) groupIdCache.delete(normalizedJid);

  const deviceId = gatewayDeviceId();
  const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  const res = await gatewayFetch(`/v1/groups${query}`, { method: "GET" });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(responseError(data, res.status));
  }

  const groups = Array.isArray(data["groups"])
    ? (data["groups"] as Array<Record<string, unknown>>)
    : [];
  const match = groups.find((group) =>
    String(group["jid"] ?? "") === normalizedJid &&
    group["isActive"] !== false,
  );

  const groupId = typeof match?.["id"] === "string" ? match["id"] : "";
  if (!groupId) {
    throw new Error("CST WA Gateway: GROUP_NOT_FOUND_FOR_TENANT_POS_DEVICE");
  }

  groupIdCache.set(normalizedJid, {
    groupId,
    expiresAt: Date.now() + GROUP_ID_CACHE_MS,
  });
  return groupId;
}

export async function sendGatewayGroupText(
  groupJid: string,
  text: string,
  idempotencyKey?: string,
): Promise<GatewaySendResult> {
  if (!isCstWaGatewayConfigured()) {
    logger.warn("[wa-gateway] CST_WA_GATEWAY_TOKEN belum dikonfigurasi");
    return { ok: true, skipped: true, error: "CST_WA_GATEWAY_TOKEN belum dikonfigurasi" };
  }

  try {
    const groupId = await resolveGatewayGroupId(groupJid);
    return await sendPayload(
      {
        groupId,
        type: "text",
        text,
      },
      idempotencyKey,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, groupJid }, "[wa-gateway] pengiriman group gagal");
    return { ok: false, error };
  }
}

function mediaDescriptor(fileUrl: string): {
  type: "image" | "video" | "audio" | "document";
  fileName?: string;
  mimetype?: string;
} {
  let pathname = "";
  try {
    pathname = new URL(fileUrl).pathname.toLowerCase();
  } catch {
    pathname = fileUrl.toLowerCase();
  }
  const fileName = decodeURIComponent(pathname.split("/").pop() || "lampiran");

  if (/\.(png|jpe?g|webp)$/i.test(pathname)) {
    const mimetype = pathname.endsWith(".png")
      ? "image/png"
      : pathname.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    return { type: "image", mimetype };
  }
  if (/\.(mp4|mov|webm)$/i.test(pathname)) {
    return { type: "video", mimetype: pathname.endsWith(".webm") ? "video/webm" : "video/mp4" };
  }
  if (/\.(mp3|ogg|m4a|wav)$/i.test(pathname)) {
    return { type: "audio", mimetype: pathname.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg" };
  }
  return {
    type: "document",
    fileName,
    mimetype: pathname.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
  };
}

export async function sendGatewayMedia(
  to: string,
  caption: string,
  fileUrl: string,
  idempotencyKey?: string,
): Promise<GatewaySendResult> {
  if (!isCstWaGatewayConfigured()) {
    return { ok: true, skipped: true, error: "DEV WhatsApp sending disabled" };
  }
  const media = mediaDescriptor(fileUrl);
  const normalized = normalizeWhatsappDestination(to);

  if (normalized.endsWith("@g.us")) {
    try {
      const groupId = await resolveGatewayGroupId(normalized);
      return sendPayload(
        {
          groupId,
          type: media.type,
          mediaUrl: fileUrl,
          ...(caption ? { caption } : {}),
          ...(media.fileName ? { fileName: media.fileName } : {}),
          ...(media.mimetype ? { mimetype: media.mimetype } : {}),
        },
        idempotencyKey,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, groupJid: normalized }, "[wa-gateway] pengiriman media group gagal");
      return { ok: false, error };
    }
  }

  return sendPayload(
    {
      to: normalized,
      type: media.type,
      mediaUrl: fileUrl,
      ...(caption ? { caption } : {}),
      ...(media.fileName ? { fileName: media.fileName } : {}),
      ...(media.mimetype ? { mimetype: media.mimetype } : {}),
    },
    idempotencyKey,
  );
}

export async function getCstWaGatewayStatus(): Promise<GatewayStatus> {
  const configured = isCstWaGatewayConfigured();
  try {
    const res = await gatewayFetch("/v1/status", { method: "GET" }, false);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const workers = Array.isArray(data["workers"])
      ? (data["workers"] as Array<Record<string, unknown>>)
      : [];
    const onlineWorkers = Number(data["onlineWorkers"] ?? 0);
    const queue = (data["queue"] ?? {}) as Record<string, unknown>;
    const queueCount =
      Number(queue["waiting"] ?? 0) +
      Number(queue["active"] ?? 0) +
      Number(queue["delayed"] ?? 0);
    // /v1/status sengaja mengembalikan HTTP 503 jika overall gateway degraded,
    // misalnya satu device QR_REQUIRED. Selama masih ada worker ONLINE,
    // Tenant-POS tetap memiliki jalur pengiriman WhatsApp yang aktif.
    const connected = onlineWorkers > 0;
    const overallStatus = String(data["overallStatus"] ?? "unknown");

    return {
      configured,
      connected,
      provider: "CST WA Gateway",
      message: connected
        ? overallStatus === "operational"
          ? "WhatsApp aktif melalui CST WA Gateway"
          : `CST WA Gateway degraded, tetapi ${onlineWorkers} worker WhatsApp masih online`
        : "CST WA Gateway belum memiliki worker WhatsApp online",
      onlineWorkers,
      queueCount,
      workers,
    };
  } catch (err) {
    return {
      configured,
      connected: null,
      provider: "CST WA Gateway",
      message: err instanceof Error ? err.message : "Tidak dapat menghubungi CST WA Gateway",
    };
  }
}

export async function verifyCstWaInboundEvent(
  eventId: string,
  incomingPayload: unknown,
): Promise<boolean> {
  if (!eventId || !isCstWaGatewayConfigured()) return false;

  try {
    const res = await gatewayFetch(`/v1/inbound-events/${encodeURIComponent(eventId)}`, {
      method: "GET",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return JSON.stringify(data["payload"]) === JSON.stringify(incomingPayload);
  } catch (err) {
    logger.warn({ err, eventId }, "[wa-gateway] verifikasi inbound event gagal");
    return false;
  }
}
