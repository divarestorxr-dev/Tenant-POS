// Hostinger must inject Google OAuth and WhatsApp credentials as runtime
// environment variables. Never read or recreate disk-based secret bridges.
process.env.NODE_ENV = "production";
process.env.PORT ||= "3000";

const requiredRuntimeSecrets = [
  "GOOGLE_CLIENT_SECRET",
  "FONNTE_API_KEY",
  "FONNTE_TOKEN",
];
console.log("[hostinger-start] runtime credentials available: " +
  requiredRuntimeSecrets.map(key => key + "=" + Boolean(process.env[key]?.trim())).join(", "));

await import("../artifacts/api-server/dist/index.mjs");
