import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createApiBuildOptions } from "../build.mjs";

// Each scenario gets a disposable process. In particular, use a real failed
// Pino transport: a fake logger cannot detect Pino's synchronous exit-hook hang.
const execFileAsync = promisify(execFile);
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(apiDir, "src/lib/process-errors.ts");
const probeDir = await mkdtemp(path.join(os.tmpdir(), "tenant-process-errors-"));

try {
  const entryPoint = path.join(probeDir, "probe.ts");
  const distDir = path.join(probeDir, "dist");
  await writeFile(entryPoint, `
import { closeSync } from "node:fs";
import { createRequire } from "node:module";
import pino from "pino";
import { installProcessErrorHandlers } from ${JSON.stringify(helperPath)};

installProcessErrorHandlers();
installProcessErrorHandlers();
const mode = process.argv[2];
if (mode === "rejection") {
  void Promise.reject(new Error("EXPECTED_REJECTION"));
} else if (mode === "closed-stderr") {
  closeSync(2);
  setImmediate(() => { throw new Error("EXPECTED_CLOSED_STDERR"); });
} else if (mode === "failed-pino-worker" || mode === "healthy-pino-flush") {
  if (mode === "failed-pino-worker") {
    globalThis.__bundlerPathsOverrides = {
      "thread-stream-worker": ${JSON.stringify(path.join(probeDir, "missing-worker.cjs"))},
    };
  }
  const runtimeRequire = createRequire(import.meta.url);
  const logger = pino({
    transport: { target: runtimeRequire.resolve("pino-pretty"), options: { colorize: false } },
  });
  logger.info("HEALTHY_TRANSPORT_PROBE");
  if (mode === "healthy-pino-flush") {
    setTimeout(() => { throw new Error("EXPECTED_HEALTHY_TRANSPORT_FATAL"); }, 150);
  }
} else if (mode === "repeated-errors") {
  process.emit("uncaughtException", new Error("EXPECTED_FIRST_ERROR"));
  process.emit("uncaughtException", new Error("EXPECTED_SECOND_ERROR"));
} else {
  setImmediate(() => { throw new Error("EXPECTED_UNCAUGHT_ERROR"); });
}
`);
  const options = createApiBuildOptions({ entryPoint, distDir });
  options.logLevel = "warning";
  await build(options);
  await symlink(path.join(apiDir, "node_modules"), path.join(distDir, "node_modules"), "junction");

  for (const mode of [
    "uncaught",
    "rejection",
    "failed-pino-worker",
    "healthy-pino-flush",
    "repeated-errors",
    "closed-stderr",
  ]) {
    const started = performance.now();
    let result;
    try {
      const output = await execFileAsync(process.execPath, [path.join(distDir, "probe.mjs"), mode], {
        cwd: distDir,
        timeout: 3_000,
        maxBuffer: 128 * 1024,
      });
      result = { ...output, code: 0 };
    } catch (error) {
      if (error.killed || error.signal || typeof error.code !== "number") throw error;
      result = error;
    }
    const elapsedMs = performance.now() - started;
    assert.equal(result.code, 1, `${mode}: must terminate with a failure exit code`);
    assert.ok(elapsedMs < 3_000, `${mode}: failure termination exceeded its deadline`);
    if (mode === "closed-stderr") {
      assert.equal(result.stderr, "", "closed stderr still allowed failure termination");
    } else {
      assert.equal((result.stderr.match(/\[fatal\]/g) ?? []).length, 1, `${mode}: fatal output must be emitted once`);
      assert.ok(result.stderr.length < 9_000, `${mode}: repeated error output detected`);
    }
    if (mode === "rejection") assert.match(result.stderr, /unhandledRejection/);
    if (mode === "failed-pino-worker") assert.match(result.stderr, /missing-worker/);
    if (mode === "healthy-pino-flush") assert.match(result.stdout, /HEALTHY_TRANSPORT_PROBE/);
    if (mode === "repeated-errors") assert.doesNotMatch(result.stderr, /EXPECTED_SECOND_ERROR/);
    console.log(JSON.stringify({ probe: mode, status: "PASS", exitCode: result.code, elapsedMs }));
  }
} finally {
  await rm(probeDir, { recursive: true, force: true });
}
