import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { dbConfig, pool } from "@workspace/db";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import crypto from "crypto";
import passport from "./lib/auth";
import router from "./routes";
import { logger } from "./lib/logger";
import { getBackgroundWorkMode } from "./lib/background-work-policy";
import { getAdminWaGroupStatus } from "./lib/whatsapp";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ─── Security headers (Helmet) ─────────────────────────────────────────────
// CSP dinonaktifkan di sini karena frontend (admin-portal) berjalan di domain/
// port berbeda dan mengelola CSP-nya sendiri via Vite. Aktifkan CSP di sini
// hanya jika API dan frontend digabung dalam satu origin.
//
// crossOriginEmbedderPolicy: false agar static uploads (gambar/PDF) tetap bisa
// di-load cross-origin oleh frontend tanpa butuh header COEP dari subresource.
//
// crossOriginResourcePolicy: cross-origin agar logo/dokumen bisa di-fetch dari
// frontend yang berjalan di port/domain berbeda (development maupun production).
//
// frameguard sameorigin: API tidak perlu di-embed iframe, tapi sameorigin lebih
// aman daripada deny untuk kasus reverse-proxy single-domain.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Google Identity Services popup membutuhkan opener tetap tersedia.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    frameguard: { action: "sameorigin" },
  }),
);

const isProduction = process.env.NODE_ENV === "production";

// ─── CORS ──────────────────────────────────────────────────────────────────
// Development  : semua origin diizinkan (origin: true) agar Vite proxy dan
//               tool lokal bisa bekerja tanpa konfigurasi tambahan.
//
// Production   : hanya origin yang ada di ALLOWED_ORIGINS (comma-separated)
//               yang boleh mengirim request dengan credentials. Request
//               same-origin (tanpa header Origin) selalu diizinkan.
//               Jika ALLOWED_ORIGINS tidak diset, semua request cross-origin
//               dengan credentials ditolak — sesuai dengan arsitektur
//               Replit deployment di mana frontend dan API berada di domain
//               yang sama (same-origin via reverse-proxy).
//
// CATATAN: Webhook Fonnte (/api/whatsapp-webhook/*) tidak butuh credentials
//          sehingga penolakan CORS di sini tidak menghalangi webhook.
const configuredOrigins = process.env.ALLOWED_ORIGINS ?? process.env.APP_URL ?? "";
const allowedOrigins: string[] = configuredOrigins
  ? configuredOrigins.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin: isProduction
      ? (origin, callback) => {
          if (!origin) return callback(null, true);
          if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          logger.warn({ origin }, "[cors] Cross-origin request ditolak di production");
          return callback(null, false);
        }
      : true,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── SESSION_SECRET ────────────────────────────────────────────────────────
// Di production, SESSION_SECRET wajib diset di environment/secrets production.
// Di development, auto-generate secret acak jika tidak diset agar server
// tidak pernah gagal start hanya karena secret belum dikonfigurasi.
// CATATAN: auto-generated secret bersifat ephemeral — sesi akan invalid
// setiap kali server restart. Tambahkan SESSION_SECRET ke Secrets untuk
// sesi yang persisten.
let sessionSecret = process.env.SESSION_SECRET ?? "";

if (!sessionSecret) {
  if (isProduction) {
    // Di production, SESSION_SECRET WAJIB diset. Fail-fast agar tidak ada
    // sesi tidak aman yang lolos ke production.
    throw new Error("SESSION_SECRET wajib diset di production. Tambahkan ke environment/secrets hosting.");
  } else {
    logger.info("SESSION_SECRET tidak diset — menggunakan secret acak untuk development. Tambahkan SESSION_SECRET ke Secrets untuk sesi yang persisten.");
    sessionSecret = crypto.randomBytes(32).toString("hex");
  }
}

// ─── PostgreSQL Session Store ──────────────────────────────────────────────
// Sesi disimpan ke PostgreSQL agar tidak hilang saat server restart.
// Tabel `session` harus sudah ada di DB (dibuat oleh migration 0069).
const PgSession = connectPgSimple(session);

// Gunakan pool database aplikasi yang sama untuk session store. Membuka pool kedua
// per instance membuat rolling deployment menghabiskan slot session-pooler Supabase.
const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "session",
    schemaName: "public",
    createTableIfMissing: false,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use((req, res, next) => {
  sessionMiddleware(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }

    // Jika session-store PostgreSQL sedang tidak tersedia, jangan ubah request
    // frontend biasa menjadi JSON 500. Biarkan shell SPA/static tetap terbuka
    // dan hapus cookie lama supaya browser tidak terus mencoba memuat session
    // yang gagal. Route API tetap fail-closed melalui global error handler.
    const isFrontendNavigation =
      req.method === "GET" &&
      !req.path.startsWith("/api") &&
      !req.path.startsWith("/emergency");

    if (isFrontendNavigation) {
      logger.warn(
        { err, path: req.path },
        "[session] Store gagal saat navigasi frontend; lanjut sebagai anonymous",
      );
      res.clearCookie("connect.sid", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "strict" : "lax",
      });
      next();
      return;
    }

    next(err);
  });
});

app.use(passport.initialize());
app.use(passport.session());

app.get("/api/healthz", (_req, res) => {
  const deploySha = process.env.DEPLOY_COMMIT_SHA?.trim();
  if (deploySha && /^[a-f0-9]{40}$/i.test(deploySha)) res.setHeader("x-cst-commit-sha", deploySha);
  const adminWaGroup = getAdminWaGroupStatus();
  res.json({
    ok: true,
    release: process.env.REPLIT_DEPLOYMENT_ID ?? process.env.REPL_ID ?? "unknown",
    paymentProofRevision: "proof-stream-v3",
    backgroundWork: { mode: getBackgroundWorkMode() },
    database: {
      source: dbConfig.source,
      poolMode: dbConfig.poolMode,
      projectRef: dbConfig.projectRef,
      host: dbConfig.host,
      port: dbConfig.port,
      sharedSessionPool: true,
    },
    notifications: {
      fonnteConfigured: Boolean(
        process.env.FONNTE_API_KEY?.trim() || process.env.FONNTE_TOKEN?.trim(),
      ),
      adminWaGroupConfigured: adminWaGroup.configured,
      adminWaGroupValid: adminWaGroup.valid,
    },
  });
});

app.get("/api/healthz/db", async (_req, res) => {
  try {
    await pool.query("select 1 as ok");
    res.json({
      ok: true,
      source: dbConfig.source,
      poolMode: dbConfig.poolMode,
      projectRef: dbConfig.projectRef,
      host: dbConfig.host,
      port: dbConfig.port,
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ code, message }, "[healthz/db] Database tidak terjangkau");
    res.status(503).json({
      ok: false,
      code: code || "DB_UNREACHABLE",
      source: dbConfig.source,
      poolMode: dbConfig.poolMode,
      projectRef: dbConfig.projectRef,
      host: dbConfig.host,
      port: dbConfig.port,
    });
  }
});

app.use("/api", router);

app.get("/emergency", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tenant POS — Emergency Read Only</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f6f7f9;color:#1f2937}
    main{max-width:1200px;margin:32px auto;padding:0 18px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;margin-bottom:18px}
    h1{margin:0 0 6px;font-size:24px} h2{font-size:18px;margin:0 0 12px}
    .muted{color:#6b7280}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    input{padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;min-width:280px}
    button{padding:11px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}.error{color:#b91c1c}.ok{color:#047857}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left;white-space:nowrap}
    .scroll{overflow:auto}.hidden{display:none}
  </style>
</head>
<body>
<main>
  <div class="card">
    <h1>Tenant POS — Emergency Read Only</h1>
    <div class="muted">Akses darurat hanya baca. Jalur ini tidak memakai koneksi PostgreSQL TCP utama.</div>
  </div>
  <div class="card" id="loginCard">
    <div class="row">
      <input id="password" type="password" autocomplete="current-password" placeholder="Password Dev / Emergency" />
      <button id="load">Buka Monitoring</button>
    </div>
    <div id="status" class="muted" style="margin-top:10px"></div>
  </div>
  <div id="content" class="hidden">
    <div class="card"><div id="generated" class="muted"></div></div>
    <div class="card"><h2>Pembayaran terbaru</h2><div class="scroll"><table id="payments"></table></div></div>
    <div class="card"><h2>Invoice terbaru</h2><div class="scroll"><table id="invoices"></table></div></div>
    <div class="card"><h2>Booking tenant terbaru</h2><div class="scroll"><table id="bookings"></table></div></div>
  </div>
</main>
<script>
(() => {
  const password = document.getElementById('password');
  const button = document.getElementById('load');
  const status = document.getElementById('status');
  const content = document.getElementById('content');
  let activePassword = '';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const table = (el, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = '<tr><td class="muted">Tidak ada data.</td></tr>';
      return;
    }
    const keys = Object.keys(rows[0]);
    el.innerHTML = '<thead><tr>' + keys.map(k => '<th>' + esc(k) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + rows.map(r => '<tr>' + keys.map(k => '<td>' + esc(r[k]) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  };

  async function load() {
    if (!activePassword) activePassword = password.value;
    if (!activePassword) return;
    button.disabled = true;
    status.textContent = 'Mengambil data langsung dari Supabase...';
    status.className = 'muted';
    try {
      const res = await fetch('/api/emergency/overview', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({password: activePassword}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      document.getElementById('generated').textContent =
        'Terakhir diperbarui: ' + new Date(data.generatedAt).toLocaleString('id-ID') + ' · mode: ' + data.mode;
      table(document.getElementById('payments'), data.payments);
      table(document.getElementById('invoices'), data.invoices);
      table(document.getElementById('bookings'), data.bookings);
      content.classList.remove('hidden');
      status.textContent = 'Terhubung.';
      status.className = 'ok';
    } catch (e) {
      content.classList.add('hidden');
      status.textContent = e && e.message ? e.message : String(e);
      status.className = 'error';
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', () => { activePassword = password.value; void load(); });
  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') { activePassword = password.value; void load(); } });
  setInterval(() => { if (activePassword && !content.classList.contains('hidden')) void load(); }, 30000);
})();
</script>
</body>
</html>`);
});

// ─── Serve admin portal static files ─────────────────────────────────────
// Di development, Vite proxy menangani routing antar API dan frontend.
// Di production (termasuk NODE_ENV=development di container Replit), Express
// serve file statis dari build admin portal jika folder dist ada,
// dengan fallback ke index.html untuk semua route non-API (SPA behavior).
// Ini yang memungkinkan /bayar/:token dan halaman lain bisa diakses langsung.
const frontendCandidates = [
  path.join(process.cwd(), "artifacts/admin-portal/dist/public"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin-portal/dist/public"),
];
const frontendDist = frontendCandidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
const frontendIndex = frontendDist ? path.join(frontendDist, "index.html") : "";
if (frontendDist) {
  logger.info({ frontendDist }, "[app] Serving admin portal static files");
  app.use(express.static(frontendDist, {
    maxAge: "1h",
    etag: true,
    setHeaders: (res, filePath) => {
      // Vite memberi content hash untuk bundle di /assets; file ini aman
      // disimpan lama karena nama berubah setiap build.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return;
      }

      // index.html dapat dilayani langsung oleh express.static untuk request "/".
      // Paksa no-store agar browser/CDN tidak menahan shell lama setelah deploy.
      if (filePath === frontendIndex || filePath.endsWith(`${path.sep}index.html`)) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }));
  // SPA shell untuk route seperti /tenant-invoices juga wajib selalu fresh,
  // sementara chunk hashed tetap immutable.
  app.use((_req, res) => {
    // Missing uploaded files must be 404, not the SPA HTML shell (200).
    if (_req.path === "/uploads" || _req.path.startsWith("/uploads/")) {
      res.status(404).send("Not Found");
      return;
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(frontendIndex);
  });
} else {
  // Frontend absent: expose an actual outage instead of a misleading HTTP 200.
  logger.error({ frontendCandidates }, "[app] Frontend build not found; web routes unavailable");
  app.use((_req, res, next) => {
    if (_req.path === "/" && _req.method === "GET") {
      res.status(503).json({ status: "unavailable", error: "frontend_build_missing" });
    } else {
      next();
    }
  });
}

// ─── Global error handler ──────────────────────────────────────────────────
// Tangani error yang tidak ter-catch di route handlers. Di production, hanya
// pesan generik yang dikembalikan ke client — stack trace TIDAK bocor.
// Di development, detail error dan stack trace ditampilkan untuk memudahkan
// debugging.
//
// Middleware error Express WAJIB 4 parameter (err, req, res, next).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "[app] Unhandled error");

  if (res.headersSent) return;

  if (isProduction) {
    res.status(500).json({ error: "Terjadi kesalahan internal server. Silakan coba lagi." });
  } else {
    res.status(500).json({
      error: err.message ?? "Internal server error",
      stack: err.stack,
    });
  }
});

export default app;
