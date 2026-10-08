"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

/**
 * Desk toasts — quiet confirmations for actions that otherwise succeed
 * silently (rename, kill-all, create). Errors keep the status band; toasts
 * never carry them, so the band stays the single error surface.
 */
interface Toast {
  id: number;
  text: string;
  tone: "ok" | "info";
}

const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function useToast(): (text: string, tone?: Toast["tone"]) => void {
  return useContext(ToastContext);
}

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, text, tone }]);
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-band-ignite pointer-events-auto flex items-center gap-2 rounded-md border border-seam bg-panel-raised px-3 py-2 text-sm text-ink shadow-pop"
            data-testid="toast"
          >
            {t.tone === "ok" ? (
              <CheckCircle2 aria-hidden className="size-4 text-go" />
            ) : (
              <XCircle aria-hidden className="size-4 text-ink-muted" />
            )}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
