// Local-dev auth switch. When NEXT_PUBLIC_AUTH_DISABLED=1 (inlined into the
// client bundle at BUILD time), the app swaps Clerk for a fixed dev
// identity: the gateway's PI_FAKE verifier accepts any bearer token and
// uses the token itself as the userId, so DEV_USER_ID below becomes the
// gateway identity and memory namespace (user:dev-local).
//
// Keep this OFF for anything reachable off-host — combined with the
// gateway's fake verifier it is full unauthenticated access by design.
export const AUTH_DISABLED = process.env.NEXT_PUBLIC_AUTH_DISABLED === "1";
export const DEV_USER_ID = "dev-local";

// The publishable key is inlined into client bundles at build time and read
// directly from the environment server-side — the same expression works in
// both. The secret key is NEVER referenced here: in client bundles it would
// compile to undefined (Next only inlines NEXT_PUBLIC_*), so availability
// checks that need it must live server-side (see proxy.ts).
export const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

// Mirrors the validation @clerk/shared applies before ClerkProvider mounts:
// pk_test_/pk_live_ prefix plus a non-empty base64 payload. A key that fails
// this makes ClerkProvider throw at render time (500 on every page), so any
// code that mounts Clerk must gate on this first. Being defensive here is
// the documented contract (e2e chat.spec "no auth — defensive UI"): a
// missing or malformed key must render the signed-out gate, never a 500.
export function publishableKeyIsWellFormed(pk: string): boolean {
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(pk);
  const payload = match?.[1];
  if (!payload) return false;
  try {
    return atob(payload.replace(/-/g, "+").replace(/_/g, "/")).length > 0;
  } catch {
    return false;
  }
}

// Client-safe usability: only the publishable key is knowable client-side.
export const CLERK_CLIENT_USABLE = publishableKeyIsWellFormed(CLERK_PUBLISHABLE_KEY);
