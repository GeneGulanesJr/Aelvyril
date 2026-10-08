"use client";
import { useState } from "react";
import { OctagonX, Plus, Search } from "lucide-react";
import type { Thread } from "@aelvyril/shared";
import { STATUS_META, fmtCost, fmtRelTime } from "../../lib/design.js";

const cn = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

const byNewest = (a: Thread, b: Thread): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/** Describer-board sections. A blocked escalation outranks lifecycle status —
 *  it leaves its status band and parks under "Needs you" until answered. */
function boardGroups(threads: Thread[]): Array<{ label: string; threads: Thread[] }> {
  const needsYou: Thread[] = [];
  const inFlight: Thread[] = [];
  const desk: Thread[] = [];
  const closed: Thread[] = [];
  for (const t of threads) {
    if (t.state === "blocked") needsYou.push(t);
    else if (t.status === "queued" || t.status === "spec'ing" || t.status === "running") inFlight.push(t);
    else if (t.status === "draft") desk.push(t);
    else closed.push(t);
  }
  return [
    { label: "Needs you", threads: needsYou.sort(byNewest) },
    { label: "In flight", threads: inFlight.sort(byNewest) },
    { label: "Desk", threads: desk.sort(byNewest) },
    { label: "Closed", threads: closed.sort(byNewest) },
  ].filter((g) => g.threads.length > 0);
}

export function ThreadSidebar({ threads, activeId, onSelect, onCreate, onKillAll, onNavigate }: {
  threads: Thread[]; activeId: string | null;
  onSelect: (id: string) => void; onCreate: () => void;
  /** #84: global kill switch — two-step confirm like the delete button. */
  onKillAll?: () => void;
  /** Mobile drawer close; fired after any navigation this sidebar triggers. */
  onNavigate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [armed, setArmed] = useState(false);
  const q = query.trim().toLowerCase();
  // Case-insensitive substring match on title, falling back to id so
  // untitled threads stay findable.
  const visible = q
    ? threads.filter((t) => (t.title ?? t.id).toLowerCase().includes(q))
    : threads;
  const groups = boardGroups(visible);

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-seam bg-desk">
      <div className="p-3">
        <div className="mb-3 text-xs font-mono uppercase tracking-[0.2em] text-ink-muted">AELVYRIL</div>
        <button
          className="flex w-full items-center gap-2 rounded-md border border-seam-strong bg-panel-raised px-3 py-2 text-sm font-medium text-ink transition-colors duration-150 hover:bg-panel-active disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => { onCreate(); onNavigate?.(); }}
          data-testid="new-thread"
        >
          <Plus aria-hidden className="size-4" />
          New thread
        </button>
      </div>
      <div className="relative px-3 pb-3">
        <Search aria-hidden className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
        <input
          className="w-full rounded-md border border-seam bg-panel-raised py-1.5 pl-8 pr-2.5 text-sm text-ink placeholder:text-ink-faint"
          data-testid="thread-search"
          placeholder="Search threads…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <nav data-testid="thread-list" className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm text-ink-faint">No threads on the board.</p>
            <p className="text-sm text-ink-faint">Ask something to open your first route.</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label}>
              <div className="px-3 pt-4 pb-1 text-xs font-mono uppercase tracking-wider text-ink-faint">
                {group.label}
              </div>
              <ul>
                {group.threads.map((t) => {
                  const meta = STATUS_META[t.status];
                  // Blocked is a state, not a lifecycle status: its lamp is the
                  // reserved yellow aspect, pulsing until the decision lands.
                  const blocked = t.state === "blocked";
                  return (
                    <li key={t.id}>
                      <button
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                          activeId === t.id ? "bg-panel-active" : "hover:bg-panel-raised",
                        )}
                        onClick={() => { onSelect(t.id); onNavigate?.(); }}
                        data-testid={`thread-${t.id}`}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            blocked ? "bg-needsyou animate-lamp-pulse" : meta.lampClass,
                            !blocked && meta.pulse && "animate-lamp-pulse",
                          )}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm text-ink">{t.title ?? t.id}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs font-mono tabular-nums text-ink-faint">
                            <span data-testid="status-pill" className={meta.textClass}>{meta.label}</span>
                            <span aria-hidden>·</span>
                            <span>{fmtRelTime(t.createdAt)}</span>
                          </span>
                        </span>
                        {t.usage != null && (
                          <span className="shrink-0 text-xs font-mono tabular-nums text-ink-faint">
                            {fmtCost(t.usage.cost)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </nav>
      {onKillAll && (
        <div className="border-t border-seam p-3">
          {armed ? (
            <div className="flex items-center gap-2">
              <button
                className="flex flex-1 items-center gap-2 rounded-md border border-danger bg-danger/15 px-3 py-2 text-sm text-danger transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="kill-all-button"
                onClick={() => { setArmed(false); onKillAll(); }}
              >
                <OctagonX aria-hidden className="size-4" />
                confirm kill all?
              </button>
              <button
                className="rounded-md border border-seam px-3 py-2 text-sm text-ink-muted transition-colors duration-150 hover:bg-panel-active disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="kill-all-cancel"
                onClick={() => setArmed(false)}
              >
                no
              </button>
            </div>
          ) : (
            <button
              className="flex w-full items-center gap-2 rounded-md border border-danger/50 px-3 py-2 text-sm text-danger transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="kill-all-button"
              onClick={() => setArmed(true)}
            >
              <OctagonX aria-hidden className="size-4" />
              kill all
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
