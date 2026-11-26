import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
const pnpmVersion = process.env.PNPM_VERSION || "10.33.0";
const npmUa = process.env.npm_config_user_agent || "";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (npmUa.startsWith("npm/")) {
  run("npx", ["--yes", `pnpm@${pnpmVersion}`, "install", "--frozen-lockfile"]);
  run("npx", ["--yes", `pnpm@${pnpmVersion}`, "run", "build:workspace"]);
} else {
  run("pnpm", ["run", "build:workspace"]);
}

// Co-locate the SPA with the API bundle so Hostinger runtime packaging can serve it
// even if the original admin-portal build directory is omitted from nodejs.
const frontend = path.resolve("artifacts/admin-portal/dist/public");
const bundledFrontend = path.resolve("artifacts/api-server/dist/public");
if (!existsSync(path.join(frontend, "index.html"))) {
  throw new Error("Tenant POS frontend build missing; refusing incomplete release");
}
mkdirSync(bundledFrontend, { recursive: true });
cpSync(frontend, bundledFrontend, { recursive: true, force: true });

// Verify that the release has all startup, backend, and frontend files.
run(process.execPath, ["./scripts/verify-hostinger-release.mjs"]);

// Secrets must be injected into the Node.js runtime environment by the hosting platform.
// Never persist credentials in build outputs, temporary files, or deployable artifacts.
