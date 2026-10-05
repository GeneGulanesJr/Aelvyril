"use client";
import type { ThreadState } from "../../lib/use-thread.js";

const BLOCKED_REASONS: Record<"question" | "dialog" | "capped", string> = {
  question: "The agent asked a question — answer it in the spec panel.",
  dialog:
    "The agent hit a blocking dialog it can't answer headlessly. Enable the dialog auto-responder or intervene in the session.",
  capped:
    "Budget cap reached for this thread. Raise GATEWAY_MAX_THREAD_COST_USD or abandon the thread.",
};

/**
 * Spec §10 status banners, ported to the thread surface.
 * - Degraded (yellow, persistent): the session host died mid-turn; chat
 *   continues and the next prompt respawns it automatically.
 * - Blocked (orange, persistent): needs-you escalation with a reason (#84) —
 *   unanswered question, blocking dialog, or budget cap exceeded.
 * - Error (red, dismissable): per-request failure or an error envelope.
 */
export function Banners({ degraded, blocked, error, onDismissError }: {
  degraded: ThreadState["degraded"];
  blocked: ThreadState["blocked"];
  error: ThreadState["error"];
  onDismissError: () => void;
}) {
  return (
    <>
      {degraded && (
        <div
          className="border-b border-[#e3b341]/40 bg-[#e3b341]/15 px-4 py-2 text-xs text-[#e3b341]"
          data-testid="degraded-banner"
          role="status"
        >
          The agent session was interrupted — your thread is safe. Send your next
          prompt and the session host respawns automatically.
        </div>
      )}
      {blocked && (
        <div
          className="border-b border-[#e3b341]/60 bg-[#bc4c00]/20 px-4 py-2 text-xs text-[#f0883e]"
          data-testid="blocked-banner"
          role="status"
        >
          Needs you — blocked{blocked === "capped" ? " (budget cap)" : ""}:{" "}
          {BLOCKED_REASONS[blocked]}
        </div>
      )}
      {error && (
        <div
          className="flex items-center justify-between border-b border-[#f85149]/40 bg-[#f85149]/15 px-4 py-2 text-xs text-[#f85149]"
          data-testid="error-banner"
          role="alert"
        >
          <span>{error}</span>
          <button
            className="ml-3 text-[#8b96a8] hover:text-[#e6edf3]"
            data-testid="dismiss-error"
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
