"use client";
import { useState } from "react";
import type { Thread, ThreadStatus, Usage } from "@aelvyril/shared";

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
  const [armed, setArmed] = useState(false);
  const effectiveStatus = liveStatus ?? thread.status;

  return (
    <header className="flex items-center justify-between border-b border-[#2b3245] bg-[#0d1117] px-4 py-2 text-sm">
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (t) onRename(t);
            setRenaming(false);
          }}
        >
          <input
            className="rounded border border-[#1f6feb] bg-[#161b27] px-2 py-1 text-sm focus:outline-none"
            data-testid="rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setRenaming(false)}
          />
        </form>
      ) : (
        <h1 className="font-semibold" data-testid="thread-title">{thread.title ?? "untitled"}</h1>
      )}
      <span data-testid="thread-status" className="rounded bg-[#21262d] px-2 py-0.5 text-xs">{liveStatus ?? thread.status}</span>
      {usage && (
        <span data-testid="thread-usage" className="rounded bg-[#21262d] px-2 py-0.5 text-xs text-[#8b96a8]">
          ${usage.cost.toFixed(4)} · {usage.tokens.total.toLocaleString()} tok
        </span>
      )}
      <div className="flex gap-2">
        {effectiveStatus === "reviewed" && onMerge && (
          <button
            className="text-xs font-medium text-[#3fb950] hover:underline"
            data-testid="merge-button"
            onClick={onMerge}
          >merge</button>
        )}
        {renaming ? null : (
          <button
            className="text-xs text-[#8b96a8] hover:text-[#e6edf3]"
            data-testid="rename-button"
            onClick={() => { setDraft(thread.title ?? ""); setRenaming(true); }}
          >rename</button>
        )}
        <button className="text-xs text-[#f85149] hover:underline" data-testid="abandon-button" onClick={onAbandon}>abandon</button>
        {onDelete && (
          armed ? (
            <>
              <button
                className="text-xs font-medium text-[#f85149] hover:underline"
                data-testid="delete-button"
                onClick={() => { setArmed(false); onDelete(); }}
              >confirm delete?</button>
              <button className="text-xs text-[#8b96a8]" data-testid="delete-cancel" onClick={() => setArmed(false)}>no</button>
            </>
          ) : (
            <button className="text-xs text-[#f85149]/70 hover:text-[#f85149]" data-testid="delete-button" onClick={() => setArmed(true)}>delete</button>
          )
        )}
      </div>
    </header>
  );
}
