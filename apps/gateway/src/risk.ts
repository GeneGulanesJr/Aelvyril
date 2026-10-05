// #81: risk-class gating. Autonomy is decided per ACTION CLASS, not per
// plan: reversible workspace-scoped edits auto-run and get post-hoc diff
// review; only irreversible/external actions (installs, migrations,
// deletes, sandbox promotes, deploys) gate on explicit approval. Pure
// functions — no I/O, no state — so the classifier is trivially testable
// and usable both on the live tool stream and on a spec draft's plan.

export type RiskClass = "reversible" | "external" | "irreversible";

/**
 * Trust escalation (#81.3): a namespace's track record of merges without
 * revision raises the default autonomy. "standard" gates external actions;
 * "established" auto-runs them (irreversible actions stay gated forever).
 */
export type Autonomy = "standard" | "established";

export interface RiskVerdict {
  cls: RiskClass;
  /** True when the action requires explicit approval before it runs. */
  gated: boolean;
  reason: string;
}

export interface AutonomyInput {
  autonomy: Autonomy;
}

/** Editing/reading tools pi uses inside the workspace — always reversible. */
const REVERSIBLE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "grep",
  "glob",
  "find",
  "ls",
  "list",
  "move",
  "rename",
]);

/** Tool names that are irreversible or leave the workspace by definition. */
const GATED_TOOLS = new Set(["sandbox_promote", "deploy", "publish", "release"]);

/**
 * Shell-level patterns that are irreversible or external. Matched against
 * the command string of bash/shell/execute-style tools. `npm|pnpm|yarn
 * install` is EXTERNAL (network + dependency supply chain) — the issue
 * lists installs explicitly; at "established" trust they auto-run.
 */
const IRREVERSIBLE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: "recursive delete" },
  { re: /\brm\s+-[a-z]*r[a-z]*f/i, why: "recursive force delete" },
  { re: /\bgit\s+push\b/i, why: "publishes commits to a remote" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "discards working-tree changes" },
  { re: /\bgit\s+clean\b/i, why: "deletes untracked files" },
  { re: /\bdrop\s+(table|database|schema)\b/i, why: "destructive SQL" },
  { re: /\btruncate\s+table\b/i, why: "destructive SQL" },
  { re: /\b(migrate|migration)\b.*\b(rollback|down|reset)\b/i, why: "migration rollback/reset" },
  { re: /\bkubectl\s+(delete|apply|rollout)\b/i, why: "cluster mutation" },
  { re: /\b(terraform|tofu)\s+(apply|destroy)\b/i, why: "infrastructure mutation" },
  { re: /\bdeploy(ment)?\b/i, why: "deployment is irreversible" },
];

const EXTERNAL_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade)\b/i, why: "installs dependencies (external)" },
  { re: /\bpip\s+install\b/i, why: "installs dependencies (external)" },
  { re: /\bcurl\b|\bwget\b/i, why: "outbound network fetch" },
  { re: /\bmigrate\b|\bmigration\b/i, why: "schema migration" },
  { re: /\bgh\s+(pr|release|repo)\b/i, why: "external GitHub mutation" },
];

const SHELL_TOOLS = new Set(["bash", "sh", "shell", "execute", "exec", "terminal", "command", "run_command"]);

function firstArgString(args: unknown): string {
  if (args === null || args === undefined || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "argv"]) {
    const v = a[key];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join(" ");
  }
  return "";
}

function classifyShellCommand(command: string, autonomy: Autonomy): RiskVerdict | null {
  for (const { re, why } of IRREVERSIBLE_PATTERNS) {
    if (re.test(command)) {
      return { cls: "irreversible", gated: true, reason: why };
    }
  }
  for (const { re, why } of EXTERNAL_PATTERNS) {
    if (re.test(command)) {
      // Trust escalation (#81.3): established namespaces auto-run external
      // (but still reversible) actions; fresh ones gate them.
      if (autonomy === "established") {
        return { cls: "external", gated: false, reason: `${why} — auto-run at established trust` };
      }
      return { cls: "external", gated: true, reason: why };
    }
  }
  return null;
}

/**
 * Classify one live tool call. Everything not matched as gated is treated
 * as reversible workspace work — it auto-runs and lands in the post-hoc
 * diff review, which is the point of #81: decision load must not grow
 * linearly with asks.
 */
export function classifyAction(
  toolName: string,
  args: unknown,
  { autonomy }: AutonomyInput,
): RiskVerdict {
  const name = toolName.toLowerCase();
  if (GATED_TOOLS.has(name)) {
    return { cls: "irreversible", gated: true, reason: `${name} is irreversible by definition` };
  }
  if (SHELL_TOOLS.has(name)) {
    const shellVerdict = classifyShellCommand(firstArgString(args), autonomy);
    if (shellVerdict) return shellVerdict;
  }
  if (REVERSIBLE_TOOLS.has(name)) {
    return { cls: "reversible", gated: false, reason: "workspace-scoped edit/read" };
  }
  // Unknown tool with no shell payload: assume reversible (post-hoc review
  // catches abuse); unknown tools carrying a shell-looking command still get
  // the pattern scan.
  const shellVerdict = classifyShellCommand(firstArgString(args), autonomy);
  if (shellVerdict) return shellVerdict;
  return { cls: "reversible", gated: false, reason: "no gated pattern matched" };
}

export interface PlanRiskItem {
  item: string;
  cls: RiskClass;
  reason: string;
}

export interface PlanVerdict {
  gated: boolean;
  items: PlanRiskItem[];
}

/**
 * Classify a spec draft's plan before execution (#81.1): the thread gates
 * only when the PLAN itself contains gated steps; an all-reversible plan
 * auto-runs and the user reviews the diff afterwards.
 */
export function classifyPlan(plan: string[], input: AutonomyInput): PlanVerdict {
  const items: PlanRiskItem[] = [];
  for (const step of plan) {
    // Plan steps are prose; reuse the shell scanner for signal words plus
    // the explicit gated-tool names. Only GATED verdicts become items — a
    // non-gated external step (established trust) must not gate the plan.
    const shellVerdict = classifyShellCommand(step, input.autonomy);
    if (shellVerdict) {
      if (shellVerdict.gated) {
        items.push({ item: step, cls: shellVerdict.cls, reason: shellVerdict.reason });
      }
      continue;
    }
    const lower = step.toLowerCase();
    const gatedTool = [...GATED_TOOLS].find((t) => lower.includes(t));
    if (gatedTool) {
      items.push({ item: step, cls: "irreversible", reason: `plan step uses ${gatedTool}` });
    }
  }
  return { gated: items.length > 0, items };
}
