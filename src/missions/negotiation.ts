import type { Milestone, HandoffEntry, ErrorEntry, ValidationVerdict, NegotiationVerdict } from './missions.types.js';

export function negotiate(
  scrutiny: ValidationVerdict,
  userTesting: ValidationVerdict,
  milestone: Milestone,
  handoffs: HandoffEntry[],
  errorLog: ErrorEntry[],
  maxRetries: number = 2,
): NegotiationVerdict {
  if (scrutiny.passed && userTesting.passed) {
    return { action: 'accept', reason: 'All validations passed' };
  }

  if (milestone.retry_count >= maxRetries) {
    return {
      action: 'block',
      reason: `Max retries (${maxRetries}) exceeded for milestone ${milestone.name}`,
    };
  }

  const failedFeatures = new Set([
    ...scrutiny.failed_features,
    ...userTesting.failed_features,
  ]);

  return {
    action: 'rescope',
    reason: `Validation failures in: ${[...failedFeatures].join(', ')}`,
    rescope_changes: {
      features_to_retry: [...failedFeatures],
      features_to_drop: [],
      features_to_add: [],
    },
  };
}
