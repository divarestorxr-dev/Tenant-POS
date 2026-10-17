import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCstWaGatewayConfigured,
  sendGatewayGroupText,
  sendGatewayMedia,
  sendGatewayText,
} from "../lib/whatsapp-gateway-client";

const keys = ["NODE_ENV", "APP_ENV", "CST_WA_GATEWAY_URL", "CST_WA_GATEWAY_TOKEN", "DISABLE_WHATSAPP_SEND"] as const;
const original = Object.fromEntries(keys.map(k => [k, process.env[k]])) as Record<(typeof keys)[number], string | undefined>;
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of keys) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("real WhatsApp delivery is forbidden in isolated DEV", () => {
  for (const [nodeEnv, appEnv] of [
    ["development", "development"],
    ["production", "development"],
    ["test", "development"],
  ]) {
    it(`blocks live WA when NODE_ENV=${nodeEnv} APP_ENV=${appEnv}`, async () => {
      process.env.NODE_ENV = nodeEnv;
      process.env.APP_ENV = appEnv;
      process.env.CST_WA_GATEWAY_URL = "https://wa.cstlogistic.co.id";
      process.env.CST_WA_GATEWAY_TOKEN = "dummy-test-token-present";
      const mockedFetch = vi.fn();
      vi.stubGlobal("fetch", mockedFetch);
      expect(isCstWaGatewayConfigured()).toBe(false);
      await expect(sendGatewayText("08123456789", "no live sends")).resolves.toMatchObject({ skipped: true });
      await expect(sendGatewayGroupText("120363426361032308@g.us", "no live group")).resolves.toMatchObject({ skipped: true });
      await expect(sendGatewayMedia("120363426361032308@g.us", "no live attachment", "https://example.com/test.pdf")).resolves.toMatchObject({ skipped: true });
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  }
});
