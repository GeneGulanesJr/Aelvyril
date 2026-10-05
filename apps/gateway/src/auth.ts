import { verifyToken } from "@clerk/backend";

export interface VerifiedUser {
  userId: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedUser | null>;

/**
 * #78: true for listen hosts reachable only from this machine (localhost,
 * 127.0.0.0/8, ::1). Anything else — "::" or "0.0.0.0" (all interfaces), a
 * LAN IP, a hostname — counts as network-exposed. Brackets are stripped so
 * "[::1]" (URI-style spelling) also matches.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Real Clerk verifier (spec §8). Bearer token on every /v1 call.
 * Requires CLERK_SECRET_KEY in the gateway env.
 *
 * authorizedParties (#85): pins the token's azp claim to the expected
 * origins, so a token minted for another application can't be replayed
 * against the gateway. Unset = no azp pinning (legacy behavior).
 *
 * @clerk/backend >= 2 exposes verifyToken as a standalone function taking the
 * secret key per call (ClerkClient no longer carries verifyToken).
 */
export function createClerkVerifier(secretKey: string, authorizedParties?: string[]): TokenVerifier {
  return async (token) => {
    try {
      const claims = await verifyToken(token, {
        secretKey,
        ...(authorizedParties?.length ? { authorizedParties } : {}),
      });
      if (!claims.sub) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  };
}
