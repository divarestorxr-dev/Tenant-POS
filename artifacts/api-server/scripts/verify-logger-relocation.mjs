import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createApiBuildOptions } from "../build.mjs";

// Exercise the production bundler and the real logger without importing the DB.
// Moving dist reproduces the release layout change that previously broke Pino's
// absolute worker paths. The temporary runtime uses the installed dependencies.
const execFileAsync = promisify(execFile);
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loggerPath = path.join(apiDir, "src/lib/logger.ts");
const probeDir = await mkdtemp(path.join(os.tmpdir(), "tenant-logger-relocation-"));

try {
  const entryPoint = path.join(probeDir, "probe.ts");
  const originalDist = path.join(probeDir, "build-host-dist");
  const runtimeDist = path.join(probeDir, "runtime-dist");
  await writeFile(entryPoint, `
import pino from "pino";
import { writeSync } from "node:fs";

Object.defineProperty(process.stdout, "isTTY", {
  configurable: true,
  value: process.env.LOGGER_PROBE_TTY === "true",
});
let uncaughtErrors = 0;
process.on("uncaughtException", (error) => {
  uncaughtErrors += 1;
  if (uncaughtErrors <= 3) writeSync(2, String(error) + "\\n");
});
const { logger } = await import(${JSON.stringify(loggerPath)});
logger.info("LOGGER_RELOCATION_PROBE");
const transportWorker = Boolean(logger[pino.symbols.streamSym]?.worker);
await new Promise((resolve) => setTimeout(resolve, 350));
const cpuStart = process.cpuUsage();
const timeStart = process.hrtime.bigint();
await new Promise((resolve) => setTimeout(resolve, 1500));
const elapsedMs = Number(process.hrtime.bigint() - timeStart) / 1e6;
const cpu = process.cpuUsage(cpuStart);
const cpuPercent = (cpu.user + cpu.system) / 1000 / elapsedMs * 100;
writeSync(1, "LOGGER_PROBE_RESULT " + JSON.stringify({
  uncaughtErrors, transportWorker, elapsedMs, cpuPercent,
}) + "\\n");
process.exit(uncaughtErrors === 0 ? 0 : 1);
`);

  const options = createApiBuildOptions({ entryPoint, distDir: originalDist });
  options.logLevel = "warning";
  options.plugins = [
    ...(options.plugins ?? []),
    {
      name: "logger-config-without-db",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/config$/ }, (args) =>
          args.importer === loggerPath
            ? { path: "logger-probe-config", namespace: "logger-probe" }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "logger-probe" }, () => ({
          contents: 'export const config = { env: process.env.NODE_ENV, logLevel: "info" };',
          loader: "js",
        }));
      },
    },
  ];
  await build(options);
  await rename(originalDist, runtimeDist);
  await symlink(path.join(apiDir, "node_modules"), path.join(runtimeDist, "node_modules"), "junction");

  const bundlePath = path.join(runtimeDist, "probe.mjs");
  const bundle = await readFile(bundlePath, "utf8");
  assert.ok(!bundle.includes(originalDist), "runtime bundle retains an absolute build-host path");
  assert.ok(!bundle.includes("__bundlerPathsOverrides"), "runtime bundle retains bundled Pino worker overrides");

  for (const probe of [
    { name: "headless-development", env: "development", tty: false },
    { name: "headless-production", env: "production", tty: false },
    { name: "terminal-development", env: "development", tty: true },
  ]) {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath], {
      cwd: runtimeDist,
      env: {
        ...process.env,
        NODE_ENV: probe.env,
        LOGGER_PROBE_TTY: String(probe.tty),
      },
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    });
    const resultLine = stdout.split("\n").find((line) => line.startsWith("LOGGER_PROBE_RESULT "));
    assert.ok(resultLine, `${probe.name}: no completed logger probe; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    const result = JSON.parse(resultLine.slice("LOGGER_PROBE_RESULT ".length));
    assert.match(stdout, /LOGGER_RELOCATION_PROBE/, `${probe.name}: logger output is missing`);
    assert.equal(stderr, "", `${probe.name}: unexpected stderr`);
    assert.equal(result.uncaughtErrors, 0, `${probe.name}: logger raised an uncaught error`);
    assert.equal(result.transportWorker, probe.tty, `${probe.name}: unexpected transport worker`);
    assert.ok(result.cpuPercent < 30, `${probe.name}: idle CPU is ${result.cpuPercent.toFixed(2)}% of one core`);
    console.log(JSON.stringify({ probe: probe.name, status: "PASS", ...result }));
  }
} finally {
  await rm(probeDir, { recursive: true, force: true });
}
