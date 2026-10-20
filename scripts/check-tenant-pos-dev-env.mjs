// Non-destructive DEV configuration preflight. Prints presence flags only.
const prodRef = "nzdweipzckfszczzqtuw";
const devRef = "xssrfshdrtdfupgqwfdw";
const keys = ["SUPABASE_PG_URL_DEV", "SUPABASE_DATABASE_URL_DEV", "SUPABASE_URL_DEV", "SUPABASE_SERVICE_ROLE_KEY_DEV", "SESSION_SECRET", "DEV_PUBLIC_HEALTH_URL"];
const errors = [];
for (const key of keys) {
  const value = process.env[key]?.trim() ?? "";
  if (!value) errors.push(key + " is missing");
  if (value.includes(prodRef)) errors.push(key + " refers to Production");
}
for (const key of ["SUPABASE_PG_URL_DEV", "SUPABASE_DATABASE_URL_DEV", "SUPABASE_URL_DEV"]) {
  const value = process.env[key] ?? "";
  if (value && !value.includes(devRef)) errors.push(key + " does not reference approved CST-DEV project");
}
if (process.env.ENABLE_DEV_LOGIN === "true") errors.push("ENABLE_DEV_LOGIN must not be enabled for shared staging");
if (process.env.SUPABASE_PG_URL_DEV && process.env.SUPABASE_DATABASE_URL_DEV && process.env.SUPABASE_PG_URL_DEV !== process.env.SUPABASE_DATABASE_URL_DEV) {
  errors.push("DEV database URLs differ; review explicitly before proceeding");
}
console.log("Tenant-POS DEV preflight: " + (errors.length ? "BLOCKED" : "CONFIGURATION_CHECK_PASS"));
for (const error of errors) console.error(" - " + error);
console.log("NOTE: PASS validates environment values only, NOT DB isolation, E2E, or readiness for promotion.");
if (errors.length) process.exitCode = 1;
