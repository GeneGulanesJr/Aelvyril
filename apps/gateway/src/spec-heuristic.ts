export type SpecMode = "auto" | "force" | "off";

// FEATURE_WORDS diverges from plan literal list — extended with UI/auth/multi-tenant
// domain nouns (`dashboard`, `access`, `login`, `logout`, `email`, `verification`,
// `integration`, `management`, `tenant`) so spec prompts about real features trigger.
// Plan list was backend-leaning; these words appear in real multi-feature asks.
const FEATURE_WORDS =
  /\b(file|files|system|feature|features|page|pages|screen|screens|endpoint|endpoints|model|models|schema|table|tables|column|columns|route|routes|component|components|module|modules|dashboard|access|login|logout|email|verification|integration|management|tenant|tenants)\b/gi;
const IMPERATIVE_VERBS =
  /\b(build|create|add|integrate|implement|setup|configure|migrate|refactor|rewrite|design|develop|deploy|wire|connect|scaffold|generate)\b/gi;
const SENTENCE_TERMINATOR = /[.!?](\s|$)/;

export function shouldEnterSpecMode(prompt: string, mode: SpecMode): boolean {
  // Env-var override is read on every call (not captured at module load) so tests
  // can toggle GATEWAY_SPEC_HEURISTIC mid-run. See plan §5.1.
  const heuristicOff = process.env.GATEWAY_SPEC_HEURISTIC === "off";
  if (mode === "off" || heuristicOff) return false;
  if (mode === "force") return true;
  // auto mode:
  const featureHits = (prompt.match(FEATURE_WORDS) ?? []).length;
  const verbHits = (prompt.match(IMPERATIVE_VERBS) ?? []).length;
  const isSingleSentence = !SENTENCE_TERMINATOR.test(prompt);
  return featureHits >= 2 || verbHits >= 2 || (isSingleSentence && prompt.length > 200);
}