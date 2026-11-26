import type { Server } from "node:http";
import app from "./app";
import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { installProcessErrorHandlers } from "./lib/process-errors";
import { startOverdueScheduler } from "./lib/overdue-scheduler";
import { startSheetSyncScheduler } from "./lib/sheet-sync-scheduler";
import { dbConfig, pool } from "@workspace/db";

let httpServer: Server | null = null;
let startupStarted = false;
let shutdownStarted = false;

function validateProductionEnv(): void {
  const isProduction = process.env["NODE_ENV"] === "production";
  if (!isProduction) return;

  const errors: string[] = [];
  const warnings: string[] = [];

  // lib/db/src/config.ts memilih connection string yang cocok dengan SUPABASE_URL,
  // lalu memprioritaskan transaction pooler Supabase (port 6543) bila tersedia.
  // Ini mencegah session-pool exhaustion (EMAXCONNSESSION).
  const supabaseDatabaseUrl = process.env["SUPABASE_DATABASE_URL"];
  const pgUrlProd = process.env["SUPABASE_PG_URL_PROD"];
  const pgUrl = process.env["SUPABASE_PG_URL"];
  const poolerUrl = process.env["SUPABASE_POOLER_URL"];
  const databaseUrl = process.env["DATABASE_URL"];

  if (!supabaseDatabaseUrl && !pgUrlProd && !pgUrl && !poolerUrl && !databaseUrl) {
    errors.push(
      "Tidak ada DB URL production yang tersedia. Hubungkan Supabase melalui Hostinger Database Connect Wizard atau set SUPABASE_DATABASE_URL."
    );
  }

  if (dbConfig.source !== "SUPABASE_POOLER_URL" && poolerUrl) {
    try {
      const parsedPooler = new URL(poolerUrl);
      const nativeTransactionPooler =
        parsedPooler.hostname.includes("pooler.supabase.com") &&
        parsedPooler.port === "6543";
      if (nativeTransactionPooler) {
        warnings.push(
          `Production memakai ${dbConfig.source} walaupun native SUPABASE_POOLER_URL tersedia.`,
        );
      } else {
        warnings.push(
          "SUPABASE_POOLER_URL terdeteksi legacy/malformed dan sengaja tidak diprioritaskan; credential database canonical dipakai lebih dulu.",
        );
      }
    } catch {
      warnings.push(
        "SUPABASE_POOLER_URL tidak valid dan sengaja tidak diprioritaskan; credential database canonical dipakai lebih dulu.",
      );
    }
  }

  logger.info(
    `[startup] Database connection selected: source=${dbConfig.source}, mode=${dbConfig.poolMode}, project=${dbConfig.projectRef ?? "unknown"}, host=${dbConfig.host ?? "unknown"}, port=${dbConfig.port ?? "unknown"}`
  );

  logger.info(
    {
      googleClientIdPresent: Boolean(process.env.GOOGLE_CLIENT_ID?.trim()),
      googleClientSecretPresent: Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim()),
      fonnteApiKeyPresent: Boolean(process.env.FONNTE_API_KEY?.trim()),
      fonnteTokenPresent: Boolean(process.env.FONNTE_TOKEN?.trim()),
      googleCallbackUrl: "https://tenant.travelintrips.co.id/api/auth/google/callback",
    },
    "[startup-auth] Authentication provider configuration",
  );

  // Diagnostic aman: bandingkan credential runtime tanpa pernah mencetak password.
  const inspectDbUrl = (raw: string | undefined) => {
    if (!raw?.trim()) return null;
    try {
      const parsed = new URL(raw.trim());
      const password = decodeURIComponent(parsed.password);
      return {
        username: decodeURIComponent(parsed.username),
        password,
        host: parsed.hostname,
        port: parsed.port || "5432",
        project:
          decodeURIComponent(parsed.username).match(/^[^.]+\.([a-z0-9]+)$/i)?.[1] ??
          parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)?.[1] ??
          null,
      };
    } catch {
      return null;
    }
  };

  const poolerRuntime = inspectDbUrl(poolerUrl);
  const databaseRuntime = inspectDbUrl(supabaseDatabaseUrl);
  const selectedRuntime =
    dbConfig.source === "SUPABASE_POOLER_URL"
      ? poolerRuntime
      : dbConfig.source === "SUPABASE_DATABASE_URL"
        ? databaseRuntime
        : null;
  const placeholderPassword = selectedRuntime
    ? /^(?:password|\[?your[-_ ]?password\]?|<password>)$/i.test(selectedRuntime.password)
    : false;

  logger.info(
    `[startup-db-config] poolerPresent=${Boolean(poolerRuntime)}, databaseUrlPresent=${Boolean(databaseRuntime)}, sameUsername=${Boolean(poolerRuntime && databaseRuntime && poolerRuntime.username === databaseRuntime.username)}, samePassword=${Boolean(poolerRuntime && databaseRuntime && poolerRuntime.password === databaseRuntime.password)}, selectedUser=${selectedRuntime?.username ?? "unknown"}, selectedProject=${selectedRuntime?.project ?? "unknown"}, selectedHost=${selectedRuntime?.host ?? "unknown"}, selectedPort=${selectedRuntime?.port ?? "unknown"}, placeholderPassword=${placeholderPassword}`
  );

  if (dbConfig.poolMode === "session") {
    warnings.push(
      "Koneksi database masih memakai Supabase session pooler. " +
      "Set connection string transaction pooler port 6543 di SUPABASE_POOLER_URL atau SUPABASE_PG_URL " +
      "agar koneksi web tidak kembali mencapai batas EMAXCONNSESSION."
    );
  }

  if (!process.env["SESSION_SECRET"] || process.env["SESSION_SECRET"] === "fallback-dev-secret") {
    errors.push("SESSION_SECRET harus diset ke nilai aman di production.");
  }

  if (process.env["ENABLE_DEV_LOGIN"] === "true") {
    warnings.push(
      "ENABLE_DEV_LOGIN=true aktif di production. " +
      "Dev-login membypass autentikasi normal — hapus atau set ke 'false' kecuali untuk testing sementara yang terkontrol."
    );
  }

  for (const w of warnings) {
    logger.warn(`[startup] ⚠️  ${w}`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      logger.error(`[startup] ❌ ${e}`);
    }
    logger.error(
      "[startup] Server TIDAK dijalankan karena konfigurasi production tidak lengkap. " +
      "Perbaiki environment variables di atas dan coba lagi."
    );
    throw new Error("Production environment validation failed");
  }

  logger.info("[startup] ✅ Validasi environment production berhasil.");
}

export async function runMigrationsAndScheduler(): Promise<void> {
  const shouldRunMigrations =
    process.env["NODE_ENV"] !== "production" ||
    process.env["RUN_DB_MIGRATIONS_ON_STARTUP"] === "true";

  if (shouldRunMigrations) {
    try {
      const { runMigrations, runUsersIdTextMigration } = await import("@workspace/db");
      await runUsersIdTextMigration();
      await runMigrations();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      logger.warn(
        { message, cause: cause instanceof Error ? cause.message : cause },
        "[migrate] Schema sync gagal — server tetap jalan",
      );
    }
  } else {
    logger.info(
      "[migrate] Startup migration production dilewati; set RUN_DB_MIGRATIONS_ON_STARTUP=true hanya saat migration memang perlu dijalankan.",
    );
  }

  try {
    await pool.query("select 1 as ok");
    logger.info("[startup-db] Database probe berhasil; background scheduler boleh dijalankan.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    logger.error(
      { message, cause: cause instanceof Error ? cause.message : cause },
      "[startup-db] Database probe gagal; scheduler dan sheet-sync TIDAK dijalankan agar koneksi login/transaksi mendapat prioritas.",
    );
    return;
  }

  startOverdueScheduler();
  startSheetSyncScheduler();
}

function getListenPort(): number {
  const rawPort = process.env["PORT"] ?? String(config.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return port;
}

function shutdown(reason: string, exitCode = 0): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  process.exitCode = exitCode;

  const server = httpServer;
  if (!server) {
    process.exit(exitCode);
    return;
  }

  logger.info({ reason }, "[shutdown] Menutup HTTP server...");
  const forceExitTimer = setTimeout(() => {
    logger.warn("[shutdown] HTTP server belum tertutup, memutus koneksi dan keluar paksa");
    server.closeAllConnections();
    process.exit(exitCode);
  }, 10_000);
  forceExitTimer.unref();

  server.close((err) => {
    clearTimeout(forceExitTimer);
    httpServer = null;
    if (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "[shutdown] Gagal menutup HTTP server");
    } else {
      logger.info("[shutdown] HTTP server tertutup");
    }
    process.exit(exitCode);
  });
}

export function start(): void {
  if (startupStarted) {
    logger.warn("[startup] Start sudah dipanggil, inisialisasi kedua dilewati");
    return;
  }
  startupStarted = true;

  let port: number;
  try {
    port = getListenPort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message }, "[startup] PORT tidak valid");
    process.exit(1);
    return;
  }

  // Bind listener terlebih dahulu. Jangan menunggu database, migration, atau
  // scheduler sebelum Hostinger menerima health check.
  try {
    httpServer = app.listen(port, "0.0.0.0");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, port }, `[startup] Error listening on port ${port}`);
    process.exit(1);
    return;
  }

  const server = httpServer;
  server.once("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, port }, `[startup] Error listening on port ${port}`);
    httpServer = null;
    process.exit(1);
  });

  server.once("listening", () => {
    logger.info(`Server listening on PORT ${port}`);

    try {
      validateProductionEnv();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "[startup] Validasi environment gagal");
      shutdown("startup validation failed", 1);
      return;
    }

    // Semua pekerjaan startup yang berpotensi menunggu dilakukan setelah
    // listener siap menerima request.
    void runMigrationsAndScheduler().catch((err) => {
      logger.error({ err }, "Migration/scheduler error");
    });
  });
}

installProcessErrorHandlers();

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

if (process.env["NODE_ENV"] !== "test") {
  start();
}
