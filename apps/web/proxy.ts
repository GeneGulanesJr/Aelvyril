import { clerkMiddleware } from "@clerk/nextjs/server";
import { AUTH_DISABLED } from "./lib/auth.js";

// Local dev (NEXT_PUBLIC_AUTH_DISABLED=1, see lib/auth.ts): sign-in is
// replaced by a fixed dev identity, so the proxy is a no-op — running
// clerkMiddleware without a publishable key throws
// MissingPublishableKeyError on every request.
export default AUTH_DISABLED
  ? (() => undefined) as unknown as ReturnType<typeof clerkMiddleware>
  : clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)", "/__clerk/:path*"],
};
