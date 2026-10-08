"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * The two faces of the app: "desk" is the dispatch board as shipped, "crew"
 * is the same state embodied by characters. Pure presentation plumbing —
 * no thread state lives here.
 */
export type UiMode = "desk" | "crew";

const STORAGE_KEY = "aelvyril.ui-mode";

export type UiModeContextValue = {
  mode: UiMode;
  setMode: (mode: UiMode) => void;
};

const UiModeContext = createContext<UiModeContextValue | null>(null);

/** Only ever called after mount — never during render — so SSR always sees "desk". */
function readStoredMode(): UiMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "crew" ? "crew" : "desk";
  } catch {
    return "desk";
  }
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiMode>("desk");

  // Adopt the persisted choice once the client is live. Anything invalid or
  // corrupt falls back to desk rather than guessing.
  useEffect(() => {
    setModeState(readStoredMode());
  }, []);

  const setMode = (next: UiMode): void => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode Safari throws on writes; the mode then lives in-memory only.
    }
  };

  return <UiModeContext.Provider value={{ mode, setMode }}>{children}</UiModeContext.Provider>;
}

/** Throws when used outside a <UIProvider>: a loud failure beats a silent desk
 *  fallback for consumers (the crew) that must never render uncontrolled. */
export function useUiMode(): UiModeContextValue {
  const ctx = useContext(UiModeContext);
  if (!ctx) throw new Error("useUiMode must be used inside a <UIProvider>");
  return ctx;
}
