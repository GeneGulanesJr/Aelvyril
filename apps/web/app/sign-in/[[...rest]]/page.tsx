import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_DISABLED } from "../../../lib/auth.js";

// Local dev (NEXT_PUBLIC_AUTH_DISABLED=1): there is no sign-in flow — the
// visitor is already the fixed dev identity, so bounce into the app
// instead of rendering Clerk (which would throw without a publishable key).
export default function Page() {
  if (AUTH_DISABLED) redirect("/thread/new");
  return <SignIn />;
}
