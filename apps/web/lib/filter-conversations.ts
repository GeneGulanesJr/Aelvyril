import type { Conversation } from "@aelvyril/shared";

/**
 * Pure filter for the conversation list. Empty query → all rows. Otherwise
 * case-insensitive substring match against `title`. Conversations with null
 * titles are surfaced only when the query is empty (no useful match text).
 */
export function filterConversations(
  conversations: Conversation[],
  query: string,
): Conversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return conversations;
  return conversations.filter((c) => c.title !== null && c.title.toLowerCase().includes(q));
}