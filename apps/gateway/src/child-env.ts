/**
 * Review P1: the exact process.env keys a session-host child may inherit.
 * Children used to get `{ ...process.env }`, leaking operator secrets
 * (CLERK_*, GATEWAY_*) into every pi process. Only baseline OS vars, LLM
 * provider config, and the per-thread namespace key pass through.
 *
 * Own module (extracted from app.ts) so non-app code paths — the auto-verify
 * exec in verify.ts — enforce the same boundary.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  // LLM provider config for real pi sessions.
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  // D7: per-thread namespace key plumbed to the session host.
  "LAPIS_PROJECT_KEY",
  // ADR-0004 contract: the LaPis pi extension resolves its data root from
  // LAPIS_HOME at module load INSIDE each spawned child. The compose stack
  // sets it on the gateway process; without this entry the allowlist strips
  // it and agent memory silently misses the /data/lapis volume.
  "LAPIS_HOME",
];

/** Keys that must never reach a child, even via the opt-in extra allowlist. */
export const CHILD_ENV_NEVER = /^(CLERK_|GATEWAY_)/;

/**
 * Computes the child spawn env: the base allowlist ∪ the caller's opt-in
 * extra keys ∪ extraEnv (gateway-controlled, e.g. LAPIS_PROJECT_KEY).
 */
export function computeChildEnv(
  extraEnv: Record<string, string>,
  extraAllowlist: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...CHILD_ENV_ALLOWLIST, ...extraAllowlist]) {
    if (CHILD_ENV_NEVER.test(key)) continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extraEnv };
}
