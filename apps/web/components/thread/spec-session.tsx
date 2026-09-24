"use client";
import { useState } from "react";
import type { SpecDraft, SpecQuestion, ThreadStatus } from "@aelvyril/shared";

export function SpecSession({
  questions, draft, status,
  onSubmitAnswers, onEditSpec, onApprove, onCancel,
}: {
  questions: SpecQuestion[]; draft: SpecDraft | null; status: ThreadStatus;
  onSubmitAnswers: (a: Record<string, string>) => void;
  onEditSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (status !== "spec'ing") return null;

  return (
    <div className="border-t border-[#2b3245] bg-[#0d1117] p-3 text-sm" data-testid="spec-session">
      {questions.length > 0 && (
        <div className="space-y-2">
          {questions.map((q) => (
            <label key={q.id} className="block">
              <span className="block text-[#8b96a8]">{q.prompt}</span>
              {q.kind === "select" && q.options ? (
                <select
                  className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1"
                  data-testid={`q-${q.id}`}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                >
                  <option value="">—</option>
                  {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1"
                  data-testid={`q-${q.id}`}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  value={answers[q.id] ?? ""}
                />
              )}
            </label>
          ))}
          <button
            className="rounded bg-[#1f6feb] px-3 py-1 text-xs"
            data-testid="submit-answers"
            onClick={() => onSubmitAnswers(answers)}
            disabled={questions.some((q) => !answers[q.id])}
          >Submit answers</button>
        </div>
      )}
      {draft && (
        <div className="mt-3 space-y-2 border-t border-[#2b3245] pt-3">
          <SpecField label="Goal" value={draft.goal} onChange={(v) => onEditSpec("goal", v)} testId="spec-goal" />
          <SpecField label="Files" value={draft.filesAffected.join(", ")} onChange={(v) => onEditSpec("filesAffected", v.split(",").map((s) => s.trim()))} testId="spec-files" />
          <SpecField label="Plan" value={draft.plan.join("\n")} onChange={(v) => onEditSpec("plan", v.split("\n"))} testId="spec-plan" multiline />
          <SpecField label="Risks" value={draft.risks.join("\n")} onChange={(v) => onEditSpec("risks", v.split("\n"))} testId="spec-risks" multiline />
          <div className="flex gap-2 pt-2">
            <button className="rounded bg-[#3fb950] px-3 py-1 text-xs font-medium" data-testid="approve" onClick={onApprove}>Approve &amp; run</button>
            <button className="rounded border border-[#2b3245] px-3 py-1 text-xs" data-testid="cancel" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SpecField({ label, value, onChange, testId, multiline }: { label: string; value: string; onChange: (v: string) => void; testId: string; multiline?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs text-[#8b96a8]">{label}</span>
      {multiline ? (
        <textarea className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1 text-xs" data-testid={testId} onChange={(e) => onChange(e.target.value)} rows={3} value={value} />
      ) : (
        <input className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1 text-xs" data-testid={testId} onChange={(e) => onChange(e.target.value)} value={value} />
      )}
    </label>
  );
}
