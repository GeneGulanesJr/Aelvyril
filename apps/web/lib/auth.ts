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
