import { describe, expect, it } from "vitest";
import { isDevLoginEnabled } from "../lib/dev-login-policy";

describe("DEV login policy", () => {
  it("never enables development login in production", () => {
    expect(isDevLoginEnabled("production", "true")).toBe(false);
    expect(isDevLoginEnabled("production", undefined)).toBe(false);
  });

  it("respects an explicit disable in development and test", () => {
    expect(isDevLoginEnabled("development", "false")).toBe(false);
    expect(isDevLoginEnabled("test", "false")).toBe(false);
  });

  it("preserves existing local test behavior when not explicitly disabled", () => {
    expect(isDevLoginEnabled("test", undefined)).toBe(true);
    expect(isDevLoginEnabled("development", "true")).toBe(true);
  });
});
