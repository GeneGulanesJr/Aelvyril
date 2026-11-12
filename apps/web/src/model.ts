// Pure decisions behind the Stream / Tasks shell (Quick is the Ctrl/Cmd+K pop-up). No DOM, so node:test can import it.
import type { ThreadRow } from "./api.ts";
import type { Item, JobState } from "./transcript.ts";

// ---------------------------------------------------------------- views
/** The switcher, the swipe and the view panels all read this list: a further view is one more entry. */
export const VIEWS = [
  { id: "stream", label: "Stream" },
  { id: "inbox", label: "Tasks" },
] as const;
export type ViewId = (typeof VIEWS)[number]["id"];

export const isView = (v: unknown): v is ViewId => VIEWS.some((x) => x.id === v);

/** The view next to `v` in a direction, or null at either end. */
export function neighbour(v: ViewId, dir: 1 | -1): ViewId | null {
  const i = VIEWS.findIndex((x) => x.id === v) + dir;
  return i >= 0 && i < VIEWS.length ? VIEWS[i].id : null;
}

// ---------------------------------------------------------------- first-timer rule
const FINISHED = new Set(["done", "failed", "stopped"]);

/**
 * Until a task has finished, the person sees only the Stream and its box.
 * Older chats from before also count: someone who has them has used the app already.
 * Once unlocked it stays unlocked (`remembered`), even if the tasks are deleted later.
 */
export function isUnlocked(threads: Pick<ThreadRow, "kind" | "status">[], remembered = false): boolean {
  if (remembered) return true;
  return threads.some((t) => (t.kind === "job" && FINISHED.has(t.status)) || t.kind === "chat");
}

// ---------------------------------------------------------------- inbox groups
export interface Groups {
  needsYou: ThreadRow[];
  working: ThreadRow[];
  done: ThreadRow[];
  chats: ThreadRow[];
}

/** Tasks by what the person should do about them. The Stream itself is never listed. */
export function groupTasks(threads: ThreadRow[], doneLimit = 20): Groups {
  const g: Groups = { needsYou: [], working: [], done: [], chats: [] };
  const sorted = [...threads].sort((a, b) => b.updated_at - a.updated_at);
  for (const t of sorted) {
    if (t.kind === "main") continue;
    if (t.status === "needs_you") g.needsYou.push(t);
    else if (t.kind === "chat") g.chats.push(t);
    else if (t.status === "working") g.working.push(t);
    else g.done.push(t);
  }
  g.done = g.done.slice(0, doneLimit);
  return g;
}

// ---------------------------------------------------------------- projects (the Tasks kanban)
export const COLUMNS = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "done", title: "Done" },
] as const;
export type Column = (typeof COLUMNS)[number]["key"];

/** The kanban column for a status: needs you, working, or done (finished, failed and stopped alike). */
export const columnOf = (s: ThreadRow["status"]): Column => (s === "needs_you" ? "needs" : s === "working" ? "working" : "done");

export interface Project {
  name: string;
  /** Newest first. */
  tasks: ThreadRow[];
  /** The column of its most urgent task. */
  column: Column;
}

/** Tasks grouped by their board, as projects: most urgent first, then the most recently busy. Older chats are one project of their own. */
export function projects(threads: ThreadRow[]): Project[] {
  const by = new Map<string, ThreadRow[]>();
  for (const t of [...threads].sort((a, b) => b.updated_at - a.updated_at)) {
    if (t.kind === "main") continue;
    const name = t.kind === "chat" ? "Older chats" : t.board?.trim() || "General";
    by.set(name, [...(by.get(name) ?? []), t]);
  }
  const rank = { needs: 0, working: 1, done: 2 } as const;
  return [...by].map(([name, tasks]) => {
    const cols = tasks.map((t) => columnOf(t.status));
    const column: Column = cols.includes("needs") ? "needs" : cols.includes("working") ? "working" : "done";
    return { name, tasks, column };
  }).sort((a, b) => rank[a.column] - rank[b.column] || b.tasks[0].updated_at - a.tasks[0].updated_at);
}

/** Tasks and chats waiting on the person, oldest first so the longest wait is named first. */
export const waitingOnYou = (threads: ThreadRow[]) =>
  threads.filter((t) => t.kind !== "main" && t.status === "needs_you").sort((a, b) => a.updated_at - b.updated_at);

// ---------------------------------------------------------------- task status words
export type Status = ThreadRow["status"];

export const STATUS_WORD: Record<Status, string> = {
  working: "Working",
  needs_you: "Needs your OK",
  done: "Done",
  failed: "Couldn't finish",
  stopped: "Stopped",
};

/** The card in the Stream knows the state from the Stream's own events; the 4-second list may be newer. */
export function cardStatus(item: Pick<Extract<Item, { kind: "job" }>, "state">, row?: Pick<ThreadRow, "status">): Status {
  return (row?.status ?? item.state) as JobState;
}

/** The gateway words a failure for the model ("The job failed: ..."); people see "task". */
export function plainPreview(s: string): string {
  return s.replace(/^The job failed:\s*/i, "Couldn't finish: ");
}

/** One polite sentence per change, for the screen reader. Nothing on the first load. */
export function announcements(prev: ThreadRow[] | null, next: ThreadRow[]): string[] {
  if (!prev) return [];
  const before = new Map(prev.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const t of next) {
    if (t.kind === "main") continue;
    const p = before.get(t.id);
    if (!p) {
      if (t.kind === "job") out.push(t.status === "needs_you" ? `${t.title} needs your OK` : `Started a task: ${t.title}`);
      continue;
    }
    if (p.status === t.status) continue;
    if (t.status === "needs_you") out.push(`${t.title} needs your OK`);
    else if (t.status === "done") out.push(`${t.title} is done`);
    else if (t.status === "failed") out.push(`${t.title} couldn't finish`);
    else if (t.status === "stopped") out.push(`${t.title} was stopped`);
    else if (t.status === "working" && p.status === "needs_you") out.push(`${t.title} is working again`);
  }
  return out;
}

// ---------------------------------------------------------------- day separators
export type Day = { kind: "day"; key: string; label: string };

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", or a date ("Monday 3 March", with the year when it isn't this year). */
export function dayLabel(ms: number, now: number, locale?: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * Puts a day separator before the first item of each day. Items without a time (task cards,
 * notices) belong to the day of the item before them; leading items without one belong to
 * the first day that is known.
 */
export function withDays<T extends { key: string; at?: number }>(items: T[], now: number, locale?: string): (T | Day)[] {
  const out: (T | Day)[] = [];
  const firstAt = items.find((i) => typeof i.at === "number")?.at;
  if (firstAt === undefined) return [...items];
  let current = startOfDay(firstAt);
  out.push({ kind: "day", key: `day-${current}`, label: dayLabel(firstAt, now, locale) });
  for (const it of items) {
    if (typeof it.at === "number" && startOfDay(it.at) !== current) {
      current = startOfDay(it.at);
      out.push({ kind: "day", key: `day-${current}`, label: dayLabel(it.at, now, locale) });
    }
    out.push(it);
  }
  return out;
}

/** "just now", "5 min ago", "3 h ago", or a short date. */
export function ago(ms: number, now: number, locale?: string): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400 && startOfDay(ms) === startOfDay(now)) return `${Math.floor(s / 3600)} h ago`;
  if (startOfDay(now) - startOfDay(ms) === 86_400_000) return "yesterday";
  return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

// ---------------------------------------------------------------- swipe
export type Axis = "pending" | "x" | "y";

/** Decide early whether a touch is a sideways swipe or a scroll. 10px of travel before deciding. */
export function swipeAxis(dx: number, dy: number, slop = 10): Axis {
  if (Math.hypot(dx, dy) < slop) return "pending";
  return Math.abs(dx) > Math.abs(dy) * 1.4 ? "x" : "y";
}

/**
 * When the finger lifts: move to the next view (+1, swiped left), the previous one (-1), or stay (0).
 * A quarter of the width, or a quick flick of 40px or more, is enough. No move past either end.
 */
export function swipeResult(dx: number, width: number, ms: number, canPrev: boolean, canNext: boolean): -1 | 0 | 1 {
  const far = Math.abs(dx) >= width * 0.25;
  const flick = Math.abs(dx) >= 40 && Math.abs(dx) / Math.max(ms, 1) > 0.45;
  if (!far && !flick) return 0;
  if (dx < 0 && canNext) return 1;
  if (dx > 0 && canPrev) return -1;
  return 0;
}

/** Drag offset shown under the finger; pulls with resistance at an end so it can't be dragged away. */
export const dragOffset = (dx: number, canPrev: boolean, canNext: boolean) => ((dx > 0 && !canPrev) || (dx < 0 && !canNext) ? dx / 4 : dx);

// ---------------------------------------------------------------- steps
/** A step in plain words ("Ran a command", "Wrote weather.ts") and the one detail that says which. */
export function stepWords(name: string, args: unknown): { what: string; detail: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const file = str(a.path) || str(a.file_path) || str(a.file);
  const base = file.split("/").filter(Boolean).pop() ?? "";
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell") return { what: "Ran a command", detail: str(a.command).split("\n")[0] };
  if (n === "write") return { what: base ? `Wrote ${base}` : "Wrote a file", detail: file };
  if (n === "edit") return { what: base ? `Edited ${base}` : "Edited a file", detail: file };
  if (n === "read") return { what: base ? `Read ${base}` : "Read a file", detail: file };
  if (n === "grep" || n === "find" || n === "ls" || n === "glob") return { what: "Looked through files", detail: str(a.pattern) || str(a.path) };
  if (n.includes("fetch") || n.includes("web") || n.includes("search")) return { what: "Looked something up", detail: str(a.url) || str(a.query) };
  if (n.startsWith("memory")) return { what: "Used its memory", detail: str(a.title) || str(a.query) };
  return { what: name.replace(/[-_]/g, " "), detail: Object.values(a).map((v) => (typeof v === "string" ? v : "")).find(Boolean) ?? "" };
}

// ---------------------------------------------------------------- greeting
export function greeting(hour: number): string {
  if (hour < 5) return "Hello, night owl.";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export const SUGGESTIONS = ["Summarize something for me", "Help me plan my week", "Draft an email", "Explain something simply"];

// ---------------------------------------------------------------- the home board: tiles on a 12-column grid
export const GRID_COLS = 12;
export interface Tile { id: string; x: number; y: number; w: number; h: number }
export type Layout = Record<string, Omit<Tile, "id">>;
const overlaps = (a: Tile, b: Tile) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fit = (t: Tile): Tile => {
  const w = Math.min(GRID_COLS, Math.max(1, Math.round(t.w)));
  return { id: t.id, w, h: Math.max(1, Math.round(t.h)), x: Math.min(GRID_COLS - w, Math.max(0, Math.round(t.x))), y: Math.max(0, Math.round(t.y)) };
};

/** Lays tiles out so none overlap, inside the grid. `first` (the one being moved) keeps its spot; the others keep theirs
    where they can and move down where they can't. Same order out as in. */
export function settle(tiles: Tile[], first?: string): Tile[] {
  const order = tiles.map(fit).sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.y - b.y || a.x - b.x));
  const placed: Tile[] = [];
  for (let t of order) {
    while (placed.some((p) => overlaps(p, t))) t = { ...t, y: t.y + 1 };
    placed.push(t);
  }
  return tiles.map((t) => placed.find((p) => p.id === t.id)!);
}

/** Where every item goes: its saved spot, else its default spot if free, else the first free place (top to bottom, left to right). */
export function arrange(items: { id: string; w: number; h: number; x?: number; y?: number }[], saved: Layout): Tile[] {
  const out = settle(items.filter((i) => saved[i.id]).map((i) => ({ id: i.id, ...saved[i.id] })));
  const free = (c: Tile) => !out.some((p) => overlaps(p, c));
  for (const i of items) {
    if (saved[i.id]) continue;
    const w = Math.min(GRID_COLS, i.w);
    let spot: Tile | undefined = i.x !== undefined && i.y !== undefined ? fit({ id: i.id, x: i.x, y: i.y, w, h: i.h }) : undefined;
    if (spot && !free(spot)) spot = undefined;
    for (let y = 0; !spot; y++) for (let x = 0; x + w <= GRID_COLS && !spot; x++) if (free({ id: i.id, x, y, w, h: i.h })) spot = { id: i.id, x, y, w, h: i.h };
    out.push(spot);
  }
  return items.map((i) => out.find((t) => t.id === i.id)!);
}
