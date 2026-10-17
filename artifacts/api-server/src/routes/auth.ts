import { Router, type IRouter } from "express";
import passport, { ensureGoogleStrategy, getGoogleAuthStatus, verifyGoogleIdToken } from "../lib/auth";
import { db, dbConfig } from "@workspace/db";
import { usersTable, USER_ROLES, USER_STATUSES, type UserRole, tenantUserAccessTable, mallSitesTable, tenantsTable } from "@workspace/db/schema";
import { eq, asc, and, ne, or } from "drizzle-orm";
import { findOrCreateUser, buildSessionUser, getTenantAccess } from "../lib/auth";
import { requireAnyRole, requireAuth, invalidateUserStatusCache } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { withDbRetry } from "../lib/db-retry";
import { devLoginRateLimiter, googleAuthRateLimiter, authMeRateLimiter } from "../middlewares/rate-limit";
import { normalizePhoneNumber } from "../services/otp-service";
import { randomUUID } from "node:crypto";
import { isDevLoginEnabled } from "../lib/dev-login-policy";

const router: IRouter = Router();

function errorChain(err: unknown): Array<{
  name?: string;
  message?: string;
  code?: string;
  severity?: string;
  detail?: string;
}> {
  const chain: Array<{
    name?: string;
    message?: string;
    code?: string;
    severity?: string;
    detail?: string;
  }> = [];

  let current: any = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    chain.push({
      name: typeof current.name === "string" ? current.name : undefined,
      message: typeof current.message === "string" ? current.message : String(current),
      code: typeof current.code === "string" ? current.code : undefined,
      severity: typeof current.severity === "string" ? current.severity : undefined,
      detail: typeof current.detail === "string" ? current.detail : undefined,
    });
    current = current.cause;
  }

  return chain;
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DEV_LOGIN_ENABLED = isDevLoginEnabled();

const DEV_PHONE_NUMBERS = [
 "6282299997227",
 "6287808785098"
]

const DEV_ROLE_NAMES: Record<string, string> = {
  owner: "Dev Owner",
  admin: "Dev Admin",
  finance: "Dev Finance",
  cashier: "Dev Kasir",
  tenant_user: "Dev Tenant User",
};

if (DEV_LOGIN_ENABLED) {
  router.post("/auth/dev-login", devLoginRateLimiter, async (req, res) => {
    const devLoginSecret = process.env.DEV_LOGIN_SECRET?.trim();

    if (IS_PRODUCTION && !devLoginSecret) {
      logger.error("[dev-login] DEV_LOGIN_SECRET belum dikonfigurasi di production");
      res.status(503).json({ error: "Login password belum dikonfigurasi di server" });
      return;
    }

    if (devLoginSecret) {
      const provided = (req.body as any).devSecret as string | undefined;

      if (!provided || provided !== devLoginSecret) {
        res.status(401).json({ error: "Password dev tidak valid" });
        return;
      }
    }

    const { role } = req.body as { role?: string };

    const effectiveRole: UserRole =
      USER_ROLES.includes(role as UserRole)
        ? role as UserRole
        : "admin";

    const phoneNumbers = DEV_PHONE_NUMBERS.map(normalizePhoneNumber);

    const requestedPhoneNumber =
  normalizePhoneNumber(
    (req.body as any).phoneNumber || phoneNumbers[0]
  );

    logger.info(
    { role: effectiveRole, phoneNumber: requestedPhoneNumber },
    "[dev-login] dipanggil"
    );

    try {
      const devEmail = `${requestedPhoneNumber}@dev.local`;

      // Cari berdasarkan nomor ATAU email dev. Database lama/test dapat memiliki
      // akun dev dengan email yang sama tetapi phone_number masih null. Jika hanya
      // mencari nomor, INSERT berikutnya akan menabrak users_email_unique.
      let [dbUser] = await withDbRetry(
        () =>
          db
            .select()
            .from(usersTable)
            .where(
              or(
                eq(usersTable.phoneNumber, requestedPhoneNumber),
                eq(usersTable.email, devEmail),
              ),
            ),
        { label: "dev-login.lookup-user" },
      );

if (!dbUser) {
  const [created] = await withDbRetry(
    () => db
    .insert(usersTable)
    .values({
      id: randomUUID(),
      email: devEmail,
      name: DEV_ROLE_NAMES[effectiveRole] ?? "Dev User",
      avatarUrl: null,
      phoneNumber: requestedPhoneNumber,
      role: effectiveRole,
      status: "active",
    })
    // Dua request dev-login dapat lolos SELECT awal secara bersamaan.
    // Upsert pada email membuat pembuatan user idempotent dan mencegah 500
    // users_email_unique saat startup/test/rolling deployment paralel.
    .onConflictDoUpdate({
      target: usersTable.email,
      set: {
        role: effectiveRole,
        phoneNumber: requestedPhoneNumber,
        status: "active",
        updatedAt: new Date(),
      },
    })
    .returning({
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  avatarUrl: usersTable.avatarUrl,
  role: usersTable.role,
  phoneNumber: usersTable.phoneNumber,
  phoneVerifiedAt: usersTable.phoneVerifiedAt,
  status: usersTable.status,
  lastLoginAt: usersTable.lastLoginAt,
  forceLogoutAt: usersTable.forceLogoutAt,
  createdAt: usersTable.createdAt,
  updatedAt: usersTable.updatedAt,
}),
    { label: "dev-login.upsert-user" },
  );

  dbUser = created;
} else {
  const [updated] = await withDbRetry(
    () => db
    .update(usersTable)
    .set({
      role: effectiveRole,
      phoneNumber: requestedPhoneNumber,
      email: dbUser.email ?? devEmail,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, dbUser.id))
    .returning({
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  avatarUrl: usersTable.avatarUrl,
  role: usersTable.role,
  phoneNumber: usersTable.phoneNumber,
  phoneVerifiedAt: usersTable.phoneVerifiedAt,
  status: usersTable.status,
  lastLoginAt: usersTable.lastLoginAt,
  forceLogoutAt: usersTable.forceLogoutAt,
  createdAt: usersTable.createdAt,
  updatedAt: usersTable.updatedAt,
}),
    { label: "dev-login.update-user" },
  );

  dbUser = updated;
}
      const sessionUser = await buildSessionUser({
        ...dbUser,
        phoneNumber: requestedPhoneNumber,
      });

      req.login(sessionUser, (err) => {
        if (err) {
          logger.error({ err }, "[dev-login] req.login gagal");
          res.status(500).json({
            error: "Login gagal",
          });
          return;
        }

        logger.info(
          {
            role: sessionUser.role,
            phoneNumber: requestedPhoneNumber,
          },
          "[dev-login] berhasil"
        );

        res.json(sessionUser);
      });

    } catch (err) {
      logger.error(
        {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          errorChain: errorChain(err),
          dbSource: dbConfig.source,
          dbPoolMode: dbConfig.poolMode,
          dbProjectRef: dbConfig.projectRef,
        },
        "[dev-login] Error membuat user",
      );

      res.status(500).json({
        error: "Gagal membuat sesi dev login",
      });
    }
  });
}

router.get("/auth/dev-login-enabled", (_req, res) => {
  res.json({ enabled: DEV_LOGIN_ENABLED });
});

router.get("/auth/providers", (_req, res) => {
  const google = getGoogleAuthStatus();
  const whatsappEnabled = Boolean(
    (process.env.FONNTE_API_KEY ?? process.env.FONNTE_TOKEN)?.trim(),
  );

  res.setHeader("Cache-Control", "no-store");
  res.json({
    google: {
      enabled: google.enabled,
      clientIdPresent: google.clientIdPresent,
      clientSecretPresent: google.clientSecretPresent,
      callbackUrl: google.callbackURL,
      configSource: google.source,
      clientId: google.clientID ?? null,
    },
    whatsapp: {
      enabled: whatsappEnabled,
      apiKeyPresent: Boolean(process.env.FONNTE_API_KEY?.trim()),
      tokenPresent: Boolean(process.env.FONNTE_TOKEN?.trim()),
    },
  });
});

router.get("/auth/google-enabled", (_req, res) => {
  const google = getGoogleAuthStatus();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    enabled: google.enabled,
    clientIdPresent: google.clientIdPresent,
    clientSecretPresent: google.clientSecretPresent,
    callbackUrl: google.callbackURL,
    configSource: google.source,
    clientId: google.clientID ?? null,
    gisEnabled: google.clientIdPresent,
  });
});

router.get("/auth/google", googleAuthRateLimiter, (req, res, next) => {
  const google = ensureGoogleStrategy();
  if (!google.enabled) {
    const missing =
      !google.clientIdPresent && !google.clientSecretPresent
        ? "client_id_and_secret"
        : !google.clientIdPresent
          ? "client_id"
          : "client_secret";

    logger.error(
      {
        clientIdPresent: google.clientIdPresent,
        clientSecretPresent: google.clientSecretPresent,
        callbackUrl: google.callbackURL,
        configSource: google.source,
      },
      "[google-auth] konfigurasi runtime belum lengkap",
    );

    res.redirect(`/login?error=google_not_configured&missing=${missing}`);
    return;
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
    prompt: "select_account",
  })(req, res, next);
});

router.post("/auth/google/id-token", googleAuthRateLimiter, async (req, res) => {
  const credential =
    typeof req.body?.credential === "string" ? req.body.credential.trim() : "";

  if (!credential) {
    res.status(400).json({ error: "Google credential tidak tersedia" });
    return;
  }

  try {
    const claims = await verifyGoogleIdToken(credential);
    const email = claims.email ?? "";
    const dbUser = await findOrCreateUser({
      email,
      name: claims.name?.trim() || email.split("@")[0] || "Pengguna Google",
      avatar: claims.picture ?? null,
    });
    const sessionUser = await buildSessionUser(dbUser, claims.sub);

    req.login(sessionUser, (err) => {
      if (err) {
        logger.error(
          { message: err instanceof Error ? err.message : String(err) },
          "[google-gis] req.login gagal",
        );
        res.status(500).json({ error: "Gagal membuat sesi Google" });
        return;
      }

      logAudit(req, {
        action: "google_login_success",
        entityType: "user",
        entityId: dbUser.id,
        afterData: { email: sessionUser.email, role: sessionUser.role },
      });

      logger.info(
        { email: sessionUser.email, role: sessionUser.role },
        "[google-gis] login berhasil",
      );
      res.json(sessionUser);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { message, errorChain: errorChain(err) },
      "[google-gis] verifikasi ID token gagal",
    );

    const status =
      message === "GOOGLE_EMAIL_NOT_ALLOWED" ? 403 :
      message.startsWith("GOOGLE_ID_TOKEN_") ? 401 :
      message === "GOOGLE_CLIENT_ID_MISSING" ? 503 :
      500;

    logAudit(req, {
      action: "google_login_failed",
      entityType: "user",
      afterData: { reason: message, status },
    });

    res.status(status).json({
      error:
        status === 403
          ? "Akun Google ini tidak diizinkan"
          : status === 401
            ? "Token Google tidak valid"
            : "Google Login gagal. Silakan coba lagi.",
      code: message,
    });
  }
});

router.get(
  "/auth/google/callback",
  googleAuthRateLimiter,
  (req, res, next) => {
    const google = ensureGoogleStrategy();
    if (!google.enabled) {
      res.redirect("/login?error=google_not_configured");
      return;
    }

    passport.authenticate(
      "google",
      (err: unknown, user: Express.User | false | null, info: unknown) => {
        if (err) {
          logger.error(
            {
              message: err instanceof Error ? err.message : String(err),
              errorChain: errorChain(err),
              info,
            },
            "[google-oauth] callback gagal",
          );
          res.redirect("/login?error=google_callback_failed");
          return;
        }

        if (!user) {
          logger.warn({ info }, "[google-oauth] callback tanpa user");
          res.redirect("/login?error=google_auth_failed");
          return;
        }

        req.logIn(user, (loginErr) => {
          if (loginErr) {
            logger.error(
              {
                message: loginErr instanceof Error ? loginErr.message : String(loginErr),
              },
              "[google-oauth] req.login gagal",
            );
            res.redirect("/login?error=google_session_failed");
            return;
          }
          res.redirect("/");
        });
      },
    )(req, res, next);
  },
);

router.get("/auth/me", authMeRateLimiter, async (req, res) => {
  logger.info({ isAuthenticated: req.isAuthenticated(), hasUser: !!req.user }, "[auth/me] dipanggil");
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Tidak terautentikasi" });
    return;
  }
  const user = req.user;

  let tenantAccess = user.tenantAccess;
  if (user.role === "tenant_user" && !tenantAccess) {
    tenantAccess = await getTenantAccess(user.dbId);
  }

  // Bootstrap site metadata in the auth response so the frontend does not
  // perform auth -> sites -> page-data as three sequential network round trips.
  const activeSites = await db
    .select({
      id: mallSitesTable.id,
      code: mallSitesTable.code,
      name: mallSitesTable.name,
      type: mallSitesTable.type,
      status: mallSitesTable.status,
      companyName: mallSitesTable.companyName,
    })
    .from(mallSitesTable)
    .where(eq(mallSitesTable.status, "active"));

  const allowedSiteIds = new Set(user.allowedSites ?? []);
  const bootstrapSites =
    user.role === "owner" || user.role === "admin"
      ? activeSites
      : allowedSiteIds.size > 0
        ? activeSites.filter((site) => allowedSiteIds.has(site.id))
        : activeSites.filter((site) => site.code === "TOD_M1_BANDARA").slice(0, 1);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    id: user.id,
    dbId: user.dbId,
    email: user.email ?? null,
    name: user.name,
    phoneNumber: user.phoneNumber ?? null,
    avatar: user.avatar,
    role: user.role,
    allowedSites: user.allowedSites ?? [],
    sites: bootstrapSites,
    ...(user.role === "tenant_user" ? { tenantAccess: tenantAccess ?? [] } : {}),
  });
});

router.post("/auth/logout", (req, res) => {
  req.logout(() => {
    res.json({ ok: true });
  });
});

// ─── GET /api/users — daftar semua user ──────────────────────────────────────

router.get("/users", requireAuth, requireAnyRole("owner", "admin"), async (_req, res) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        phoneNumber: usersTable.phoneNumber,
        status: usersTable.status,
        avatarUrl: usersTable.avatarUrl,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
        lastLoginAt: usersTable.lastLoginAt,
      })
      .from(usersTable)
      .orderBy(asc(usersTable.createdAt));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil daftar user" });
  }
});

// ─── POST /api/users — buat user baru ────────────────────────────────────────

router.post("/users", requireAuth, requireAnyRole("owner"), async (req, res) => {
  const { name, email, role, phoneNumber, status } = req.body as {
    name?: string;
    email?: string;
    role?: string;
    phoneNumber?: string;
    status?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "Nama wajib diisi" });
    return;
  }
  if (!role || !USER_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: `Peran tidak valid. Pilihan: ${USER_ROLES.join(", ")}` });
    return;
  }
  if (status && !USER_STATUSES.includes(status as any)) {
    res.status(400).json({ error: `Status tidak valid. Pilihan: ${USER_STATUSES.join(", ")}` });
    return;
  }

  try {
    if (email) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.trim()));
      if (existing) {
        res.status(409).json({ error: "Email sudah terdaftar" });
        return;
      }
    }

    const [created] = await db
      .insert(usersTable)
      .values({
        id: randomUUID(),
        name: name.trim(),
        email: email?.trim() || null,
        role: role as UserRole,
        phoneNumber: phoneNumber?.trim() || null,
        status: (status ?? "active") as any,
      })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        phoneNumber: usersTable.phoneNumber,
        status: usersTable.status,
        avatarUrl: usersTable.avatarUrl,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      });

    logAudit(req, {
      action: "create_user",
      entityType: "user",
      entityId: created.id,
      afterData: { name: created.name, email: created.email, role: created.role, status: created.status },
    });

    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: "Gagal membuat user" });
  }
});

// ─── PUT /api/users/:id — update user ────────────────────────────────────────

router.put("/users/:id", requireAuth, requireAnyRole("owner"), async (req, res) => {
  const id = String(req.params.id);
  const { name, email, role, phoneNumber, status } = req.body as {
    name?: string;
    email?: string;
    role?: string;
    phoneNumber?: string;
    status?: string;
  };

  if (name !== undefined && !name.trim()) {
    res.status(400).json({ error: "Nama tidak boleh kosong" });
    return;
  }
  if (role && !USER_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: `Peran tidak valid. Pilihan: ${USER_ROLES.join(", ")}` });
    return;
  }
  if (status && !USER_STATUSES.includes(status as any)) {
    res.status(400).json({ error: `Status tidak valid` });
    return;
  }

  try {
    const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!before) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    if (email && email !== before.email) {
      const [dup] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.email, email.trim()), ne(usersTable.id, id)));
      if (dup) {
        res.status(409).json({ error: "Email sudah digunakan user lain" });
        return;
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) patch.name = name.trim();
    if (email !== undefined) patch.email = email.trim() || null;
    if (role !== undefined) patch.role = role;
    if (phoneNumber !== undefined) patch.phoneNumber = phoneNumber.trim() || null;
    if (status !== undefined) patch.status = status;

    const [updated] = await db
      .update(usersTable)
      .set(patch as any)
      .where(eq(usersTable.id, id))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        phoneNumber: usersTable.phoneNumber,
        status: usersTable.status,
        avatarUrl: usersTable.avatarUrl,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      });

    invalidateUserStatusCache(id);

    logAudit(req, {
      action: "update_user",
      entityType: "user",
      entityId: id,
      beforeData: { name: before.name, email: before.email, role: before.role, status: before.status },
      afterData: { name: updated.name, email: updated.email, role: updated.role, status: updated.status },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Gagal memperbarui user" });
  }
});

// ─── PATCH /api/users/:id/role — ubah peran (backward compat) ────────────────

router.patch("/users/:id/role", requireAuth, requireAnyRole("owner"), async (req, res) => {
  const id = String(req.params.id);
  if (!id) {
    res.status(400).json({ error: "ID tidak valid" });
    return;
  }

  const { role } = req.body as { role?: string };
  if (!role || !USER_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: `Peran tidak valid. Pilihan: ${USER_ROLES.join(", ")}` });
    return;
  }

  try {
    const [before] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, id));

    if (!before) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role: role as UserRole, updatedAt: new Date() })
      .where(eq(usersTable.id, id))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        updatedAt: usersTable.updatedAt,
      });

    invalidateUserStatusCache(id);

    logAudit(req, {
      action: "change_user_role",
      entityType: "user",
      entityId: id,
      beforeData: { id: before.id, email: before.email, name: before.name, role: before.role },
      afterData: { id: updated.id, email: updated.email, name: updated.name, role: updated.role },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengubah peran user" });
  }
});

// ─── DELETE /api/users/:id — hapus user ──────────────────────────────────────

router.delete("/users/:id", requireAuth, requireAnyRole("owner"), async (req, res) => {
  const id = String(req.params.id);
  const currentUserId = req.user?.dbId;

  if (id === currentUserId) {
    res.status(400).json({ error: "Tidak dapat menghapus akun Anda sendiri" });
    return;
  }

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!target) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    await db.delete(tenantUserAccessTable).where(eq(tenantUserAccessTable.userId, id));
    await db.delete(usersTable).where(eq(usersTable.id, id));

    invalidateUserStatusCache(id);

    logAudit(req, {
      action: "delete_user",
      entityType: "user",
      entityId: id,
      beforeData: { name: target.name, email: target.email, role: target.role },
    });

    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: "Gagal menghapus user" });
  }
});

// ─── POST /api/users/:id/reset-session — paksa logout sesi aktif ─────────────

router.post("/users/:id/reset-session", requireAuth, requireAnyRole("owner"), async (req, res) => {
  const id = String(req.params.id);
  const currentUserId = req.user?.dbId;

  if (id === currentUserId) {
    res.status(400).json({ error: "Tidak dapat mereset sesi Anda sendiri" });
    return;
  }

  try {
    const [target] = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, id));
    if (!target) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    const now = new Date();
    await db
      .update(usersTable)
      .set({ forceLogoutAt: now, updatedAt: now })
      .where(eq(usersTable.id, id));

    invalidateUserStatusCache(id);

    logAudit(req, {
      action: "reset_user_session",
      entityType: "user",
      entityId: id,
      afterData: { name: target.name, forceLogoutAt: now.toISOString() },
    });

    res.json({ ok: true, message: `Sesi ${target.name} telah direset` });
  } catch (err) {
    res.status(500).json({ error: "Gagal mereset sesi user" });
  }
});

export default router;
