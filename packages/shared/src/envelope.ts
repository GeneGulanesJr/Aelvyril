import { z } from "zod";
import { SpecDraft, SpecQuestion, ThreadStatus } from "./api.js";

export const EnvelopeKind = z.enum([
  "text_delta",
  "tool_call",
  "tool_result",
  "subagent_spawn",
  "sandbox_exec",
  "sandbox_promote",
  "laya_verdict",
  "user_message",
  "session_state",
  "error",
  // Spec-centric SSE events (Slice 1 contract). Emitted by the gateway's
  // `agent-contract.ts` while the agent is in the spec interview / execution
  // lifecycle. Consumers (frontend `use-thread`, live traces) branch off
  // these kinds the same way they do for `text_delta`, etc.
  "spec_question",
  "spec_draft",
  "spec_status",
  "diff",
]);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

const payloadSchemas = {
  text_delta: z.object({ delta: z.string() }),
  tool_call: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
  }),
  tool_result: z.object({
    toolCallId: z.string().min(1),
    isError: z.boolean(),
  }),
  subagent_spawn: z.object({
    mode: z.enum(["single", "parallel", "chain"]),
    agents: z.array(z.object({ agent: z.string(), task: z.string() })).min(1),
  }),
  sandbox_exec: z.object({
    profile: z.string().min(1),
    sandboxId: z.string().min(1).optional(),
  }),
  sandbox_promote: z.object({
    sandboxId: z.string().min(1),
    paths: z.array(z.string()),
  }),
  laya_verdict: z.object({
    tool: z.string().min(1),
    verdict: z.record(z.string(), z.unknown()),
  }),
  user_message: z.object({ text: z.string().min(1).max(1_000_000) }),
  session_state: z.object({
    state: z.enum(["idle", "streaming", "degraded", "restarted"]),
  }),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
  spec_question: z.object({
    questions: z.array(SpecQuestion),
  }),
  spec_draft: z.object({
    draft: SpecDraft,
  }),
  spec_status: z.object({
    status: ThreadStatus,
  }),
  diff: z.object({
    files: z.array(z.object({ path: z.string(), patch: z.string() })),
  }),
} as const;

const envelopeShape = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: EnvelopeKind,
});

export const EventEnvelope = z.discriminatedUnion("kind", [
  envelopeShape.extend({ kind: z.literal("text_delta"), payload: payloadSchemas.text_delta }),
  envelopeShape.extend({ kind: z.literal("tool_call"), payload: payloadSchemas.tool_call }),
  envelopeShape.extend({ kind: z.literal("tool_result"), payload: payloadSchemas.tool_result }),
  envelopeShape.extend({ kind: z.literal("subagent_spawn"), payload: payloadSchemas.subagent_spawn }),
  envelopeShape.extend({ kind: z.literal("sandbox_exec"), payload: payloadSchemas.sandbox_exec }),
  envelopeShape.extend({ kind: z.literal("sandbox_promote"), payload: payloadSchemas.sandbox_promote }),
  envelopeShape.extend({ kind: z.literal("laya_verdict"), payload: payloadSchemas.laya_verdict }),
  envelopeShape.extend({ kind: z.literal("user_message"), payload: payloadSchemas.user_message }),
  envelopeShape.extend({ kind: z.literal("session_state"), payload: payloadSchemas.session_state }),
  envelopeShape.extend({ kind: z.literal("error"), payload: payloadSchemas.error }),
  envelopeShape.extend({ kind: z.literal("spec_question"), payload: payloadSchemas.spec_question }),
  envelopeShape.extend({ kind: z.literal("spec_draft"), payload: payloadSchemas.spec_draft }),
  envelopeShape.extend({ kind: z.literal("spec_status"), payload: payloadSchemas.spec_status }),
  envelopeShape.extend({ kind: z.literal("diff"), payload: payloadSchemas.diff }),
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// Per-kind stand-alone schemas for the four spec envelopes. Mirrors the
// `EventEnvelope` discriminated-union entries above so consumers (frontend
// `use-thread`, ops tooling) can validate a single envelope in isolation
// without invoking the full union.
export const SpecQuestionEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_question"),
  payload: z.object({ questions: z.array(SpecQuestion) }),
});
export const SpecDraftEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_draft"),
  payload: z.object({ draft: SpecDraft }),
});
export const SpecStatusEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_status"),
  payload: z.object({ status: ThreadStatus }),
});
export const DiffEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("diff"),
  payload: z.object({
    files: z.array(z.object({ path: z.string(), patch: z.string() })),
  }),
});

/**
 * Defensive parser for a single SSE frame. Returns the parsed envelope on
 * success or `null` if the input is malformed JSON or fails schema
 * validation. Never throws.
 */
export function parseEnvelope(raw: string): EventEnvelope | null {
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = EventEnvelope.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
