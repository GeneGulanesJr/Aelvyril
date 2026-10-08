"use client";
import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { SpecDraft, SpecQuestion, ThreadStatus } from "@aelvyril/shared";

const SPEC_FIELDS = ["goal", "filesAffected", "plan", "risks"] as const;
type SpecFieldKey = (typeof SPEC_FIELDS)[number];

/** Debounce window for PATCH /v1/threads/:id/spec — one request per typing
 *  burst instead of one per keystroke. */
const SPEC_PATCH_DEBOUNCE_MS = 400;

const EMPTY_TEXTS: Record<SpecFieldKey, string> = {
  goal: "",
  filesAffected: "",
  plan: "",
  risks: "",
};

/** Wire draft → the exact text shapes the inputs render. */
function draftToText(draft: SpecDraft): Record<SpecFieldKey, string> {
  return {
    goal: draft.goal,
    filesAffected: draft.filesAffected.join(", "),
    plan: draft.plan.join("\n"),
    risks: draft.risks.join("\n"),
  };
}

/** Editable text → PatchSpecBody value (unchanged wire shapes). */
function textToValue(field: SpecFieldKey, text: string): string | string[] {
  if (field === "filesAffected") return text.split(",").map((s) => s.trim());
  if (field === "plan" || field === "risks") return text.split("\n");
  return text;
}

export function SpecSession({
  questions, draft, status, forceVisible = false,
  onSubmitAnswers, onEditSpec, onApprove, onCancel,
}: {
  questions: SpecQuestion[]; draft: SpecDraft | null; status: ThreadStatus;
  /** #81: keep the approve control reachable during a gated stop. */
  forceVisible?: boolean;
  onSubmitAnswers: (a: Record<string, string>) => void;
  onEditSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Spec fields are owned locally: the draft prop only seeds/reconciles them.
  // A controlled-by-props input would revert in-progress typing on every SSE
  // envelope re-render and fire a PATCH per keystroke.
  const [fields, setFields] = useState<Record<SpecFieldKey, string>>(() =>
    draft ? draftToText(draft) : EMPTY_TEXTS,
  );
  // Field the user is currently in — reconciliation never touches it. A ref
  // (not state) so focus changes don't re-run the reconciliation effect.
  const editingRef = useRef<SpecFieldKey | null>(null);
  // Text values last accepted by the server (via onEditSpec). An incoming
  // draft equal to these is just the echo of our own PATCH, not a re-draft.
  const lastSentRef = useRef<Record<SpecFieldKey, string>>(draft ? draftToText(draft) : EMPTY_TEXTS);
  // Unsent edits (debounce window) — flushed by the timer or on blur.
  const pendingRef = useRef<Partial<Record<SpecFieldKey, string>>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = () => {
    const pending = pendingRef.current;
    pendingRef.current = {};
    for (const field of SPEC_FIELDS) {
      const text = pending[field];
      if (text === undefined) continue;
      onEditSpec(field, textToValue(field, text));
      lastSentRef.current[field] = text;
    }
  };

  // Reconcile from incoming spec_draft envelopes, but only where it's safe:
  // skip the field under edit (an agent re-draft must not yank mid-typing)
  // and skip echoes of values we already sent.
  useEffect(() => {
    if (!draft) return;
    const incoming = draftToText(draft);
    setFields((prev) => {
      let next: Record<SpecFieldKey, string> | null = null;
      for (const field of SPEC_FIELDS) {
        if (field === editingRef.current) continue;
        if (incoming[field] === lastSentRef.current[field]) continue;
        if (incoming[field] === prev[field]) {
          // Already showing this value (e.g. a repeated agent draft) — record
          // it so future echoes short-circuit too.
          lastSentRef.current[field] = incoming[field];
          continue;
        }
        next ??= { ...prev };
        next[field] = incoming[field];
        lastSentRef.current[field] = incoming[field];
        delete pendingRef.current[field];
      }
      return next ?? prev;
    });
  }, [draft]);

  // Drop the pending PATCH when the component goes away (thread switch remounts
  // us via key=id) — sending after unmount would target a stale context.
  useEffect(() => () => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
  }, []);

  const handleFieldChange = (field: SpecFieldKey, text: string) => {
    editingRef.current = field;
    setFields((prev) => ({ ...prev, [field]: text }));
    pendingRef.current[field] = text;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      flushPending();
    }, SPEC_PATCH_DEBOUNCE_MS);
  };

  const handleFieldBlur = () => {
    editingRef.current = null;
    // Leaving the field sends immediately — otherwise a fast agent re-draft
    // could land inside the debounce window and race the user's edit.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    flushPending();
  };

  if (status !== "spec'ing" && !forceVisible) return null;

  const hasQuestions = questions.length > 0;

  return (
    <div className="border-t border-caution/40 bg-panel-raised p-4 text-sm" data-testid="spec-session">
      {(hasQuestions || draft) && (
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden className="size-2 animate-lamp-pulse rounded-full bg-caution" />
          <span className="font-mono text-xs uppercase tracking-wider text-caution">
            {hasQuestions ? "Spec interview" : "Draft under negotiation"}
          </span>
        </div>
      )}
      {hasQuestions && (
        <div>
          {questions.map((q) => (
            <div className="mb-3" key={q.id}>
              <label className="mb-1.5 block text-sm text-ink" htmlFor={`spec-q-${q.id}`}>{q.prompt}</label>
              {q.kind === "select" && q.options ? (
                <select
                  className="w-full rounded-md border border-seam bg-panel px-2.5 py-1.5 text-sm transition-colors focus:border-route"
                  data-testid={`q-${q.id}`}
                  id={`spec-q-${q.id}`}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                >
                  <option value="">—</option>
                  {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="w-full rounded-md border border-seam bg-panel px-2.5 py-1.5 text-sm transition-colors focus:border-route"
                  data-testid={`q-${q.id}`}
                  id={`spec-q-${q.id}`}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  value={answers[q.id] ?? ""}
                />
              )}
            </div>
          ))}
          <button
            className="rounded-md bg-route px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-route/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="submit-answers"
            onClick={() => onSubmitAnswers(answers)}
            disabled={questions.some((q) => !answers[q.id])}
          >Submit answers</button>
        </div>
      )}
      {draft && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <SpecField label="Goal" value={fields.goal} testId="spec-goal" wide
            onChange={(v) => handleFieldChange("goal", v)}
            onFocus={() => { editingRef.current = "goal"; }} onBlur={handleFieldBlur} />
          <SpecField label="Files" value={fields.filesAffected} testId="spec-files"
            onChange={(v) => handleFieldChange("filesAffected", v)}
            onFocus={() => { editingRef.current = "filesAffected"; }} onBlur={handleFieldBlur} />
          <SpecField label="Plan" value={fields.plan} testId="spec-plan" multiline wide
            onChange={(v) => handleFieldChange("plan", v)}
            onFocus={() => { editingRef.current = "plan"; }} onBlur={handleFieldBlur} />
          <SpecField label="Risks" value={fields.risks} testId="spec-risks" multiline wide
            onChange={(v) => handleFieldChange("risks", v)}
            onFocus={() => { editingRef.current = "risks"; }} onBlur={handleFieldBlur} />
          <div className="flex gap-2 pt-1 md:col-span-2">
            <button className="inline-flex items-center gap-1.5 rounded-md bg-go px-3.5 py-1.5 text-sm font-semibold text-go-ink transition-colors hover:bg-go/90" data-testid="approve" onClick={onApprove}>
              <Play aria-hidden className="size-3.5" />
              Approve &amp; run
            </button>
            <button className="rounded-md border border-seam-strong px-3.5 py-1.5 text-sm text-ink-muted transition-colors hover:text-ink" data-testid="cancel" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SpecField({ label, value, onChange, onFocus, onBlur, testId, multiline, wide = false }: {
  label: string; value: string; onChange: (v: string) => void;
  onFocus: () => void; onBlur: () => void; testId: string; multiline?: boolean; wide?: boolean;
}) {
  return (
    <label className={wide ? "block md:col-span-2" : "block"}>
      <span className="mb-1 block text-xs font-mono uppercase tracking-wider text-ink-faint">{label}</span>
      {multiline ? (
        <textarea className="w-full rounded-md border border-seam bg-panel px-2.5 py-1.5 text-sm transition-colors focus:border-route" data-testid={testId} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} onBlur={onBlur} rows={3} value={value} />
      ) : (
        <input className="w-full rounded-md border border-seam bg-panel px-2.5 py-1.5 text-sm transition-colors focus:border-route" data-testid={testId} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} onBlur={onBlur} value={value} />
      )}
    </label>
  );
}
