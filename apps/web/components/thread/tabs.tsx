"use client";
import { useState } from "react";
import { Check, Copy, FileCode2, TriangleAlert } from "lucide-react";
import type { SpecDraft } from "@aelvyril/shared";
import type { TimelineItem } from "../../lib/use-thread.js";
import { TraceTimeline } from "./trace-timeline.js";

export function PlanTab({ plan, draft }: { plan: string[]; draft: SpecDraft | null }) {
  // The approved spec draft is the plan of record; the plain plan list is
  // the pre-spec fallback (and the reduced form when spec mode is off).
  const steps = draft?.plan ?? plan;
  if (steps.length === 0 && !draft) {
    return (
      <div className="max-w-prose p-3 text-sm text-ink-faint">
        <p>No plan yet.</p>
        <p>The agent drafts a plan here — for ambiguous asks it interviews you first; force that with Ask + spec.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {draft && <p className="text-sm text-ink">{draft.goal}</p>}
      <ol data-testid="plan-list" className="flex flex-col">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5 py-1">
            <span className="pt-0.5 font-mono text-xs tabular-nums text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-sm text-ink-muted">{step}</span>
          </li>
        ))}
      </ol>
      {draft && draft.filesAffected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {draft.filesAffected.map((file) => (
            <span key={file} className="rounded border border-seam px-1.5 py-0.5 font-mono text-xs text-route">
              {file}
            </span>
          ))}
        </div>
      )}
      {draft && draft.risks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {draft.risks.map((risk, i) => (
            <li key={i} className="flex items-start gap-2">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-caution" />
              <span className="text-sm text-ink-muted">{risk}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TraceTab({ trace, timeline, streamLive }: {
  trace: string[];
  timeline: TimelineItem[];
  streamLive: boolean;
}) {
  if (timeline.length > 0) return <TraceTimeline items={timeline} streamLive={streamLive} />;
  if (trace.length === 0) return <Empty text="No output yet." />;
  return (
    <div className="overflow-y-auto p-3 font-mono text-xs text-ink-muted" data-testid="trace-list">
      {trace.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+")) return "text-go bg-go/10"; // added
  if (line.startsWith("-")) return "text-danger bg-danger/10"; // removed
  if (line.startsWith("@@")) return "text-route"; // hunk header
  return "text-ink-faint"; // context
}

/** "+N / -M" per file: patch lines starting with +/-, excluding the +++/---
 *  file headers (which are metadata, not changes). */
function patchStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** Real new-file line numbers walked from the @@ hunk headers: context and
 *  "+" rows carry the new-file number, "-" rows belong to the old file and
 *  stay blank. Hunk headers themselves get no number. */
function newFileLineNumbers(lines: string[]): (number | null)[] {
  let newLine: number | null = null;
  return lines.map((line) => {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? \+@@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      return null;
    }
    if (newLine === null) return null;
    if (line.startsWith("-")) return null;
    const n = newLine;
    newLine = n + 1;
    return n;
  });
}

export function DiffTab({ diff }: { diff: { path: string; patch: string }[] }) {
  // Which file's patch was just copied — drives the brief Check swap.
  const [copied, setCopied] = useState<number | null>(null);
  if (diff.length === 0) {
    return (
      <div className="max-w-prose p-3 text-sm text-ink-faint">
        <p>No diff yet.</p>
        <p>When the agent finishes, the changes to review land here.</p>
      </div>
    );
  }
  // diff-line-<i> is a GLOBAL running index across all files' lines.
  let lineIndex = 0;
  return (
    <div className="flex flex-col gap-2 p-3">
      {diff.map((file, fi) => {
        const lines = file.patch.split("\n");
        const numbers = newFileLineNumbers(lines);
        const base = lineIndex;
        lineIndex += lines.length;
        const { added, removed } = patchStats(file.patch);
        return (
          <details key={`${file.path}-${fi}`} open={fi === 0} className="rounded border border-seam">
            <summary className="flex cursor-pointer items-center gap-2 py-1.5 marker:hidden [&::-webkit-details-marker]:hidden transition-colors duration-150 hover:bg-panel">
              <FileCode2 aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 truncate font-mono text-xs text-ink">{file.path}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-go">+{added}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-danger">-{removed}</span>
              <button
                type="button"
                data-testid={`copy-patch-${fi}`}
                aria-label="Copy patch"
                className="ml-auto shrink-0 rounded p-0.5 text-ink-faint transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                onClick={(e) => {
                  // A copy click must not fold the file card (default on a
                  // summary click toggles <details>).
                  e.preventDefault();
                  e.stopPropagation();
                  navigator.clipboard
                    .writeText(file.patch)
                    .then(() => {
                      setCopied(fi);
                      // Brief feedback: the check reverts to the copy glyph.
                      setTimeout(() => setCopied((c) => (c === fi ? null : c)), 1500);
                    })
                    .catch(() => setCopied(null));
                }}
              >
                {copied === fi ? (
                  <Check aria-hidden className="size-3.5 text-go" />
                ) : (
                  <Copy aria-hidden className="size-3.5" />
                )}
              </button>
            </summary>
            <pre data-testid="diff-list" className="overflow-x-auto p-2 font-mono text-xs leading-5">
              {lines.map((line, li) => (
                <div key={li} data-testid={`diff-line-${base + li}`} className={`flex ${lineClass(line)}`}>
                  <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-ink-faint">
                    {numbers[li] ?? ""}
                  </span>
                  <span className="whitespace-pre">{line}</span>
                </div>
              ))}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-3 text-sm text-ink-faint">{text}</p>;
}
