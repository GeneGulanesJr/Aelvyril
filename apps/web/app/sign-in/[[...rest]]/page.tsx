import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_DISABLED, CLERK_CLIENT_USABLE } from "../../../lib/auth.js";

// Local dev (NEXT_PUBLIC_AUTH_DISABLED=1): there is no sign-in flow — the
// visitor is already the fixed dev identity, so bounce into the app
// instead of rendering Clerk (which would throw without a publishable key).
//
// Keyless builds (no/malformed publishable key): <SignIn/> needs a mounted
// ClerkProvider, which the root layout withholds in that state — render a
// static notice instead of throwing.
export default function Page() {
  if (AUTH_DISABLED) redirect("/thread/new");
  if (!CLERK_CLIENT_USABLE) {
    return (
      <main className="grid min-h-screen place-items-center bg-desk text-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-[0.3em] text-ink">AELVYRIL</h1>
          <p className="mt-3 max-w-md text-sm text-ink-muted">
            Sign-in is not configured in this environment. Ask an operator to
            provision Clerk keys (apps/web/.env.local) to enable authentication.
          </p>
          <a href="/thread/new" className="mt-6 inline-block rounded-md bg-route px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-route/90">
            Back to the app
          </a>
        </div>
      </main>
    );
  }
  return <SignIn />;
}
