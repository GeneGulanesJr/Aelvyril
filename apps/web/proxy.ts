import { clerkMiddleware } from "@clerk/nextjs/server";
import { AUTH_DISABLED, CLERK_PUBLISHABLE_KEY, publishableKeyIsWellFormed } from "./lib/auth.js";

// Local dev (NEXT_PUBLIC_AUTH_DISABLED=1, see lib/auth.ts): sign-in is
// replaced by a fixed dev identity, so the proxy is a no-op.
//
// Also no-op whenever Clerk cannot actually run: clerkMiddleware() throws
// MissingPublishableKeyError without a well-formed publishable key and
// MissingSecretKeyError without a secret key — 500ing every request. The
// documented behavior for keyless environments is the app's defensive
// signed-out gate (e2e chat.spec), which only needs this middleware to get
// out of the way. The secret key is only read here (server-only module).
const clerkUnavailable =
  AUTH_DISABLED ||
  !publishableKeyIsWellFormed(CLERK_PUBLISHABLE_KEY) ||
  !process.env.CLERK_SECRET_KEY;

export default clerkUnavailable
  ? (() => undefined) as unknown as ReturnType<typeof clerkMiddleware>
  : clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)", "/__clerk/:path*"],
};
