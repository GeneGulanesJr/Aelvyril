import { describe, expect, it } from "vitest";
import {
  AgentContract,
  buildExecutionPrompt,
  buildVerifyRetryPrompt,
  type AgentContractIo,
  type ContractEnvelope,
} from "./agent-contract.js";
import type { SpecDraft, SpecQuestion } from "@aelvyril/shared";

function fakeIo(autonomy: "standard" | "established" = "standard") {
  const envelopes: ContractEnvelope[] = [];
  const replies: string[] = [];
  let persisted: SpecDraft | null = null;
  const io: AgentContractIo = {
    threadId: "t1",
    reply: (m) => replies.push(m),
    publish: (e) => envelopes.push(e),
    persistDraft: (d) => {
      persisted = d;
    },
    autonomy: () => autonomy,
  };
  return { io, envelopes, replies, persistedDraft: () => persisted };
}

const questions: SpecQuestion[] = [{ id: "q1", prompt: "What shape?", kind: "text" }];

function draftWith(plan: string[]): SpecDraft {
  return {
    goal: "g",
    filesAffected: [],
    plan,
    risks: [],
    questions,
    answers: { q1: "a" },
  };
}

describe("AgentContract prompt building (#81.2)", () => {
  it("off mode passes the message untouched", () => {
    const { io } = fakeIo();
    const c = new AgentContract(io, { specMode: "off" });
    expect(c.wrapPrompt("rename x to y")).toBe("rename x to y");
  });

  it("auto + casual ask: protocol instructions but no dead-man push", () => {
    const { io } = fakeIo();
    const c = new AgentContract(io, { specMode: "auto" });
    const wrapped = c.wrapPrompt("rename getUserById to findUserById");
    expect(wrapped).toContain("rename getUserById to findUserById");
    expect(wrapped).toContain("custom_spec_question");
    expect(wrapped).not.toContain("forced spec mode");
    expect(wrapped).not.toContain("pattern-matches a broad, multi-part ask");
  });

  it("dead-man switch: the regex only STRENGTHENS the instruction (#81.2)", () => {
    const { io } = fakeIo();
    const c = new AgentContract(io, { specMode: "auto" });
    // "add role-based access to admin dashboard" hits the legacy heuristic —
    // but it no longer forces an interview, it strengthens the instruction.
    expect(c.wrapPrompt("add role-based access to admin dashboard")).toContain(
      "pattern-matches a broad, multi-part ask",
    );
  });

  it("force mode mandates the interview", () => {
    const { io } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    expect(c.wrapPrompt("anything")).toContain("forced spec mode");
  });
});

describe("AgentContract spec signals (#80)", () => {
  it("custom_spec_question publishes the envelope and parks the interview", () => {
    const { io, envelopes } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({ type: "custom_spec_question", questions });
    expect(c.awaitingInterview).toBe(true);
    expect(c.rounds).toBe(1);
    const kinds = envelopes.map((e) => e.kind);
    expect(kinds).toContain("spec_status"); // spec'ing
    expect(kinds).toContain("spec_question");
    const q = envelopes.find((e) => e.kind === "spec_question")!;
    expect(q.conversationId).toBe("t1");
    expect(q.payload).toEqual({ questions });
  });

  it("an invalid question payload surfaces an error, not a crash", () => {
    const { io, envelopes } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({ type: "custom_spec_question", questions: [{ nope: true }] });
    expect(envelopes.some((e) => e.kind === "error")).toBe(true);
    expect(c.awaitingInterview).toBe(false);
  });

  it("question budget: past the max the agent is told to proceed (#81.2)", () => {
    const { io, replies } = fakeIo();
    const c = new AgentContract(io, { specMode: "force", maxSpecRounds: 1 });
    c.onProtocolEvent({ type: "custom_spec_question", questions });
    expect(replies).toHaveLength(0); // first round is fine
    c.onProtocolEvent({ type: "custom_spec_question", questions });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Question budget exhausted");
  });

  it("a reversible draft AUTO-RUNS: verdict + persist + execution prompt (#81.1)", () => {
    const { io, envelopes, replies, persistedDraft } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({ type: "custom_spec_draft", draft: draftWith(["edit src/a.ts"]) });
    expect(persistedDraft()?.goal).toBe("g");
    expect(c.approved).toBe(true);
    expect(c.awaitingInterview).toBe(false);
    const kinds = envelopes.map((e) => e.kind);
    expect(kinds).toContain("spec_draft");
    expect(kinds).toContain("laya_verdict");
    expect(kinds).toContain("spec_status"); // running
    const verdict = envelopes.find((e) => e.kind === "laya_verdict")!;
    expect(verdict.payload).toMatchObject({ tool: "risk-classifier", verdict: { gated: false } });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Spec approved");
  });

  it("a gated draft parks the thread on the approve route (#81.1)", () => {
    const { io, envelopes, replies } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({
      type: "custom_spec_draft",
      draft: draftWith(["pnpm install left-pad"]),
    });
    const verdict = envelopes.find((e) => e.kind === "laya_verdict")!;
    expect(verdict.payload).toMatchObject({ verdict: { gated: true } });
    // Parked: no execution prompt, status back to spec'ing.
    expect(replies).toHaveLength(0);
    expect(c.approved).toBe(false);
    const statuses = envelopes
      .filter((e) => e.kind === "spec_status")
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses.at(-1)).toBe("spec'ing");
    // Approve starts execution on this host.
    c.approveExecution();
    expect(replies).toHaveLength(1);
    expect(c.approved).toBe(true);
  });

  it("trust escalation: an established namespace auto-runs an external plan (#81.3)", () => {
    const { io, replies } = fakeIo("established");
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({
      type: "custom_spec_draft",
      draft: draftWith(["pnpm install left-pad"]),
    });
    expect(replies).toHaveLength(1); // auto-run, no approval needed
  });

  it("an invalid draft surfaces an error envelope", () => {
    const { io, envelopes } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.onProtocolEvent({ type: "custom_spec_draft", draft: { goal: 42 } });
    expect(envelopes.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("AgentContract lifecycle (#80)", () => {
  it("submitSpecPatch forwards answers and edits as replies (fix 6)", () => {
    const { io, replies } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.submitSpecPatch({ kind: "answer", answers: { q1: "admin" } });
    c.submitSpecPatch({ kind: "edit", field: "goal", value: "new goal" });
    expect(replies[0]).toContain("Answers updated");
    expect(replies[0]).toContain("custom_spec_draft");
    expect(replies[1]).toContain('edited spec field "goal"');
  });

  it("retry re-executes against the restored spec (fix 3)", () => {
    const { io, replies } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.restoreDraft(draftWith(["edit src/a.ts"]));
    c.retryExecution();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("edit src/a.ts");
  });

  it("approveExecution without a live draft still prompts from the original ask", () => {
    const { io, replies } = fakeIo();
    const c = new AgentContract(io, { specMode: "force" });
    c.approveExecution();
    expect(replies[0]).toContain("no plan recorded");
  });

  it("abandon emits the terminal status", () => {
    const { io, envelopes } = fakeIo();
    const c = new AgentContract(io, { specMode: "auto" });
    c.abandon();
    const statuses = envelopes
      .filter((e) => e.kind === "spec_status")
      .map((e) => (e.payload as { status: string }).status);
    expect(statuses).toEqual(["abandoned"]);
  });
});

describe("prompt builders", () => {
  it("the execution prompt carries the plan and forbids off-plan gated work", () => {
    const p = buildExecutionPrompt(draftWith(["edit a", "run tests"]));
    expect(p).toContain("- edit a");
    expect(p).toContain("- run tests");
    expect(p).toContain("Do not run installs, migrations, deletes, or deployments");
  });

  it("the verify-retry prompt quotes the failure output (#82)", () => {
    const p = buildVerifyRetryPrompt("$ pnpm test\n42 failing");
    expect(p).toContain("FAILED automated verification");
    expect(p).toContain("42 failing");
  });
});
