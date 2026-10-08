"use client";
import { useEffect, useRef, useState } from "react";
import type { SpecDraft } from "@aelvyril/shared";
import type { TimelineItem } from "../../lib/use-thread.js";
import { PlanTab, TraceTab, DiffTab } from "./tabs.js";

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "trace", label: "Trace" },
  { id: "diff", label: "Diff" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export interface OutputTabsProps {
  plan: string[];
  draft: SpecDraft | null;
  /** Legacy reduced trace lines — fallback when no timeline exists yet. */
  trace: string[];
  timeline: TimelineItem[];
  diff: { path: string; patch: string }[];
  /** True while the agent is streaming narration (drives the live caret). */
  streamLive: boolean;
}

export function OutputTabs({ plan, draft, trace, timeline, diff, streamLive }: OutputTabsProps) {
  const [tab, setTab] = useState<TabId>("plan");
  // Until the user picks a tab, the desk follows the data: the diff is the
  // artifact, the plan is the negotiation, the timeline is the live run.
  // SSE fills these after mount, so the default re-evaluates as data lands.
  const userChose = useRef(false);
  const smartTab: TabId =
    diff.length > 0 ? "diff" : plan.length > 0 || draft ? "plan" : timeline.length > 0 ? "trace" : "plan";
  useEffect(() => {
    if (!userChose.current) setTab(smartTab);
  }, [smartTab]);
  const choose = (t: TabId) => {
    userChose.current = true;
    setTab(t);
  };
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="output-tabs">
      <div
        className="flex gap-1 border-b border-seam bg-panel px-4"
        role="tablist"
        aria-label="Thread output"
        onKeyDown={(e) => {
          // Roving arrows: the tablist is one tab stop; ← → move the active tab.
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const ids = TABS.map((t) => t.id);
          const at = ids.indexOf(tab);
          const next = (e.key === "ArrowRight" ? ids[(at + 1) % ids.length] : ids[(at + ids.length - 1) % ids.length]) ?? "plan";
          choose(next);
          document.querySelector<HTMLButtonElement>(`[data-testid="tab-${next}"]`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`pane-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            data-testid={`tab-${t.id}`}
            data-active={tab === t.id ? "true" : "false"}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-150 ${
              tab === t.id ? "border-route font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink"
            }`}
            onClick={() => choose(t.id)}
          >
            {t.label}
            {t.id === "trace" && timeline.length > 0 && (
              <span className="ml-1.5 font-mono text-xs tabular-nums text-ink-faint">{timeline.length}</span>
            )}
          </button>
        ))}
      </div>
      {/* Panes own their scrolling; the trace timeline needs an inner scroll
          root it can pin to the bottom while streaming. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "plan" && (
          <div id="pane-plan" role="tabpanel" aria-labelledby="tab-plan" className="flex-1 overflow-y-auto">
            <PlanTab plan={plan} draft={draft} />
          </div>
        )}
        {tab === "trace" && (
          <div id="pane-trace" role="tabpanel" aria-labelledby="tab-trace" className="flex min-h-0 flex-1 flex-col">
            <TraceTab trace={trace} timeline={timeline} streamLive={streamLive} />
          </div>
        )}
        {tab === "diff" && (
          <div id="pane-diff" role="tabpanel" aria-labelledby="tab-diff" className="flex-1 overflow-y-auto">
            <DiffTab diff={diff} />
          </div>
        )}
      </div>
    </div>
  );
}
