"use client";
import { useState } from "react";
import { PlanTab, TraceTab, DiffTab } from "./tabs.js";

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "trace", label: "Trace" },
  { id: "diff", label: "Diff" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function OutputTabs({ plan, trace, diff }: {
  plan: string[];
  trace: string[];
  diff: { path: string; patch: string }[];
}) {
  const [tab, setTab] = useState<TabId>("plan");
  return (
    <div className="flex flex-1 flex-col overflow-hidden border-b border-[#2b3245]" data-testid="output-tabs">
      <div className="flex gap-1 border-b border-[#2b3245] px-3 pt-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            data-testid={`tab-${t.id}`}
            data-active={tab === t.id ? "true" : "false"}
            className={`rounded-t px-3 py-1 text-sm ${tab === t.id ? "border-b-2 border-[#1f6feb] text-[#e6edf3]" : "text-[#8b96a8] hover:text-[#e6edf3]"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3">
        {tab === "plan" && <PlanTab plan={plan} />}
        {tab === "trace" && <TraceTab trace={trace} />}
        {tab === "diff" && <DiffTab diff={diff} />}
      </div>
    </div>
  );
}
