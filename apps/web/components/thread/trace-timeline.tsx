"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  Box,
  Check,
  CornerDownRight,
  Loader2,
  MessageSquareWarning,
  Scale,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { TimelineItem } from "../../lib/use-thread.js";
import { fmtClock, fmtDuration, summarizeArgs } from "../../lib/design.js";

/** The desk log: one row per timeline event, clock first. Auto-scroll keeps
 *  the newest row visible while the user reads from the bottom; scrolling up
 *  releases the pin and offers a "jump to now" pill instead. */
export function TraceTimeline({ items, streamLive }: { items: TimelineItem[]; streamLive: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Pinned = the user is reading live from the bottom (~80px tolerance).
  // jsdom keeps scrollHeight/clientHeight at 0, which reads as pinned.
  const [pinned, setPinned] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= 80);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [items, pinned]);

  const jumpToNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto" data-testid="trace-scroll">
        <div data-testid="trace-list" className="flex flex-col gap-1.5 py-2">
          {items.map((item, i) => (
            <TimelineRow key={item.id} item={item} index={i} streamLive={streamLive} />
          ))}
        </div>
      </div>
      {!pinned && (
        <button
          type="button"
          data-testid="jump-to-now"
          onClick={jumpToNow}
          className="absolute bottom-3 right-4 rounded-full border border-seam-strong bg-panel-raised px-3 py-1 text-xs text-ink-muted shadow-pop transition-colors duration-150 hover:text-ink"
        >
          jump to now
        </button>
      )}
    </div>
  );
}

function TimelineRow({ item, index, streamLive }: { item: TimelineItem; index: number; streamLive: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div data-testid={`tl-user-${index}`} className="flex items-start gap-2.5 px-4 py-1">
          <Clock ts={item.ts} />
          <CornerDownRight aria-hidden className="size-3.5 shrink-0 translate-y-1 text-route" />
          <p className="text-sm text-ink">{item.text}</p>
        </div>
      );
    case "narration":
      return (
        <div data-testid={`tl-narration-${index}`} className="flex items-start gap-2.5 px-4 py-1">
          <Clock ts={item.ts} />
          <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-ink/90">
            {item.text}
            {item.live && streamLive && (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-stream-caret bg-route"
              />
            )}
          </p>
        </div>
      );
    case "tool":
      return (
        <div data-testid={`tl-tool-${index}`}>
          <details>
            <summary className="cursor-pointer marker:hidden [&::-webkit-details-marker]:hidden transition-colors duration-150 hover:bg-panel">
              <div className="flex items-start gap-2.5 px-4 py-1">
                <Clock ts={item.ts} />
                <Wrench aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
                <span className="shrink-0 pt-0.5 font-mono text-xs text-ink-muted">{item.name}</span>
                <span className="min-w-0 truncate pt-0.5 text-xs text-ink-faint">{summarizeArgs(item.args ?? "")}</span>
                <ToolStatus item={item} />
              </div>
            </summary>
            {item.args !== undefined && item.args !== "" && (
              <pre className="whitespace-pre-wrap break-all py-1 pl-[76px] pr-4 font-mono text-xs text-ink-faint">
                {item.args}
              </pre>
            )}
          </details>
        </div>
      );
    case "subagents":
      return (
        <div data-testid={`tl-subagents-${index}`}>
          <div className="flex items-start gap-2.5 px-4 py-1">
            <Clock ts={item.ts} />
            <Users aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-caution" />
            <span className="min-w-0 truncate pt-0.5 font-mono text-xs text-ink-muted">
              {item.agents.map((a) => a.agent).join(" · ")}
            </span>
            <span className="shrink-0 rounded border border-seam px-1.5 py-0.5 font-mono text-xs text-ink-faint">
              {item.mode}
            </span>
          </div>
          {item.agents.map((a) => (
            <div key={a.agent} className="py-0.5 pl-[76px] pr-4 text-xs text-ink-faint">
              {a.task}
            </div>
          ))}
        </div>
      );
    case "sandbox":
      return (
        <div data-testid={`tl-sandbox-${index}`} className="flex items-start gap-2.5 px-4 py-1">
          <Clock ts={item.ts} />
          <Box aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
          <span className="pt-0.5 font-mono text-xs text-ink-muted">{item.profile}</span>
          {item.sandboxId && <span className="truncate pt-0.5 font-mono text-xs text-ink-faint">{item.sandboxId}</span>}
        </div>
      );
    case "promote":
      return (
        <div data-testid={`tl-promote-${index}`} className="flex items-start gap-2.5 px-4 py-1">
          <Clock ts={item.ts} />
          <ArrowUpFromLine aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
          <span className="shrink-0 pt-0.5 font-mono text-xs text-ink-muted">{item.sandboxId}</span>
          <span className="min-w-0 truncate pt-0.5 font-mono text-xs text-ink-faint">{item.paths.join(" · ")}</span>
        </div>
      );
    case "verdict":
      return (
        <div data-testid={`tl-verdict-${index}`}>
          <details>
            <summary className="cursor-pointer marker:hidden [&::-webkit-details-marker]:hidden transition-colors duration-150 hover:bg-panel">
              <div className="flex items-start gap-2.5 px-4 py-1">
                <Clock ts={item.ts} />
                <Scale aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-route" />
                <span className="pt-0.5 font-mono text-xs text-ink-muted">{item.tool}</span>
                <span className="ml-auto pt-0.5 text-xs text-ink-faint">verdict</span>
              </div>
            </summary>
            <pre className="whitespace-pre-wrap break-all py-1 pl-[76px] pr-4 font-mono text-xs text-ink-faint">
              {JSON.stringify(item.verdict, null, 2)}
            </pre>
          </details>
        </div>
      );
    case "dialog": {
      const blocked = item.action === "blocked";
      return (
        <div data-testid={`tl-dialog-${index}`} className="flex items-start gap-2.5 px-4 py-1">
          <Clock ts={item.ts} />
          <MessageSquareWarning
            aria-hidden
            className={`size-3.5 shrink-0 translate-y-0.5 ${blocked ? "text-danger" : "text-ink-faint"}`}
          />
          <span className="min-w-0 pt-0.5 text-sm text-ink-muted">{item.title}</span>
          <span className="shrink-0 rounded border border-seam px-1.5 py-0.5 font-mono text-xs text-ink-faint">
            {item.action}
          </span>
        </div>
      );
    }
  }
}

/** Right side of a tool row: in-flight spinner, or the paired result aspect
 *  (go check / danger cross) with the wall-clock duration once paired. */
function ToolStatus({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {!item.result && <Loader2 aria-hidden className="size-3.5 animate-spin text-ink-faint" />}
      {item.result && !item.result.isError && <Check aria-hidden className="size-3.5 text-go" />}
      {item.result?.isError && <X aria-hidden className="size-3.5 text-danger" />}
      {item.result && (
        <span className="font-mono text-xs tabular-nums text-ink-faint">{fmtDuration(item.ts, item.result.ts)}</span>
      )}
    </span>
  );
}

function Clock({ ts }: { ts: string }) {
  return (
    <span className="w-14 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-ink-faint">{fmtClock(ts)}</span>
  );
}
