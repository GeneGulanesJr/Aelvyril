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
