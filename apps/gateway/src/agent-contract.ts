// Agent spec-centric contract (Slice 3): sits between the pi session host's
// RPC stream and the event bus. In spec mode it injects the interview
// protocol, forwards spec_question/spec_draft/diff signals as store-grammar
// envelopes (kind/payload — seq is assigned downstream by the store), and
// tracks the thread lifecycle: draft -> spec'ing -> running -> reviewed /
// abandoned.

import { EventEmitter } from "node:events";
import type { EventEnvelope, PatchSpecBody, SpecDraft, SpecQuestion, ThreadStatus } from "@aelvyril/shared";
import { JsonlDecoder } from "./rpc.js";
import { shouldEnterSpecMode } from "./spec-heuristic.js";

/** Envelope as published to the bus: the store appends `seq` on persist. */
type ContractEnvelope = DistributiveOmit<EventEnvelope, "seq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface AgentSession {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill(): void;
}

export interface AgentContractOptions {
  specMode: "auto" | "force" | "off";
  threadId: string;
}

const SPEC_INTERVIEW_PROMPT =
  "Enter spec-interview mode. First emit spec_question with 2-5 questions covering: " +
  "(a) goal clarity, (b) scope boundaries, (c) constraints. Do not emit spec_draft " +
  "until all questions are answered. Max 3 question rounds, then escalate per spec §6 step 2.";

function emptyDraft(): SpecDraft {
  return { goal: "", filesAffected: [], plan: [], risks: [], questions: [], answers: {} };
}

export class AgentContract extends EventEmitter {
  private readonly session: AgentSession;
  private readonly opts: AgentContractOptions;
  private readonly decoder = new JsonlDecoder();
  private currentDraft: SpecDraft | null = null;
  private specRounds = 0;

  constructor(session: AgentSession, opts: AgentContractOptions) {
    super();
    this.session = session;
    this.opts = opts;
    session.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
  }

  start(prompt: string): void {
    if (shouldEnterSpecMode(prompt, this.opts.specMode)) {
      this.emitStatus("spec'ing");
      this.sendToAgent({ type: "system", message: SPEC_INTERVIEW_PROMPT });
    } else {
      this.emitStatus("running");
      this.sendToAgent({ type: "user", prompt });
    }
  }

  submitSpecPatch(body: PatchSpecBody): void {
    if (!this.currentDraft) this.currentDraft = emptyDraft();
    if (body.kind === "answer") {
      this.specRounds++;
      this.currentDraft = { ...this.currentDraft, answers: { ...this.currentDraft.answers, ...body.answers } };
      this.emitDraft();
      this.sendToAgent({
        type: "user",
        message:
          `Updated answers: ${JSON.stringify(body.answers)}. If all questions answered, emit spec_draft. ` +
          "If still ambiguous, emit another spec_question round.",
      });
    } else {
      this.currentDraft = { ...this.currentDraft, [body.field]: body.value };
      this.emitDraft();
      this.sendToAgent({
        type: "user",
        message: `User edited spec field "${body.field}": ${JSON.stringify(body.value)}`,
      });
    }
  }

  approve(): void {
    this.emitStatus("running");
    this.sendToAgent({
      type: "user",
      message:
        "Spec approved. Execute the plan. Emit message events for execution trace " +
        "and a single diff event on completion.",
    });
  }

  abandon(): void {
    this.emitStatus("abandoned");
    try {
      this.session.kill();
    } catch {
      /* already dead */
    }
  }

  retry(): void {
    this.emitStatus("running");
    this.sendToAgent({ type: "user", message: "Retry the execution against the same spec." });
  }

  get rounds(): number {
    return this.specRounds;
  }

  private onStdout(chunk: Buffer | string): void {
    for (const msg of this.decoder.push(chunk)) {
      if (msg && typeof msg === "object" && "type" in msg) {
        this.handleAgentMessage(msg as { type: string } & Record<string, unknown>);
      }
    }
  }

  private handleAgentMessage(msg: { type: string } & Record<string, unknown>): void {
    switch (msg.type) {
      case "spec_question":
        this.emitEnvelope({
          kind: "spec_question",
          conversationId: this.opts.threadId,
          ts: now(),
          payload: { questions: (msg.questions ?? []) as SpecQuestion[] },
        });
        break;
      case "spec_draft":
        this.currentDraft = msg.draft as SpecDraft;
        this.emitDraft();
        break;
      case "message":
        this.emitEnvelope({
          kind: "text_delta",
          conversationId: this.opts.threadId,
          ts: now(),
          payload: { delta: String(msg.content ?? "") },
        });
        break;
      case "diff":
        this.emitEnvelope({
          kind: "diff",
          conversationId: this.opts.threadId,
          ts: now(),
          payload: { files: (msg.files ?? []) as { path: string; patch: string }[] },
        });
        this.emitStatus("reviewed");
        break;
      case "error":
        this.emitEnvelope({
          kind: "error",
          conversationId: this.opts.threadId,
          ts: now(),
          payload: { message: String(msg.message ?? "agent error") },
        });
        this.emitStatus("reviewed");
        break;
      default:
        break; // non-contract protocol events are the supervisor's business
    }
  }

  private emitDraft(): void {
    if (!this.currentDraft) return;
    this.emitEnvelope({
      kind: "spec_draft",
      conversationId: this.opts.threadId,
      ts: now(),
      payload: { draft: this.currentDraft },
    });
  }

  private emitStatus(status: ThreadStatus): void {
    this.emitEnvelope({ kind: "spec_status", conversationId: this.opts.threadId, ts: now(), payload: { status } });
  }

  private emitEnvelope(e: ContractEnvelope): void {
    this.emit("envelope", e);
  }

  private sendToAgent(msg: unknown): void {
    this.session.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function now(): string {
  return new Date().toISOString();
}
