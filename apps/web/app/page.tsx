// Clerk Core 3 (@clerk/nextjs v7+) removed <SignedIn>/<SignedOut> in favor of
// the server-side auth() helper. The gate runs at request time on the server;
// the Chat component itself is rendered client-side (it calls useAuth()).
import { auth } from "@clerk/nextjs/server";
import { Chat } from "../components/chat";

export default async function Home() {
  const { userId } = await auth();
  if (!userId) return <SignInPrompt />;
  return <Chat />;
}

function SignInPrompt() {
  return (
    <main className="grid min-h-screen place-items-center">
      <div className="text-center">
        <h1 className="mb-4 text-2xl tracking-widest">AELVYRIL</h1>
        <a
          href="/sign-in"
          className="inline-block rounded-lg bg-[#1f6feb] px-4 py-2 text-sm"
        >
          sign in
        </a>
      </div>
    </main>
  );
}