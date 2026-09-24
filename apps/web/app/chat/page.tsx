import { redirect } from "next/navigation";

// Legacy chat-first entry point — superseded by the spec-centric thread UI.
export default function Page() {
  redirect("/thread/new");
}
