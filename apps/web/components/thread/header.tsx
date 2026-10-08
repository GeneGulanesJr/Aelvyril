"use client";
import { useState } from "react";
import { Ban, FolderGit2, GitMerge, Pencil, Trash2 } from "lucide-react";
import type { Thread, ThreadStatus, Usage } from "@aelvyril/shared";
import { STATUS_META, fmtCost, fmtTokens } from "../../lib/design.js";

const ACTION_BTN =
  "flex items-center gap-1 text-sm text-ink-muted transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
const CONFIRM_BTN = "text-sm font-medium text-danger hover:underline";
const CANCEL_BTN =
  "text-sm text-ink-faint transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

export function ThreadHeader({ thread, liveStatus, usage, onRename, onAbandon, onDelete, onMerge }: {
  thread: Thread;
  /** #83: live status from the SSE stream — wins over the stale
   *  mount-time snapshot so queued→running transitions are visible. */
  liveStatus?: ThreadStatus | null;
  /** #84: cumulative cost/token usage (live from the SSE usage envelope). */
  usage?: Usage | null;
  onRename: (title: string) => void;
  onAbandon: () => void;
  onDelete?: () => void;
  /** #80: accept the reviewed diff (reviewed → merged). */
  onMerge?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title ?? "");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [abandonArmed, setAbandonArmed] = useState(false);
  const effectiveStatus = liveStatus ?? thread.status;
  const meta = STATUS_META[effectiveStatus];

  return (
    <header className="flex items-center gap-3 border-b border-seam bg-panel px-4 py-2.5">
      {renaming ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (t) onRename(t);
            setRenaming(false);
          }}
        >
          <input
            className="w-64 rounded border border-seam-strong bg-panel-raised px-2 py-1 text-sm text-ink"
            data-testid="rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setRenaming(false)}
          />
        </form>
      ) : (
        <h1 className="hidden min-w-0 flex-1 truncate text-base font-medium text-ink md:block" data-testid="thread-title">
          {thread.title ?? "untitled"}
        </h1>
      )}
      <span data-testid="thread-status" className="flex shrink-0 items-center gap-1.5">
        <span
          aria-hidden
          className={`size-2 rounded-full ${meta.lampClass}${meta.pulse ? " animate-lamp-pulse" : ""}`}
        />
        <span className={`font-mono text-xs uppercase tracking-wider ${meta.textClass}`}>{meta.label}</span>
      </span>
      {thread.workspace && (
        <span className="hidden shrink-0 items-center gap-1 rounded border border-seam px-1.5 py-0.5 font-mono text-xs text-ink-faint md:flex">
          <FolderGit2 aria-hidden className="size-3" />
          {thread.workspace}
        </span>
      )}
      {usage && (
        <span data-testid="thread-usage" className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
          {fmtCost(usage.cost)} · {fmtTokens(usage.tokens.total)}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {effectiveStatus === "reviewed" && onMerge && (
          <button
            type="button"
            data-testid="merge-button"
            aria-label="Merge"
            onClick={onMerge}
            // The desk's terminal action outranks the utility row: solid go aspect.
            className="flex items-center gap-1.5 rounded-md bg-go px-2.5 py-1 text-sm font-semibold text-go-ink transition-colors duration-150 hover:bg-go/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GitMerge aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Merge</span>
          </button>
        )}
        {renaming ? null : (
          <button
            type="button"
            className={ACTION_BTN}
            data-testid="rename-button"
            aria-label="Rename"
            onClick={() => { setDraft(thread.title ?? ""); setRenaming(true); }}
          >
            <Pencil aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Rename</span>
          </button>
        )}
        {abandonArmed ? (
          <>
            <button
              type="button"
              className={CONFIRM_BTN}
              data-testid="abandon-confirm"
              onClick={() => { setAbandonArmed(false); onAbandon(); }}
            >
              confirm abandon?
            </button>
            <button type="button" className={CANCEL_BTN} data-testid="abandon-cancel" onClick={() => setAbandonArmed(false)}>
              no
            </button>
          </>
        ) : (
          <button type="button" className={ACTION_BTN} data-testid="abandon-button" aria-label="Abandon" onClick={() => setAbandonArmed(true)}>
            <Ban aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Abandon</span>
          </button>
        )}
        {onDelete && (
          deleteArmed ? (
            <>
              <button
                type="button"
                className={CONFIRM_BTN}
                data-testid="delete-button"
                onClick={() => { setDeleteArmed(false); onDelete(); }}
              >
                confirm delete?
              </button>
              <button type="button" className={CANCEL_BTN} data-testid="delete-cancel" onClick={() => setDeleteArmed(false)}>
                no
              </button>
            </>
          ) : (
            <button type="button" className={ACTION_BTN} data-testid="delete-button" aria-label="Delete" onClick={() => setDeleteArmed(true)}>
              <Trash2 aria-hidden className="size-3.5" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          )
        )}
      </div>
    </header>
  );
}
