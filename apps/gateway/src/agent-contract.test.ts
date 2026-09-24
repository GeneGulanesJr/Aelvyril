import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AgentContract } from "./agent-contract.js";

function fakeSession() {
  const ee = new EventEmitter();
  return {
    stdin: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    stdout: ee as unknown as NodeJS.ReadableStream,
    /** Drive the fake stdout stream from tests. */
    emit: ee.emit.bind(ee) as (event: string, chunk: Buffer) => boolean,
    kill: vi.fn(),
  };
}

function linesWrittenTo(stdin: NodeJS.WritableStream): unknown[] {
  const write = (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write;
  return write.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe("AgentContract", () => {
  it("emits spec_status and spec_question when spec mode triggers", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force", threadId: "t1" });
    const status: string[] = [];
    const questions: unknown[] = [];
    c.on("envelope", (e) => {
      if (e.kind === "spec_status") status.push(e.payload.status);
      if (e.kind === "spec_question") questions.push(e.payload.questions);
    });
    c.start("build the thing");
    // Simulate the agent emitting a spec_question JSON line on stdout.
    session.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "spec_question",
          questions: [{ id: "q1", prompt: "?", kind: "text" }],
        }) + "\n",
      ),
    );
    expect(status).toContain("spec'ing");
    expect(questions).toHaveLength(1);
  });

  it("casual asks skip the interview: status running + prompt forwarded", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "auto", threadId: "t1" });
    const status: string[] = [];
    c.on("envelope", (e) => {
      if (e.kind === "spec_status") status.push(e.payload.status);
    });
    c.start("rename getUserById to findUserById");
    expect(status).toEqual(["running"]);
    const sent = linesWrittenTo(session.stdin);
    expect(sent).toEqual([{ type: "user", prompt: "rename getUserById to findUserById" }]);
  });

  it("emitted envelopes carry the store grammar minus seq", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force", threadId: "t1" });
    const seen: unknown[] = [];
    c.on("envelope", (e) => seen.push(e));
    c.start("do it");
    const first = seen[0] as { kind: string; conversationId: string; ts: string; seq?: number };
    expect(first.kind).toBe("spec_status");
    expect(first.conversationId).toBe("t1");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("seq" in first).toBe(false);
  });

  it("spec_draft from the agent is forwarded and answers patch it", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force", threadId: "t1" });
    const drafts: unknown[] = [];
    c.on("envelope", (e) => {
      if (e.kind === "spec_draft") drafts.push(e.payload.draft);
    });
    c.start("do it");
    const draft = {
      goal: "g",
      filesAffected: [],
      plan: [],
      risks: [],
      questions: [{ id: "q1", prompt: "?", kind: "text" }],
      answers: {},
    };
    session.emit("data", Buffer.from(JSON.stringify({ type: "spec_draft", draft }) + "\n"));
    c.submitSpecPatch({ kind: "answer", answers: { q1: "because" } });
    expect(drafts).toHaveLength(2);
    expect((drafts[1] as { answers: Record<string, string> }).answers.q1).toBe("because");
    // The answer round-trips to the agent as a user message.
    const sent = linesWrittenTo(session.stdin);
    expect(sent.at(-1)).toMatchObject({ type: "user" });
  });

  it("diff completes the run: forwarded + status reviewed", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force", threadId: "t1" });
    const status: string[] = [];
    const diffs: unknown[] = [];
    c.on("envelope", (e) => {
      if (e.kind === "spec_status") status.push(e.payload.status);
      if (e.kind === "diff") diffs.push(e.payload.files);
    });
    c.start("do it");
    session.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "diff", files: [{ path: "a.ts", patch: "@@" }] }) + "\n"),
    );
    expect(diffs).toEqual([[{ path: "a.ts", patch: "@@" }]]);
    expect(status).toContain("reviewed");
  });

  it("abandon emits abandoned status and kills the child", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force", threadId: "t1" });
    const status: string[] = [];
    c.on("envelope", (e) => {
      if (e.kind === "spec_status") status.push(e.payload.status);
    });
    c.start("do it");
    c.abandon();
    expect(status).toContain("abandoned");
    expect(session.kill).toHaveBeenCalled();
  });
});
