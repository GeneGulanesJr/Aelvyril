import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, type Ev } from "./transcript.ts";

const ev = (seq: number, o: Record<string, unknown>): Ev => ({ seq, type: "x", ...o });

test("user and assistant messages become items", () => {
  const t = buildTranscript([
    ev(1, { type: "agent_start" }),
    ev(2, { type: "message_end", message: { role: "user", content: "hi" } }),
    ev(3, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
  ]);
  assert.deepEqual(t.items.map((i) => i.kind), ["user", "assistant"]);
  assert.equal(t.running, true);
  assert.equal(buildTranscript([ev(1, { type: "agent_start" }), ev(2, { type: "agent_settled" })]).running, false);
});

test("a panel with the same id updates in place; an invalid one becomes a notice", () => {
  const entry = (data: unknown) => ({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.panel", data } });
  const t = buildTranscript([
    ev(1, entry({ v: 1, id: "p", kind: "markdown", body: "one" })),
    ev(2, { type: "message_end", message: { role: "user", content: "between" } }),
    ev(3, entry({ v: 1, id: "p", kind: "markdown", body: "two" })),
    ev(4, entry({ v: 9, id: "q", kind: "markdown", body: "bad" })),
  ]);
  assert.deepEqual(t.items.map((i) => i.kind), ["panel", "user", "notice"]);
  assert.equal((t.items[0] as any).panel.body, "two");
});

test("dialogs: pending, resolved, and dead after the child restarted", () => {
  const ask = (seq: number, id: string) => ev(seq, { type: "extension_ui_request", id, method: "confirm", title: "Run?" });
  const t = buildTranscript([
    ask(1, "a"),
    ask(2, "b"),
    ev(3, { type: "aelvyril_ui_resolved", id: "b" }),
    ev(4, { type: "aelvyril_host_start" }),
    ask(5, "c"),
  ]);
  assert.deepEqual(t.items.map((i: any) => i.state), ["dead", "resolved", "pending"]);
});

test("tools, statuses and widgets", () => {
  const t = buildTranscript([
    ev(1, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" } }),
    ev(2, { type: "tool_execution_end", toolCallId: "t", result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
    ev(3, { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k", statusText: "busy" }),
    ev(4, { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "w", widgetLines: ["a", "b"] }),
  ]);
  assert.deepEqual(t.items[0], { kind: "tool", key: "1", name: "bash", args: { command: "ls" }, output: "ok", isError: false, done: true });
  assert.equal(t.status.k, "busy");
  assert.deepEqual(t.widgets.w, ["a", "b"]);
});

test("tasks: a card per job that updates in place; the hand-off message and the start_job line stay hidden", () => {
  const t = buildTranscript([
    ev(1, { type: "message_end", message: { role: "user", content: "please rename my photos" } }),
    ev(2, { type: "tool_execution_start", toolCallId: "c", toolName: "start_job", args: {} }),
    ev(3, { type: "aelvyril_job_started", jobId: "j1", title: "Rename photos" }),
    ev(4, { type: "aelvyril_job_update", jobId: "j1", title: "Rename photos", state: "needs_you", preview: "" }),
    ev(5, { type: "aelvyril_job_update", jobId: "j1", title: "Rename photos", state: "done", preview: "Renamed 40 photos" }),
    ev(6, { type: "message_end", message: { role: "user", content: "[aelvyril:job-result]\nThe job finished" } }),
    ev(7, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All done!" }] } }),
  ]);
  assert.deepEqual(t.items.map((i) => i.kind), ["user", "job", "assistant"]);
  assert.deepEqual(t.items[1], { kind: "job", key: "3", jobId: "j1", title: "Rename photos", state: "done", preview: "Renamed 40 photos" });
});

test("the finish_task tool call is not shown as a tool line", () => {
  const t = buildTranscript([
    ev(1, { type: "tool_execution_start", toolCallId: "f", toolName: "finish_task", args: { outcome: "done", summary: "x" } }),
    ev(2, { type: "tool_execution_end", toolCallId: "f", toolName: "finish_task", result: { content: [{ type: "text", text: "Recorded." }] }, isError: false }),
    ev(3, { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "ls" } }),
  ]);
  assert.deepEqual(t.items.map((i) => i.kind), ["tool"]);
  assert.equal((t.items[0] as { name: string }).name, "bash");
});

test("a retry shows as a short notice, and how a finished task checked its work is shown", () => {
  const t = buildTranscript([
    ev(1, { type: "message_end", message: { role: "user", content: "[aelvyril:retry]\nThe person asked you to try again. Last time: it broke" } }),
    ev(2, { type: "entry_appended", entry: { type: "custom", customType: "aelvyril.task_outcome", data: { outcome: "done", summary: "Renamed 40 photos", verified: "listed the folder: 40 files, all renamed" } } }),
    ev(3, { type: "entry_appended", entry: { type: "custom", customType: "aelvyril.task_outcome", data: { outcome: "cannot_finish", summary: "no network" } } }),
  ]);
  assert.deepEqual(t.items.map((i) => (i.kind === "notice" ? i.text : i.kind)), ["Trying again.", "How it was checked: listed the folder: 40 files, all renamed"]);
});

test("an extension's startup confirmation is not shown, other notifications are", () => {
  const t = buildTranscript([
    ev(1, { type: "extension_ui_request", id: "a", method: "notify", message: "Ponytail loaded: full", notifyType: "info" }),
    ev(2, { type: "extension_ui_request", id: "b", method: "notify", message: "Saved your notes", notifyType: "info" }),
  ]);
  assert.deepEqual(t.items.map((i) => (i.kind === "notice" ? i.text : i.kind)), ["Saved your notes"]);
});
