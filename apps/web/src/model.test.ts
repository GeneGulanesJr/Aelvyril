import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadRow } from "./api.ts";
import { buildTranscript, type Ev } from "./transcript.ts";
import {
  announcements,
  cardStatus,
  clip,
  dayLabel,
  defaultOrder,
  dragOffset,
  dropTarget,
  gesture,
  groupTasks,
  isUnlocked,
  isView,
  mergeOrder,
  moveBy,
  movedMessage,
  moveTo,
  needsYouFirst,
  neighbour,
  pruneCollapsed,
  readBoardPrefs,
  sameOrder,
  skippedLabel,
  STREAM_TILE,
  toggleCollapsed,
  validPanels,
  VIEWS,
  plainPreview,
  swipeAxis,
  swipeResult,
  waitingOnYou,
  withDays,
} from "./model.ts";

const row = (o: Partial<ThreadRow>): ThreadRow => ({
  id: "x",
  title: "Task",
  updated_at: 0,
  running: false,
  waiting: 0,
  kind: "job",
  parent_id: "m",
  status: "done",
  preview: "",
  ...o,
});

test("first-timer rule: only the Stream until a task has finished", () => {
  assert.equal(isUnlocked([]), false);
  assert.equal(isUnlocked([row({ kind: "main", status: "done" })]), false, "the Stream itself does not count");
  assert.equal(isUnlocked([row({ status: "working" })]), false);
  assert.equal(isUnlocked([row({ status: "needs_you" })]), false);
  for (const status of ["done", "failed", "stopped"] as const) assert.equal(isUnlocked([row({ status })]), true, status);
  assert.equal(isUnlocked([row({ kind: "chat", status: "done" })]), true, "older chats mean the app was used before");
  assert.equal(isUnlocked([], true), true, "once unlocked it stays unlocked");
});

test("inbox groups: needs you, working, newest 20 done, older chats; the Stream is never listed", () => {
  const rows = [
    row({ id: "main", kind: "main", status: "working" }),
    row({ id: "w", status: "working", updated_at: 5 }),
    row({ id: "n", status: "needs_you", updated_at: 1 }),
    row({ id: "cn", kind: "chat", status: "needs_you", updated_at: 2 }),
    row({ id: "c", kind: "chat", status: "done", updated_at: 3 }),
    row({ id: "f", status: "failed", updated_at: 9 }),
    row({ id: "s", status: "stopped", updated_at: 8 }),
    ...Array.from({ length: 25 }, (_, i) => row({ id: `d${i}`, status: "done", updated_at: 100 + i })),
  ];
  const g = groupTasks(rows);
  assert.deepEqual(g.needsYou.map((t) => t.id), ["cn", "n"], "newest first; a chat that waits on you is listed here too");
  assert.deepEqual(g.working.map((t) => t.id), ["w"]);
  assert.deepEqual(g.chats.map((t) => t.id), ["c"]);
  assert.equal(g.done.length, 20);
  assert.equal(g.done[0].id, "d24", "newest done first");
  assert.ok(!g.done.some((t) => t.id === "f"), "older finished tasks fall past the 20 limit");
  assert.deepEqual(groupTasks(rows, 40).done.slice(-2).map((t) => t.id), ["f", "s"], "failed and stopped count as finished");
  assert.deepEqual(waitingOnYou(rows).map((t) => t.id), ["n", "cn"], "the longest wait is named first");
});

test("day separators: Today / Yesterday / a date, untimed items follow the item before them", () => {
  const now = new Date(2026, 4, 20, 15, 0).getTime();
  const at = (d: number, h = 10) => new Date(2026, 4, d, h).getTime();
  assert.equal(dayLabel(at(20, 1), now), "Today");
  assert.equal(dayLabel(at(19, 23), now), "Yesterday");
  assert.equal(dayLabel(at(12), now, "en-GB"), "Tuesday 12 May");
  assert.match(dayLabel(new Date(2025, 0, 2).getTime(), now, "en-GB"), /2025/);

  const items = [
    { key: "card0" }, // before any time: belongs to the first known day
    { key: "a", at: at(12) },
    { key: "b", at: at(12, 18) },
    { key: "card1" },
    { key: "c", at: at(19) },
    { key: "card2" },
    { key: "d", at: at(20) },
  ];
  const out = withDays(items, now, "en-GB").map((i) => ("label" in i ? `[${i.label}]` : i.key));
  assert.deepEqual(out, ["[Tuesday 12 May]", "card0", "a", "b", "card1", "[Yesterday]", "c", "card2", "[Today]", "d"]);
  assert.deepEqual(withDays([{ key: "x" }], now), [{ key: "x" }], "no times known: no separators");
});

test("transcript messages carry their time when the event has one (additive)", () => {
  const ev = (seq: number, o: Record<string, unknown>): Ev => ({ seq, type: "x", ...o });
  const t = buildTranscript([
    ev(1, { type: "message_end", message: { role: "user", content: "hi", timestamp: 42 } }),
    ev(2, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
  ]);
  assert.equal((t.items[0] as any).at, 42);
  assert.equal("at" in t.items[1], false);
});

test("swipe: decide the axis, then whether it moves a view", () => {
  assert.equal(swipeAxis(4, 3), "pending", "too small to tell");
  assert.equal(swipeAxis(30, 6), "x");
  assert.equal(swipeAxis(12, 30), "y", "mostly down is a scroll");
  assert.equal(swipeAxis(20, 18), "y", "a diagonal is a scroll, not a swipe");

  assert.equal(swipeResult(-120, 400, 400, true, true), 1, "far enough left: next view");
  assert.equal(swipeResult(120, 400, 400, true, true), -1, "far enough right: previous view");
  assert.equal(swipeResult(-60, 400, 600, true, true), 0, "slow and short: stay");
  assert.equal(swipeResult(-60, 400, 80, true, true), 1, "a quick flick is enough");
  assert.equal(swipeResult(-20, 400, 20, true, true), 0, "a twitch is not a flick");
  assert.equal(swipeResult(200, 400, 300, false, true), 0, "nothing before the first view");
  assert.equal(swipeResult(-200, 400, 300, true, false), 0, "nothing after the last view");
  assert.equal(dragOffset(100, false, true), 25, "resists at an end");
  assert.equal(dragOffset(-100, true, true), -100);

  assert.equal(neighbour("stream", 1), "inbox");
  assert.equal(neighbour("stream", -1), null);
  assert.equal(neighbour("quick", 1), "board", "Board sits after Quick");
  assert.equal(neighbour("board", -1), "quick");
  assert.equal(neighbour("board", 1), null, "nothing after the Board");
});

test("status: the newer list wins over the card; announcements are polite one-liners", () => {
  assert.equal(cardStatus({ state: "working" }, { status: "needs_you" }), "needs_you");
  assert.equal(cardStatus({ state: "done" }), "done");
  assert.equal(plainPreview("The job failed: no network"), "Couldn't finish: no network");

  const a = [row({ id: "1", title: "Rename photos", status: "working" }), row({ id: "2", title: "Plan trip", status: "working" })];
  assert.deepEqual(announcements(null, a), [], "nothing on the first load");
  const b = [row({ id: "1", title: "Rename photos", status: "needs_you" }), row({ id: "2", title: "Plan trip", status: "done" }), row({ id: "3", title: "Sort files", status: "working" })];
  assert.deepEqual(announcements(a, b), ["Rename photos needs your OK", "Plan trip is done", "Started a task: Sort files"]);
  assert.deepEqual(announcements(b, [row({ id: "1", title: "Rename photos", status: "failed" })]), ["Rename photos couldn't finish"]);
});

// ---------------------------------------------------------------- board
type T = { id: string; status: ThreadRow["status"]; updated_at: number };
const task = (id: string, status: T["status"], updated_at: number): T => ({ id, status, updated_at });

test("views: Stream | Inbox | Quick | Board, in that order", () => {
  assert.deepEqual(VIEWS.map((v) => v.label), ["Stream", "Inbox", "Quick", "Board"]);
  assert.equal(isView("board"), true);
  assert.equal(isView("pinboard"), false);
});

test("board order: the Stream first, needs-you next (longest wait first), then newest", () => {
  const tasks = [task("a", "done", 5), task("b", "needs_you", 9), task("c", "working", 7), task("d", "needs_you", 2), task("e", "failed", 1)];
  assert.deepEqual(needsYouFirst(tasks).map((t) => t.id), ["d", "b", "c", "a", "e"]);
  assert.deepEqual(defaultOrder(tasks), [STREAM_TILE, "d", "b", "c", "a", "e"]);
  assert.deepEqual(mergeOrder(null, tasks, false), defaultOrder(tasks), "nothing shown before: the default order");
  assert.deepEqual(mergeOrder(null, [], false), [STREAM_TILE], "no tasks: only the Stream card");
});

test("board order, not arranged: cards keep their place, new ones come in front, needs-you stays ahead", () => {
  const shown = [STREAM_TILE, "a", "b"];
  // a task updating does not make it jump
  assert.deepEqual(mergeOrder(shown, [task("a", "working", 1), task("b", "done", 99)], false), [STREAM_TILE, "a", "b"]);
  // a new task comes in at the front of the tasks
  assert.deepEqual(mergeOrder(shown, [task("a", "working", 1), task("b", "done", 2), task("n", "working", 3)], false), [STREAM_TILE, "n", "a", "b"]);
  // a task that starts needing you moves ahead of the rest
  assert.deepEqual(mergeOrder(shown, [task("a", "working", 1), task("b", "needs_you", 2)], false), [STREAM_TILE, "b", "a"]);
  // a removed task disappears
  assert.deepEqual(mergeOrder(shown, [task("b", "done", 2)], false), [STREAM_TILE, "b"]);
});

test("board order, arranged: the person's order holds; removed go, new needs-you in front, other new at the end", () => {
  const saved = ["a", STREAM_TILE, "b", "gone", "c"];
  const tasks = [task("a", "done", 1), task("b", "needs_you", 2), task("c", "working", 3)];
  assert.deepEqual(mergeOrder(saved, tasks, true), ["a", STREAM_TILE, "b", "c"], "needs-you is not pulled forward once arranged; removed tasks drop out");
  const more = [...tasks, task("n1", "working", 9), task("n2", "needs_you", 8)];
  assert.deepEqual(mergeOrder(["a", STREAM_TILE, "b", "c"], more, true), ["n2", "a", STREAM_TILE, "b", "c", "n1"]);
  assert.deepEqual(mergeOrder([STREAM_TILE, "a"], [task("a", "done", 1), task("n", "needs_you", 2)], true), [STREAM_TILE, "n", "a"], "front means in front of the first task card");
  assert.deepEqual(mergeOrder(["a", "a", "b"], [task("a", "done", 1), task("b", "done", 2)], true), [STREAM_TILE, "a", "b"], "duplicates and a lost Stream card are repaired");
});

test("moving cards: by keyboard steps, by drag to a place, and the announcement", () => {
  const order = [STREAM_TILE, "a", "b", "c"];
  assert.deepEqual(moveBy(order, "b", -1), [STREAM_TILE, "b", "a", "c"]);
  assert.deepEqual(moveBy(order, "b", 1), [STREAM_TILE, "a", "c", "b"]);
  assert.equal(moveBy(order, STREAM_TILE, -1), order, "can't move before the first place: same order back");
  assert.equal(moveBy(order, "c", 1), order, "can't move past the last place");
  assert.equal(moveBy(order, "zz", 1), order);
  assert.deepEqual(moveTo(order, STREAM_TILE, 2), ["a", "b", STREAM_TILE, "c"], "dropped on a later card: takes its place");
  assert.deepEqual(moveTo(order, "c", 1), [STREAM_TILE, "c", "a", "b"], "dropped on an earlier card: takes its place");
  assert.equal(moveTo(order, "a", 1), order);
  assert.equal(movedMessage("Plan my week", 1, 4), "Plan my week moved to position 2 of 4");
  assert.equal(sameOrder(order, [...order]), true);
  assert.equal(sameOrder(order, moveBy(order, "a", 1)), false);
  assert.equal(sameOrder(null, order), false);
});

test("drop target: the card under the pointer, else the nearest", () => {
  const boxes = [
    { id: "a", left: 0, top: 0, width: 100, height: 100 },
    { id: "b", left: 120, top: 0, width: 100, height: 300 },
    { id: "c", left: 0, top: 120, width: 100, height: 50 },
  ];
  assert.equal(dropTarget(boxes, 50, 50), "a");
  assert.equal(dropTarget(boxes, 150, 250), "b");
  assert.equal(dropTarget(boxes, 40, 200), "c", "below the shortest column: the nearest card");
  assert.equal(dropTarget([], 0, 0), null);
});

test("gestures: the handle drags in any direction; elsewhere a sideways touch swipes, never drags", () => {
  assert.equal(gesture(true, true, 2, 1), "pending", "a tap on the handle is not a drag");
  assert.equal(gesture(true, true, 30, 2), "drag", "sideways from the handle moves the card, not the view");
  assert.equal(gesture(true, false, 0, 12), "drag");
  assert.equal(gesture(false, true, 30, 4), "swipe");
  assert.equal(gesture(false, true, 4, 30), "scroll");
  assert.equal(gesture(false, true, 3, 3), "pending");
  assert.equal(gesture(false, false, 40, 0), "none", "a mouse outside the handle does nothing special");
});

test("folding and saved preferences survive junk", () => {
  assert.deepEqual(toggleCollapsed([], "a"), ["a"]);
  assert.deepEqual(toggleCollapsed(["a", "b"], "a"), ["b"]);
  assert.deepEqual(pruneCollapsed(["a", STREAM_TILE, "gone"], [STREAM_TILE, "a"]), ["a", STREAM_TILE]);
  assert.deepEqual(readBoardPrefs(null), { order: null, collapsed: [] });
  assert.deepEqual(readBoardPrefs("not json"), { order: null, collapsed: [] });
  assert.deepEqual(readBoardPrefs('{"order":["a",3,"b"],"collapsed":"x"}'), { order: ["a", "b"], collapsed: [] });
  assert.deepEqual(readBoardPrefs('{"collapsed":["a"]}'), { order: null, collapsed: ["a"] }, "folded but never arranged");
});

test("results: checked before drawing; invalid ones are counted, at most 3 shown", () => {
  const ok = (id: string) => ({ v: 1, id, kind: "markdown", body: `result ${id}` });
  const r = validPanels([ok("1"), { v: 1, id: "bad", kind: "table", columns: ["a"] }, ok("2"), "junk", ok("3"), ok("4")]);
  assert.deepEqual(r.panels.map((p) => p.id), ["1", "2", "3"], "newest first, as given");
  assert.equal(r.skipped, 2);
  const seeded = validPanels([
    { v: 1, id: "t", kind: "table", columns: ["Day", "Plan"], rows: [["Mon", "Gym"], ["Tue", null]] },
    { v: 1, id: "s", kind: "status", text: "Week planned", tone: "success" },
    { v: 1, id: "x", kind: "actions", actions: [{ label: "Redo", command: "/redo" }] },
  ]);
  assert.deepEqual(seeded.panels.map((p) => p.kind), ["table", "status", "actions"]);
  assert.equal(seeded.skipped, 0);
  assert.deepEqual(validPanels(undefined as unknown as unknown[]), { panels: [], skipped: 0 });
  assert.equal(skippedLabel(0), "");
  assert.equal(skippedLabel(1), "1 result could not be shown");
  assert.equal(skippedLabel(3), "3 results could not be shown");
});

test("clip: short text stays, long text ends at a word with an ellipsis", () => {
  assert.equal(clip("  hello  ", 10), "hello");
  assert.equal(clip("the quick brown fox jumps", 15), "the quick brown\u2026");
  assert.equal(clip("supercalifragilistic", 5), "super\u2026");
});
