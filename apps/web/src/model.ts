// Pure decisions behind the Stream / Inbox / Quick / Board shell. No DOM, so node:test can import it.
import { parsePanel, type Panel } from "@aelvyril/ui-schema";
import type { ThreadRow } from "./api.ts";
import type { Item, JobState } from "./transcript.ts";

// ---------------------------------------------------------------- views
/** The switcher, the swipe and the view panels all read this list: a further view is one more entry. */
export const VIEWS = [
  { id: "stream", label: "Stream" },
  { id: "inbox", label: "Inbox" },
  { id: "quick", label: "Quick" },
  { id: "board", label: "Board" },
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

export type Gesture = "pending" | "drag" | "swipe" | "scroll" | "none";

/**
 * Who owns a pointer on the Board. A card's drag handle always moves the card, in any direction
 * (4px of travel first, so a tap stays a tap). Anywhere else a touch that goes sideways swipes
 * between views and one that goes down scrolls; a mouse outside the handle does neither.
 * The two never mix: the handle is marked so the view swipe never starts there.
 */
export function gesture(fromHandle: boolean, touch: boolean, dx: number, dy: number): Gesture {
  if (fromHandle) return Math.hypot(dx, dy) < 4 ? "pending" : "drag";
  if (!touch) return "none";
  const axis = swipeAxis(dx, dy);
  return axis === "pending" ? "pending" : axis === "x" ? "swipe" : "scroll";
}

// ---------------------------------------------------------------- board
/** The Stream's own card on the Board. Task cards use the task id. */
export const STREAM_TILE = "stream";

export type BoardTask = { id: string; status: Status; updated_at: number };

/** Needs-you first (longest wait first), then everything else newest first. */
export function needsYouFirst<T extends BoardTask>(tasks: T[]): T[] {
  const needs = tasks.filter((t) => t.status === "needs_you").sort((a, b) => a.updated_at - b.updated_at);
  const rest = tasks.filter((t) => t.status !== "needs_you").sort((a, b) => b.updated_at - a.updated_at);
  return [...needs, ...rest];
}

/** The order before anyone arranged anything: the Stream, then needs-you, then newest. */
export const defaultOrder = (tasks: BoardTask[]) => [STREAM_TILE, ...needsYouFirst(tasks).map((t) => t.id)];

/** Puts ids in front of the first task card (the Stream card keeps its place). */
function atTaskFront(order: string[], ids: string[]): string[] {
  if (!ids.length) return order;
  const i = order.findIndex((id) => id !== STREAM_TILE);
  const at = i < 0 ? order.length : i;
  return [...order.slice(0, at), ...ids, ...order.slice(at)];
}

/**
 * The order to show, given the order shown before (or saved) and the tasks there are now.
 * Removed tasks drop out; the Stream card is always there.
 * Not arranged yet: new tasks come in at the front, and needs-you cards stay ahead of the rest.
 * Arranged by the person: their order holds. New needs-you tasks still come in at the front,
 * other new tasks go to the end, so nothing they placed moves under them.
 */
export function mergeOrder(prev: string[] | null, tasks: BoardTask[], arranged: boolean): string[] {
  if (!prev) return defaultOrder(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kept = prev.filter((id, i) => (id === STREAM_TILE || byId.has(id)) && prev.indexOf(id) === i);
  if (!kept.includes(STREAM_TILE)) kept.unshift(STREAM_TILE);
  const known = new Set(kept);
  const fresh = needsYouFirst(tasks.filter((t) => !known.has(t.id)));
  if (arranged) {
    const front = fresh.filter((t) => t.status === "needs_you").map((t) => t.id);
    const back = fresh.filter((t) => t.status !== "needs_you").map((t) => t.id);
    return [...atTaskFront(kept, front), ...back];
  }
  const order = atTaskFront(kept, fresh.map((t) => t.id));
  const needs = order.filter((id) => byId.get(id)?.status === "needs_you");
  const rest = order.filter((id) => id !== STREAM_TILE && byId.get(id)?.status !== "needs_you");
  return [STREAM_TILE, ...needs, ...rest];
}

/** Moves one card by `delta` places (keyboard buttons). Same array back when it can't move. */
export function moveBy(order: string[], id: string, delta: number): string[] {
  const i = order.indexOf(id);
  if (i < 0) return order;
  return moveTo(order, id, Math.max(0, Math.min(order.length - 1, i + delta)));
}

/** Moves one card to `index`; the card it lands on shifts over (drag and drop). */
export function moveTo(order: string[], id: string, index: number): string[] {
  const i = order.indexOf(id);
  if (i < 0 || i === index || index < 0 || index >= order.length) return order;
  const next = order.filter((x) => x !== id);
  next.splice(index, 0, id);
  return next;
}

/** What the screen reader hears after a move. */
export const movedMessage = (name: string, index: number, total: number) => `${name} moved to position ${index + 1} of ${total}`;

export const sameOrder = (a: string[] | null, b: string[] | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** A card's place on screen, for drag and drop. */
export type Box = { id: string; left: number; top: number; width: number; height: number };

/** The card a dragged card would land on: the one under the pointer, else the nearest one. */
export function dropTarget(boxes: Box[], x: number, y: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of boxes) {
    const cx = Math.max(b.left, Math.min(x, b.left + b.width));
    const cy = Math.max(b.top, Math.min(y, b.top + b.height));
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) (bestD = d), (best = b.id);
  }
  return best;
}

export type BoardPrefs = { order: string[] | null; collapsed: string[] };

/** Reads what was saved in this browser; anything odd counts as nothing saved. */
export function readBoardPrefs(raw: string | null): BoardPrefs {
  const none: BoardPrefs = { order: null, collapsed: [] };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw) as Partial<BoardPrefs>;
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : null);
    return { order: strings(v?.order), collapsed: strings(v?.collapsed) ?? [] };
  } catch {
    return none;
  }
}

/** Folds a card to its title bar, or opens it again. */
export const toggleCollapsed = (collapsed: string[], id: string) => (collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);

/** Forgets folded cards whose task is gone. */
export const pruneCollapsed = (collapsed: string[], ids: string[]) => collapsed.filter((id) => ids.includes(id));

/** The results a task produced, checked before drawing. Invalid ones are counted, not shown. */
export function validPanels(raw: unknown[], max = 3): { panels: Panel[]; skipped: number } {
  const panels: Panel[] = [];
  let skipped = 0;
  for (const p of Array.isArray(raw) ? raw : []) {
    const r = parsePanel(p);
    if (r.ok) panels.push(r.panel);
    else skipped++;
  }
  return { panels: panels.slice(0, max), skipped };
}

export const skippedLabel = (n: number) => (n <= 0 ? "" : n === 1 ? "1 result could not be shown" : `${n} results could not be shown`);

/** Shortens text at a word, with an ellipsis. */
export function clip(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

// ---------------------------------------------------------------- greeting
export function greeting(hour: number): string {
  if (hour < 5) return "Hello, night owl.";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export const SUGGESTIONS = ["Summarize something for me", "Help me plan my week", "Draft an email", "Explain something simply"];
