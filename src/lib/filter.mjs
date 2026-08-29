/**
 * Distill filter (plan Design decision 3): decides whether an observation
 * row may enter the canonical vault DB.
 *
 * Rules:
 *  - type must be one of decision, architecture, bugfix, pattern, preference, learning
 *  - deleted_at must be null (not soft-deleted)
 *  - expires_at must be null or in the future
 *
 * Pure function: row -> boolean.
 */
const DISTILLABLE_TYPES = new Set([
  'decision',
  'architecture',
  'bugfix',
  'pattern',
  'preference',
  'learning',
]);

export function isDistillable(row) {
  if (!row || typeof row !== 'object') return false;
  if (!DISTILLABLE_TYPES.has(row.type)) return false;
  if (row.deleted_at != null) return false;
  if (row.expires_at != null) {
    const expires = new Date(row.expires_at);
    if (Number.isNaN(expires.getTime())) return false;
    if (expires.getTime() <= Date.now()) return false;
  }
  return true;
}
