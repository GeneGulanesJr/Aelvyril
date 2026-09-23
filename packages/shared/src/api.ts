import { z } from "zod";

/** Route literals shared by apps/web (client) and apps/gateway (server). */
export const ROUTES = {
  conversations: "/v1/conversations",
  conversation: (id: string) => `/v1/conversations/${id}`,
  conversationEvents: (id: string) => `/v1/conversations/${id}/events`,
  conversationPrompt: (id: string) => `/v1/conversations/${id}/prompt`,
  conversationAbort: (id: string) => `/v1/conversations/${id}/abort`,
  conversationRename: (id: string) => `/v1/conversations/${id}`,
} as const;

export const CreateConversationBody = z.object({
  title: z.string().min(1).max(200).optional(),
  /** Workspace name from the host allowlist — never a raw path (spec §10). */
  workspace: z.string().min(1).optional(),
});
export type CreateConversationBody = z.infer<typeof CreateConversationBody>;

export const RenameConversationBody = z.object({
  title: z.string().min(1).max(200),
});
export type RenameConversationBody = z.infer<typeof RenameConversationBody>;

export const PromptBody = z.object({
  message: z.string().min(1).max(1_000_000),
  /** Required by gateway when the agent is already streaming (pi RPC semantics). */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
  /**
   * Spec-centric mode override for this prompt only.
   *   - `auto` (default): gateway heuristic decides whether to enter the
   *     spec interview before running.
   *   - `force`: always enter the spec interview regardless of heuristic.
   *   - `off`: skip the spec interview and stream immediately.
   */
  specMode: z.enum(["auto", "force", "off"]).default("auto"),
});
export type PromptBody = z.infer<typeof PromptBody>;

export const ConversationState = z.enum([
  "idle",
  "streaming",
  "degraded",
]);
export type ConversationState = z.infer<typeof ConversationState>;

export const Conversation = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  state: ConversationState,
  createdAt: z.string().datetime({ offset: true }),
});
export type Conversation = z.infer<typeof Conversation>;

// ---------------------------------------------------------------------------
// Spec-centric types (Slice 1 contract).
//
// A `Thread` is the superset of a `Conversation` used by the new UI surface:
// everything from the chat-first days, plus a spec lifecycle (`status`) and
// the structured spec artifacts the agent emits during an interview. The
// `Conversation` type is kept as the lean DTO for adapters and routes that
// don't care about spec state.
// ---------------------------------------------------------------------------

/** Single question the spec interview asks the user. */
export const SpecQuestion = z.object({
  /** Stable, caller-chosen identifier — used as the key in `SpecDraft.answers`. */
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** `text` is a free-form response; `select` / `multiselect` constrain to `options`. */
  kind: z.enum(["text", "select", "multiselect"]),
  options: z.array(z.string()).optional(),
});
export type SpecQuestion = z.infer<typeof SpecQuestion>;

/** Structured plan the agent produces after the spec interview. */
export const SpecDraft = z.object({
  goal: z.string(),
  filesAffected: z.array(z.string()),
  plan: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(SpecQuestion),
  answers: z.record(z.string(), z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraft>;

/** Thread lifecycle as defined by the spec-centric UI redesign. */
export const ThreadStatus = z.enum([
  "draft",
  "spec'ing",
  "running",
  "reviewed",
  "merged",
  "abandoned",
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/** PATCH /v1/threads/:id body — answer a question OR edit a draft field. */
export const PatchSpecBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("edit"),
    field: z.enum(["goal", "filesAffected", "plan", "risks"]),
    value: z.union([z.string(), z.array(z.string())]),
  }),
]);
export type PatchSpecBody = z.infer<typeof PatchSpecBody>;

/** Thread DTO returned by `/v1/threads/*` routes. */
export const Thread = Conversation.extend({
  status: ThreadStatus,
  specDraft: SpecDraft.nullable(),
  specQuestions: z.array(SpecQuestion),
  specAnswers: z.record(z.string(), z.string()),
});
export type Thread = z.infer<typeof Thread>;

/** Manual update flow: response from GET /v1/admin/update/status. */
export const UpdateStatus = z.object({
  currentSha: z.string(),
  currentShort: z.string(),
  remoteSha: z.string(),
  remoteShort: z.string(),
  /** 0 = up-to-date, >0 = N commits behind. */
  behind: z.number().int().nonnegative(),
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: z.string().datetime({ offset: true }),
  /** Absolute path to the repo root the gateway was started from. */
  repoPath: z.string(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;
