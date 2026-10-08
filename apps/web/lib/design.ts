import type { ThreadStatus } from "@aelvyril/shared";

/**
 * The dispatch desk's shared vocabulary: every thread status renders as a
 * signal aspect (a lamp color + emphasis), never as an ad-hoc color. The
 * yellow "Needs you" aspect is NOT part of this map — it belongs to the
 * blocked band, which is a state, not a lifecycle status.
 */
export const STATUS_META: Record<
  ThreadStatus,
  { label: string; lampClass: string; textClass: string; pulse?: boolean }
> = {
  draft: { label: "draft", lampClass: "bg-lamp-off", textClass: "text-ink-faint" },
  queued: { label: "queued", lampClass: "border border-caution bg-transparent", textClass: "text-caution" },
  "spec'ing": { label: "spec'ing", lampClass: "bg-caution", textClass: "text-caution", pulse: true },
  // Railway-true: a green aspect means the route is clear and the train is
  // moving on it. Blue is reserved for the route line itself and primary
  // actions — not for the running lamp.
  running: { label: "running", lampClass: "bg-go", textClass: "text-go", pulse: true },
  reviewed: { label: "reviewed", lampClass: "bg-go", textClass: "text-go" },
  merged: { label: "merged", lampClass: "border border-go bg-transparent", textClass: "text-go" },
  abandoned: { label: "abandoned", lampClass: "bg-danger", textClass: "text-danger" },
};

/** Route stations the thread line walks through, in order. A station lights
 *  when its phase is active; passed stations stay lit dim; future ones are
 *  dark. draft/queued/abandoned map to no lit station beyond SPEC. */
export const ROUTE_STATIONS = ["spec", "run", "verify", "review", "merge"] as const;
export type RouteStation = (typeof ROUTE_STATIONS)[number];

export function routePosition(status: ThreadStatus): { reached: RouteStation; active: RouteStation | null } {
  switch (status) {
    case "draft":
      return { reached: "spec", active: null };
    case "queued":
      return { reached: "spec", active: null };
    case "spec'ing":
      return { reached: "spec", active: "spec" };
    case "running":
      return { reached: "run", active: "run" };
    case "reviewed":
      return { reached: "review", active: "review" };
    case "merged":
      return { reached: "merge", active: "merge" };
    case "abandoned":
      return { reached: "spec", active: null };
  }
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function fmtTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tok`;
  return `${total} tok`;
}

/** "just now" / "3m" / "2h" / "5d" — board-clock style, no "ago" noise. */
export function fmtRelTime(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

/** Milliseconds between two ISO timestamps, for tool durations. */
export function fmtDuration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human words for a tool call's JSON args — first scalar values only. */
export function summarizeArgs(json: string, max = 64): string {
  if (!json) return "";
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null) return "null";
    if (typeof parsed === "string") return trunc(parsed, max);
    if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
    if (Array.isArray(parsed)) return trunc(parsed.map((v) => summarizeArgs(JSON.stringify(v), 24)).join(", "), max);
    const obj = parsed as Record<string, unknown>;
    const parts = Object.entries(obj)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}: ${trunc(String(v), 32)}`);
    return trunc(parts.join(" · ") || json, max);
  } catch {
    return trunc(json, max);
  }
}

function trunc(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
