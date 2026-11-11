import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

/**
 * The gateway talks to auth only through this interface. Better Auth implements it
 * today; a Clerk verifier (token -> userId) can be added later without touching routes.
 */
export interface Auth {
  /** Resolves the caller from cookies or an `Authorization: Bearer` header. */
  verify(headers: Headers): Promise<{ userId: string } | null>;
  /** Better Auth's own HTTP handler, mounted at /api/auth/*. */
  handler(req: Request): Promise<Response>;
  /** Sign-up is open only until the first account exists (single-user app). */
  hasUsers(): boolean;
  /** One-time code the first sign-up must present (printed in the server log); null once an account exists. */
  setupCode(): string | null;
}

export async function createAuth(cfg: Config, db: Db, extraOrigins: string[] = []): Promise<Auth> {
  const options = {
    database: db,
    secret: cfg.authSecret,
    emailAndPassword: { enabled: true },
    plugins: [bearer()],
    // Same-origin check: the browser's Origin must match the host the request arrived on.
    trustedOrigins: (req?: Request) => [...extraOrigins, ...(req ? [new URL(req.url).origin] : [])],
  };
  // Migrate before betterAuth() starts, or it logs a "schema mismatch" error on first run.
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const hasUsers = () => (db.prepare("SELECT COUNT(*) AS c FROM user").get() as { c: number }).c > 0;
  const code = process.env.AELVYRIL_SETUP_CODE || randomBytes(4).toString("hex");
  return {
    async verify(headers) {
      const s = await auth.api.getSession({ headers });
      return s ? { userId: s.user.id } : null;
    },
    handler: (req) => auth.handler(req),
    hasUsers,
    setupCode: () => (hasUsers() ? null : code),
  };
}
