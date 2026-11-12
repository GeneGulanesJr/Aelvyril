import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadRow } from "./api.ts";
import { buildTranscript, type Ev } from "./transcript.ts";
import {
  announcements,
  arrange,
  settle,
  cardStatus,
  dayLabel,
  dragOffset,
  groupTasks,
  isUnlocked,
  isView,
  neighbour,
  VIEWS,
  plainPreview,
  projects,
  stepWords,
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
  assert.equal(neighbour("inbox", 1), null, "nothing after Tasks (Quick is the pop-up, not a screen)");
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

test("views: Stream | Tasks; the old Board and the Quick screen are gone", () => {
  assert.deepEqual(VIEWS.map((v) => v.label), ["Stream", "Tasks"]);
  assert.equal(isView("quick"), false, "a remembered Quick screen falls back to the Stream");
  assert.equal(isView("inbox"), true, "Tasks keeps the Inbox id, so a remembered view still opens");
  assert.equal(isView("board"), false, "a remembered Board falls back to the Stream");
});

test("steps in plain words: what was done, and the one detail that says which", () => {
  assert.deepEqual(stepWords("bash", { command: "ls -la /tmp\necho hi" }), { what: "Ran a command", detail: "ls -la /tmp" });
  assert.deepEqual(stepWords("write", { path: "/data/pi/extensions/weather.ts", content: "x" }), { what: "Wrote weather.ts", detail: "/data/pi/extensions/weather.ts" });
  assert.deepEqual(stepWords("edit", {}), { what: "Edited a file", detail: "" });
  assert.equal(stepWords("memory-save-classified", { title: "Panels" }).what, "Used its memory");
  assert.deepEqual(stepWords("make_chart", { kind: "bar" }), { what: "make chart", detail: "bar" }, "unknown tools keep their name, readable");
  assert.deepEqual(stepWords("bash", null), { what: "Ran a command", detail: "" }, "odd arguments never break it");
});

test("projects: tasks grouped by board, in the column of their most urgent task", () => {
  const t = (id: string, board: string | undefined, status: ThreadRow["status"], updated_at: number, kind: ThreadRow["kind"] = "job") => row({ id, board, status, updated_at, kind });
  const list = projects([
    t("s", undefined, "working", 99, "main"),
    t("w1", "Weather", "done", 5),
    t("w2", "Weather", "working", 9),
    t("w3", "Weather", "failed", 7),
    t("g1", undefined, "done", 3),
    t("x1", "Trips", "needs_you", 1),
    t("c1", undefined, "done", 2, "chat"),
  ]);
  assert.deepEqual(list.map((p) => [p.name, p.column, p.tasks.map((x) => x.id)]), [
    ["Trips", "needs", ["x1"]],
    ["Weather", "working", ["w2", "w3", "w1"]],
    ["General", "done", ["g1"]],
    ["Older chats", "done", ["c1"]],
  ], "needs-you projects first, then working, then done (newest first); the Stream is never a project");
  assert.deepEqual(projects([]), []);
});

test("home board: the moved tile keeps its spot, what it would cover moves down, everything stays in the grid, new tiles fill the first free place", () => {
  const a = { id: "a", x: 0, y: 0, w: 6, h: 2 }, b = { id: "b", x: 6, y: 0, w: 6, h: 2 };
  assert.deepEqual(settle([a, { ...b, x: 3 }], "b"), [{ ...a, y: 2 }, { ...b, x: 3 }]);
  assert.deepEqual(settle([a, { ...b, x: 3 }], "a"), [a, { ...b, x: 3, y: 2 }], "whichever is moved wins");
  assert.deepEqual(settle([{ id: "a", x: 20, y: -3, w: 30, h: 2 }]), [{ id: "a", x: 0, y: 0, w: 12, h: 2 }]);
  const laid = arrange([{ id: "a", w: 6, h: 2 }, { id: "n", w: 3, h: 2 }, { id: "d", w: 4, h: 2, x: 0, y: 0 }], { a: { x: 0, y: 0, w: 6, h: 2 }, gone: { x: 0, y: 0, w: 1, h: 1 } });
  assert.deepEqual(laid.map((t) => [t.id, t.x, t.y]), [["a", 0, 0], ["n", 6, 0], ["d", 0, 2]], "d's default spot is taken, so the first free place");
  const all = [...laid];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const [p, q] = [all[i], all[j]];
    assert.ok(!(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h), `${p.id} and ${q.id} overlap`);
  }
});
