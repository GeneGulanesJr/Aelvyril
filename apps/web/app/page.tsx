import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { Chat } from "../components/chat";

export default function Home() {
  return (
    <>
      <SignedOut>
        <main className="grid min-h-screen place-items-center">
          <div className="text-center">
            <h1 className="mb-4 text-2xl tracking-widest">AELVYRIL</h1>
            <SignInButton mode="modal">
              <button className="rounded-lg bg-[#1f6feb] px-4 py-2 text-sm">sign in</button>
            </SignInButton>
          </div>
        </main>
      </SignedOut>
      <SignedIn>
        <Chat />
      </SignedIn>
    </>
  );
}
