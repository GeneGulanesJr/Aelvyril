import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_DISABLED } from "../../../lib/auth.js";

// Local dev (NEXT_PUBLIC_AUTH_DISABLED=1): no sign-up flow — bounce into
// the app (see sign-in page note).
export default function Page() {
  if (AUTH_DISABLED) redirect("/thread/new");
  return <SignUp />;
}
