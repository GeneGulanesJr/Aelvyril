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
  /** Spec-mode trigger (agent spec-centric UI): auto decides via heuristic. */
  specMode: z.enum(["auto", "force", "off"]).default("auto"),
});
export type PromptBody = z.infer<typeof PromptBody>;

export const ConversationState = z.enum([
  "idle",
  "streaming",
  "degraded",
]);
type ConversationState = z.infer<typeof ConversationState>;

/** One interview question the agent asks before writing a spec draft. */
export const SpecQuestion = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    kind: z.enum(["text", "select", "multiselect"]),
    options: z.array(z.string()).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.kind !== "text" && (!q.options || q.options.length === 0)) {
      ctx.addIssue({ code: "custom", message: `${q.kind} questions require options`, path: ["options"] });
    }
  });
export type SpecQuestion = z.infer<typeof SpecQuestion>;

/** The agent's plan-under-negotiation, plus accumulated Q&A. */
export const SpecDraft = z.object({
  goal: z.string(),
  filesAffected: z.array(z.string()),
  plan: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(SpecQuestion),
  answers: z.record(z.string(), z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraft>;

export const ThreadStatus = z.enum(["draft", "spec'ing", "running", "reviewed", "merged", "abandoned"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/** Body for PATCH /v1/threads/:id/spec. */
export const PatchSpecBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), answers: z.record(z.string(), z.string()) }),
  z.object({
    kind: z.literal("edit"),
    field: z.enum(["goal", "filesAffected", "plan", "risks"]),
    value: z.union([z.string(), z.array(z.string())]),
  }),
]);
export type PatchSpecBody = z.infer<typeof PatchSpecBody>;

export const Conversation = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  state: ConversationState,
  createdAt: z.string().datetime({ offset: true }),
});
export type Conversation = z.infer<typeof Conversation>;

/** Thread = Conversation + spec-centric lifecycle (agent spec-centric UI). */
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
