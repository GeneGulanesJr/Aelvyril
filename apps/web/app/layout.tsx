import type { Metadata, Viewport } from "next";
import { Fira_Sans, JetBrains_Mono } from "next/font/google";
import { AuthGate } from "../components/auth-gate.js";
import "./globals.css";

const fira = Fira_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fira",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Aelvyril",
  description: "Agent workspace — ask, watch the route, merge the diff.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0e1217",
  width: "device-width",
  initialScale: 1,
};

// Auth-gated app: Clerk components need runtime auth state, so skip static prerender.
// This also keeps `next build` green with placeholder Clerk keys (CI) — Clerk throws
// on invalid publishableKeys during prerender otherwise.
export const dynamic = "force-dynamic";

// AuthGate renders ClerkProvider normally, or a fixed dev identity when
// NEXT_PUBLIC_AUTH_DISABLED=1 (local testing without Clerk).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fira.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen bg-desk font-sans text-ink antialiased">
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
