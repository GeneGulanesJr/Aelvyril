// Decides whether a prompt should enter the spec interview before execution
// (agent spec-centric UI, Slice 2). Pure function — no I/O, no state.

type SpecMode = "auto" | "force" | "off";

/** Breadth words: mentions of artifacts/systems imply a multi-part ask. */
const FEATURE_WORDS =
  /\b(file|files|system|feature|features|page|pages|screen|screens|endpoint|endpoints|model|models|schema|table|tables|column|columns|route|routes|component|components|module|modules)\b/gi;
/** Imperative build-verbs. */
const IMPERATIVE_VERBS =
  /\b(build|create|add|integrate|implement|setup|configure|migrate|refactor|rewrite|design|develop|deploy|wire|connect|scaffold|generate)\b/gi;
const SENTENCE_TERMINATOR = /[.!?](\s|$)/;

export function shouldEnterSpecMode(prompt: string, mode: SpecMode): boolean {
  if (mode === "off") return false;
  if (mode === "force") return true;
  // Kill switch: GATEWAY_SPEC_HEURISTIC=off forces auto → never triggers.
  // Read at call time (not module load) so tests can toggle it.
  if (process.env.GATEWAY_SPEC_HEURISTIC === "off") return false;

  // auto mode: an imperative verb inside a multi-part sentence (>= 6 words)
  // smells like a feature ask, not a quick edit; so do 2+ breadth words or
  // 2+ build verbs. Plain renames/lookups have neither.
  const featureHits = (prompt.match(FEATURE_WORDS) ?? []).length;
  const verbHits = (prompt.match(IMPERATIVE_VERBS) ?? []).length;
  const wordCount = prompt.trim().split(/\s+/).length;
  const isSingleSentence = !SENTENCE_TERMINATOR.test(prompt);
  return (
    featureHits >= 2 ||
    verbHits >= 2 ||
    (verbHits >= 1 && wordCount >= 6) ||
    (isSingleSentence && prompt.length > 200)
  );
}
