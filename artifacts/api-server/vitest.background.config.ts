import { defineConfig } from "vitest/config";

// These tests use local adapters only and must not open a database connection.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/background-work.test.ts"],
    testTimeout: 10_000,
    env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
  },
});
