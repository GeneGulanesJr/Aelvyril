"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { createContext, useContext, type ReactNode } from "react";
import { AUTH_DISABLED, DEV_USER_ID } from "../lib/auth.js";

export type AppAuth = {
  getToken: () => Promise<string | null>;
  userId: string | null;
};

const noopToken = async (): Promise<null> => null;

const AuthContext = createContext<AppAuth>({ getToken: noopToken, userId: null });

// Bridges Clerk's useAuth into the app-level auth context (Clerk mode only —
// this component is only mounted under ClerkProvider).
function ClerkBridge({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  // Clerk types userId as string | null | undefined; normalize.
  return (
    <AuthContext.Provider value={{ getToken, userId: userId ?? null }}>
      {children}
    </AuthContext.Provider>
  );
}

// Pages consume this instead of Clerk's useAuth directly, so the same code
// runs in both modes.
export function useAppAuth(): AppAuth {
  return useContext(AuthContext);
}

// Auth switch: ClerkProvider in normal operation; a fixed dev identity when
// NEXT_PUBLIC_AUTH_DISABLED=1 (local testing without Clerk — see lib/auth.ts).
export function AuthGate({ children }: { children: ReactNode }) {
  if (AUTH_DISABLED) {
    return (
      <AuthContext.Provider
        value={{ getToken: async () => DEV_USER_ID, userId: DEV_USER_ID }}
      >
        {children}
      </AuthContext.Provider>
    );
  }
  return (
    <ClerkProvider>
      <ClerkBridge>{children}</ClerkBridge>
    </ClerkProvider>
  );
}
