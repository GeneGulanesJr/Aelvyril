// Agent spec-centric contract (#80: this file used to be dead code — it
// parsed a made-up stdout protocol nothing spoke). It now sits between the
// pi session host's RPC stream and the event bus: the supervisor feeds it
// protocol events; it builds turn prompts carrying the spec protocol
// (#81: the AGENT decides when to ask, the gateway never forces an
// interview off a regex), translates the agent's custom_spec_question /
// custom_spec_draft signals into schema-validated envelopes, enforces the
// bounded question budget, and auto-runs reversible plans while leaving
// gated plans parked on the approve route.

import type {
  EventEnvelope,
  PatchSpecBody,
  SpecDraft,
  ThreadStatus,
} from "@aelvyril/shared";
import { SpecDraft as SpecDraftSchema, SpecQuestion as SpecQuestionSchema } from "@aelvyril/shared";
import { classifyPlan, type Autonomy } from "./risk.js";
import { shouldEnterSpecMode } from "./spec-heuristic.js";

/** Envelope as published to the bus: the store appends `seq` on persist. */
export type ContractEnvelope = DistributiveOmit<EventEnvelope, "seq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SpecMode = "auto" | "force" | "off";

export interface AgentContractIo {
  threadId: string;
  /** Follow-up prompt — only legal while the agent is settled. */
  reply(message: string): void;
  /** Publish a store-grammar envelope (bus persists + fans out). */
  publish(e: ContractEnvelope): void;
  /** Persist the draft blob so approve works without a live session (#80). */
  persistDraft(draft: SpecDraft): void;
  /** Fresh autonomy per decision — trust may have moved (#81.3). */
  autonomy(): Autonomy;
}

export interface AgentContractOptions {
  specMode: SpecMode;
  /** Bounded question budget (#81.2). Default 3 rounds. */
  maxSpecRounds?: number;
}

export const SPEC_PROTOCOL_INSTRUCTIONS =
  "Spec protocol: when the request is ambiguous or multi-part, ask 2-5 " +
  "clarifying questions BEFORE executing by emitting one JSON line " +
  '{"type":"custom_spec_question","questions":[{"id":"q1","prompt":"...","kind":"text"}]} ' +
  "(kind: text|select|multiselect; select/multiselect require options), " +
  "then END YOUR TURN. After the answers arrive, emit the plan as one JSON " +
  "line " +
  '{"type":"custom_spec_draft","draft":{"goal","filesAffected","plan","risks","questions","answers"}} ' +
  "and end your turn again — the gateway starts execution. Never re-ask an " +
  "answered question.";

const FORCE_INTERVIEW_INSTRUCTIONS =
  "This thread runs in forced spec mode: you MUST ask at least one round of " +
  "clarifying questions (custom_spec_question) and emit a spec draft " +
  "(custom_spec_draft) before any edits.";

const DEAD_MAN_INSTRUCTIONS =
  "This request pattern-matches a broad, multi-part ask: the spec protocol " +
  "applies — ask before executing unless the task is genuinely trivial.";

/** Prompt for the approved execution phase (#80 fix 3). */
export function buildExecutionPrompt(draft: SpecDraft | null): string {
  const plan = draft?.plan?.length ? draft.plan.map((s) => `- ${s}`).join("\n") : "(no plan recorded)";
  const goal = draft?.goal || "the user's original request";
  return (
    `Spec approved. Goal: ${goal}\nPlan:\n${plan}\n` +
    "Execute the plan now. Stay inside the workspace. Do not run installs, " +
    "migrations, deletes, or deployments that the plan does not list. " +
    "When finished, stop — the gateway computes the diff."
  );
}

export function buildVerifyRetryPrompt(failure: string): string {
  return (
    "Your changes FAILED automated verification (tests/lint/typecheck). " +
    "Failure output:\n\n" +
    `${failure}\n\n` +
    "Fix the failures and finish — do not reopen the spec."
  );
}

export class AgentContract {
  private readonly io: AgentContractIo;
  private specMode: SpecMode;
  private readonly maxSpecRounds: number;
  private specRounds = 0;
  private currentDraft: SpecDraft | null = null;
  /** An interview round is outstanding — the settle pipeline stands down. */
  awaitingInterview = false;
  /** The user (or auto-run) approved THIS execution round. */
  approved = false;
  /** A gated action stopped the run — escalate, skip the settle pipeline. */
  gateStopped = false;
  /** Gated actions observed this round, keyed by reason; POST /approve
   *  moves them into allowedGated so the retried run can proceed. */
  private readonly pendingGated = new Set<string>();
  private readonly allowedGated = new Set<string>();

  constructor(io: AgentContractIo, opts: AgentContractOptions) {
    this.io = io;
    this.specMode = opts.specMode;
    this.maxSpecRounds = opts.maxSpecRounds ?? 3;
  }

  get rounds(): number {
    return this.specRounds;
  }

  get draft(): SpecDraft | null {
    return this.currentDraft;
  }

  /** Per-turn override (the route carries specMode on every prompt). */
  setTurnSpecMode(mode: SpecMode): void {
    this.specMode = mode;
  }

  /** Reattach the persisted draft after a respawn / restart (#80). */
  restoreDraft(draft: SpecDraft | null): void {
    this.currentDraft = draft;
  }

  /** Approve clears the gated actions the user just reviewed (#81). */
  allowPendingGated(): void {
    for (const reason of this.pendingGated) this.allowedGated.add(reason);
    this.pendingGated.clear();
  }

  /** Live gate check for a classified action (#81). */
  isActionAllowed(reason: string): boolean {
    return this.allowedGated.has(reason);
  }

  notePendingGated(reason: string): void {
    this.pendingGated.add(reason);
  }

  /**
   * Wrap a user prompt with the spec-protocol instructions (#81.2: the
   * trigger moves into the agent). `off` passes the message untouched;
   * `force` mandates the interview; `auto` delegates the decision to the
   * model, with the legacy regex demoted to a dead-man switch that only
   * STRENGTHENS the instruction.
   */
  wrapPrompt(message: string): string {
    if (this.specMode === "off") return message;
    const parts = [message, SPEC_PROTOCOL_INSTRUCTIONS];
    if (this.specMode === "force") parts.push(FORCE_INTERVIEW_INSTRUCTIONS);
    else if (shouldEnterSpecMode(message, "auto")) parts.push(DEAD_MAN_INSTRUCTIONS);
    return parts.join("\n\n");
  }

  /** Called for every protocol event; contract signals are consumed here. */
  onProtocolEvent(ev: { type: string } & Record<string, unknown>): void {
    if (ev.type === "custom_spec_question") this.onSpecQuestion(ev);
    else if (ev.type === "custom_spec_draft") this.onSpecDraft(ev);
  }

  private onSpecQuestion(ev: { type: string } & Record<string, unknown>): void {
    const parsed = SpecQuestionSchema.array().safeParse(ev.questions);
    if (!parsed.success) {
      this.io.publish({
        kind: "error",
        conversationId: this.io.threadId,
        ts: now(),
        payload: { message: "agent emitted an invalid spec_question signal" },
      });
      return;
    }
    this.awaitingInterview = true;
    this.specRounds++;
    this.emitStatus("spec'ing");
    this.io.publish({
      kind: "spec_question",
      conversationId: this.io.threadId,
      ts: now(),
      payload: { questions: parsed.data },
    });
    if (this.specRounds > this.maxSpecRounds) {
      // Bounded question budget (#81.2): past the budget the agent is told
      // to proceed on best judgment instead of interrogating forever.
      this.io.reply(
        `Question budget exhausted (${this.maxSpecRounds} rounds). Proceed on best ` +
          "judgment; record every assumption in the spec draft's risks field. " +
          "Emit custom_spec_draft and end your turn.",
      );
    }
  }

  private onSpecDraft(ev: { type: string } & Record<string, unknown>): void {
    const parsed = SpecDraftSchema.safeParse(ev.draft);
    if (!parsed.success) {
      this.io.publish({
        kind: "error",
        conversationId: this.io.threadId,
        ts: now(),
        payload: { message: "agent emitted an invalid spec_draft signal" },
      });
      return;
    }
    this.currentDraft = parsed.data;
    this.awaitingInterview = false;
    this.io.publish({
      kind: "spec_draft",
      conversationId: this.io.threadId,
      ts: now(),
      payload: { draft: parsed.data },
    });
    this.io.persistDraft(parsed.data);
    this.decideExecution(parsed.data);
  }

  /**
   * #81.1: gate per risk class, not per plan. A plan whose steps are all
   * reversible AUTO-RUNS (post-hoc diff review covers it); a plan with any
   * gated step parks the thread on the approve route. The classification is
   * published as the laya_verdict envelope — its first real producer.
   */
  private decideExecution(draft: SpecDraft): void {
    const verdict = classifyPlan(draft.plan ?? [], { autonomy: this.io.autonomy() });
    this.io.publish({
      kind: "laya_verdict",
      conversationId: this.io.threadId,
      ts: now(),
      payload: {
        tool: "risk-classifier",
        verdict: { stage: "plan", gated: verdict.gated, items: verdict.items },
      },
    });
    if (verdict.gated) {
      this.emitStatus("spec'ing"); // parked awaiting POST /approve
      return;
    }
    this.beginExecution();
    this.io.reply(buildExecutionPrompt(draft));
  }

  /** The user approved the (gated) plan — execution starts on THIS host. */
  approveExecution(): void {
    this.beginExecution();
    this.io.reply(buildExecutionPrompt(this.currentDraft));
  }

  /** User spec patches are forwarded so the agent re-drafts (#80 fix 6). */
  submitSpecPatch(body: PatchSpecBody): void {
    if (body.kind === "answer") {
      this.io.reply(
        `Answers updated: ${JSON.stringify(body.answers)}. If all questions are ` +
          "answered, emit custom_spec_draft and end your turn. If still " +
          "ambiguous, emit one more custom_spec_question round.",
      );
    } else {
      this.io.reply(`User edited spec field "${body.field}": ${JSON.stringify(body.value)}`);
    }
  }

  /** #80 fix 3: retry re-executes against the same spec. */
  retryExecution(): void {
    this.beginExecution();
    this.io.reply(buildExecutionPrompt(this.currentDraft));
  }

  /** Flip into the execution phase (approve / auto-run / retry share it). */
  beginExecution(): void {
    this.approved = true;
    this.gateStopped = false;
    this.awaitingInterview = false;
    this.emitStatus("running");
  }

  abandon(): void {
    this.emitStatus("abandoned");
  }

  private emitStatus(status: ThreadStatus): void {
    this.io.publish({
      kind: "spec_status",
      conversationId: this.io.threadId,
      ts: now(),
      payload: { status },
    });
  }
}

function now(): string {
  return new Date().toISOString();
}
