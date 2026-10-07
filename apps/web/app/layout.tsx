import { AuthGate } from "../components/auth-gate.js";
import "./globals.css";

// Auth-gated app: Clerk components need runtime auth state, so skip static prerender.
// This also keeps `next build` green with placeholder Clerk keys (CI) — Clerk throws
// on invalid publishableKeys during prerender otherwise.
export const dynamic = "force-dynamic";

// AuthGate renders ClerkProvider normally, or a fixed dev identity when
// NEXT_PUBLIC_AUTH_DISABLED=1 (local testing without Clerk).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] antialiased">
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
