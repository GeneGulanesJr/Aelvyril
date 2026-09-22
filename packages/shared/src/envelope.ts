import { z } from "zod";

export const EnvelopeKind = z.enum([
  "text_delta",
  "tool_call",
  "tool_result",
  "subagent_spawn",
  "sandbox_exec",
  "sandbox_promote",
  "laya_verdict",
  "session_state",
  "error",
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
  session_state: z.object({
    state: z.enum(["idle", "streaming", "degraded", "restarted"]),
  }),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
} as const;

const envelopeShape = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: EnvelopeKind,
});

export const EventEnvelope = z.union(
  EnvelopeKind.options.map((kind) =>
    envelopeShape.extend({ kind: z.literal(kind), payload: payloadSchemas[kind] }),
  ),
);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
