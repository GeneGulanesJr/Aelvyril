/**
 * LaPis namespaces (spec §7): each Clerk user maps to a LaPis project-scope
 * namespace. Gateway injects this as LAPIS_PROJECT_KEY into session hosts.
 * LaPis lowercases project keys (src/hooks-engine/project.js:34) — we
 * pre-lowercase so gateway logs and memory keys always agree.
 */
export const SHARED_NAMESPACE = "platform";

export function toUserNamespace(clerkUserId: string): string {
  if (!clerkUserId.trim()) throw new Error("clerkUserId must be non-empty");
  return `user:${clerkUserId.toLowerCase()}`;
}
