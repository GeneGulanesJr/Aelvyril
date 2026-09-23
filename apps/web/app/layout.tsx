import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

// Auth-gated app: Clerk components need runtime auth state, so skip static prerender.
// This also keeps `next build` green with placeholder Clerk keys (CI) — Clerk throws
// on invalid publishableKeys during prerender otherwise.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] antialiased">
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
