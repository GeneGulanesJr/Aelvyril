import { redirect } from "next/navigation";

// Spec-centric UI: the thread surface is the app. Signed-out handling lives
// inside /thread/[id] (useAuth gate + sign-in prompt).
export default function Page() {
  redirect("/thread/new");
}
