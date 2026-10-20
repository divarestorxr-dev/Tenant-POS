import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] || process.cwd());
const files = [
  "package.json",
  "scripts/hostinger-start.mjs",
  "artifacts/api-server/dist/index.mjs",
  "artifacts/admin-portal/dist/public/index.html",
];
let invalid = false;
for (const file of files) {
  const absolute = resolve(root, file);
  const exists = existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size > 0;
  console.log(`[hostinger-preflight] ${exists ? "PASS" : "FAIL"} ${file}`);
  if (!exists) invalid = true;
}
if (invalid) {
  console.error("[hostinger-preflight] Release files missing. Refusing to mark build ready.");
  process.exitCode = 1;
}
