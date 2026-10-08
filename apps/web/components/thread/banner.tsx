"use client";
import { CircleAlert, Hand, Unplug, X } from "lucide-react";
import type { ThreadState } from "../../lib/use-thread.js";
import { Engineer } from "../crew/engineer.js";
import { useUiMode } from "../crew/ui-mode.js";

const BLOCKED_REASONS: Record<"question" | "dialog" | "capped" | "gated", string> = {
  question: "The agent asked a question — answer it in the spec panel.",
  dialog:
    "The agent hit a blocking dialog it can't answer headlessly. Enable the dialog auto-responder or intervene in the session.",
  capped:
    "Budget cap reached for this thread. Raise GATEWAY_MAX_THREAD_COST_USD or abandon the thread.",
  // #81: the risk classifier stopped an irreversible/external action.
  gated:
    "The agent tried an irreversible action (install, migration, delete, or deploy). Review it in the trace, then approve to allow exactly that action and continue.",
};

/**
 * Spec §10 status bands — one at a time, by precedence:
 * blocked (the reserved yellow "Needs you" aspect) > error (red, dismissable,
 * with an optional retry) > degraded (amber, persistent context). The lower
 * bands stay logically true but yield the surface to the higher one.
 */
export function Banners({ degraded, blocked, error, onDismissError, onRetry, onGotoSpec, onApprove }: {
  degraded: ThreadState["degraded"];
  blocked: ThreadState["blocked"];
  error: ThreadState["error"];
  onDismissError: () => void;
  /** Re-run the failed turn — adds a Retry control to the error band. */
  onRetry?: () => void;
  /** Jump to the spec panel — backs the question/dialog blocked actions. */
  onGotoSpec?: () => void;
  /** Approve the gated action (#81) — backs the gated blocked action. */
  onApprove?: () => void;
}) {
  const { mode } = useUiMode();

  if (blocked) {
    return (
      <div
        className="animate-band-ignite flex items-center gap-3 bg-needsyou px-4 py-2.5 text-sm font-medium text-needsyou-ink"
        data-testid="blocked-banner"
        role="alert"
      >
        {mode === "crew" ? (
          // Crew mode: the engineer IS the needs-you signal — arm raised,
          // helmet lamp on the reserved yellow aspect. This band is the one
          // place bg-needsyou/fill-needsyou belongs.
          <Engineer pose="attention" lamp="needsyou" className="h-7 w-6 shrink-0" />
        ) : (
          <Hand aria-hidden className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          Needs you — blocked{blocked === "capped" ? " (budget cap)" : ""}:{" "}
          {BLOCKED_REASONS[blocked]}
        </span>
        {blocked === "question" && onGotoSpec && (
          <button
            type="button"
            className="shrink-0 rounded bg-needsyou-ink px-2.5 py-1 text-xs font-semibold text-needsyou transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onGotoSpec}
          >
            Answer the questions
          </button>
        )}
        {blocked === "dialog" && onGotoSpec && (
          <button
            type="button"
            className="shrink-0 rounded bg-needsyou-ink px-2.5 py-1 text-xs font-semibold text-needsyou transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onGotoSpec}
          >
            Open the trace
          </button>
        )}
        {blocked === "gated" && onApprove && (
          <button
            type="button"
            className="shrink-0 rounded bg-needsyou-ink px-2.5 py-1 text-xs font-semibold text-needsyou transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onApprove}
          >
            {"Review & approve"}
          </button>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex items-center gap-2 border-b border-danger/30 bg-danger/15 px-4 py-2 text-sm text-danger"
        data-testid="error-banner"
        role="alert"
      >
        <CircleAlert aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{error}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onRetry && (
            <button
              type="button"
              className="text-danger underline-offset-2 transition-colors duration-150 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="retry-error"
              onClick={onRetry}
            >
              Retry turn
            </button>
          )}
          <button
            type="button"
            className="rounded p-0.5 text-danger transition-colors duration-150 hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="dismiss-error"
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </span>
      </div>
    );
  }

  if (degraded) {
    return (
      <div
        className="flex items-center gap-2 border-b border-caution/30 bg-caution/15 px-4 py-2 text-sm text-caution"
        data-testid="degraded-banner"
        role="status"
      >
        <Unplug aria-hidden className="size-4 shrink-0" />
        <span>
          The agent session was interrupted — your thread is safe. Send your next
          prompt and the session host respawns automatically.
        </span>
      </div>
    );
  }

  return null;
}
