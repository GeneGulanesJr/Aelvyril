import { verifyToken } from "@clerk/backend";

export interface VerifiedUser {
  userId: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedUser | null>;

/**
 * Real Clerk verifier (spec §8). Bearer token on every /v1 call.
 * Requires CLERK_SECRET_KEY in the gateway env.
 *
 * @clerk/backend >= 2 exposes verifyToken as a standalone function taking the
 * secret key per call (ClerkClient no longer carries verifyToken).
 */
export function createClerkVerifier(secretKey: string): TokenVerifier {
  return async (token) => {
    try {
      const claims = await verifyToken(token, { secretKey });
      if (!claims.sub) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  };
}
