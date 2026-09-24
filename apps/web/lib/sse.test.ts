import { describe, expect, it } from "vitest";
import { SseParser } from "./sse.js";
import type { EventEnvelope } from "@aelvyril/shared";

function feed(parser: SseParser, text: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const e of parser.push(text)) out.push(e);
  return out;
}

describe("SseParser", () => {
  it("parses id/event/data blocks", () => {
    const p = new SseParser();
    const events = feed(
      p,
      'id: 0\nevent: session_state\ndata: {"seq":0,"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"session_state","payload":{"state":"streaming"}}\n\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("session_state");
  });

  it("skips retry/comment blocks without data", () => {
    const p = new SseParser();
    expect(feed(p, "retry: 2000\n\n")).toEqual([]);
    expect(feed(p, ": ping\n\n")).toEqual([]);
  });

  it("handles blocks split across pushes", () => {
    const p = new SseParser();
    expect(feed(p, 'id: 1\nevent: text_delta\ndata: {"seq":1')).toEqual([]);
    const events = feed(
      p,
      ',"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"text_delta","payload":{"delta":"hi"}}\n\n',
    );
    expect(events[0]!.kind).toBe("text_delta");
  });

  it("ignores envelopes whose seq is not greater than lastSeq (dup guard)", () => {
    const p = new SseParser();
    const mk = (seq: number) =>
      `id: ${seq}\nevent: text_delta\ndata: {"seq":${seq},"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"text_delta","payload":{"delta":"x"}}\n\n`;
    feed(p, mk(1));
    expect(feed(p, mk(1))).toEqual([]); // dup
    expect(feed(p, mk(2))).toHaveLength(1);
  });

  it("emits spec_question/spec_draft/spec_status/diff envelopes", () => {
    const p = new SseParser();
    const mk = (seq: number, kind: string, payload: unknown) =>
      `id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify({
        seq,
        conversationId: "t1",
        ts: "2026-09-23T00:00:00.000Z",
        kind,
        payload,
      })}\n\n`;
    const events = feed(
      p,
      mk(0, "spec_status", { status: "spec'ing" }) +
        mk(1, "spec_question", { questions: [{ id: "q1", prompt: "?", kind: "text" }] }) +
        mk(2, "spec_draft", {
          draft: { goal: "", filesAffected: [], plan: [], risks: [], questions: [], answers: {} },
        }) +
        mk(3, "diff", { files: [{ path: "a.ts", patch: "@@" }] }),
    );
    expect(events.map((e) => e.kind)).toEqual([
      "spec_status",
      "spec_question",
      "spec_draft",
      "diff",
    ]);
  });
});
