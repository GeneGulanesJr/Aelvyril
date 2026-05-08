import { describe, it, expect } from 'vitest';
import { negotiate } from '../../src/missions/negotiation.js';
import type { Milestone, ValidationVerdict } from '../../src/missions/missions.types.js';

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    index: 0,
    name: 'M1',
    features: ['#1', '#2'],
    status: 'in_progress',
    retry_count: 0,
    ...overrides,
  };
}

function passVerdict(): ValidationVerdict {
  return { passed: true, milestone_index: 0, details: 'OK', failed_features: [], failures: [] };
}

function failVerdict(failedFeatures: string[]): ValidationVerdict {
  return {
    passed: false,
    milestone_index: 0,
    details: 'Failed',
    failed_features: failedFeatures,
    failures: failedFeatures.map(f => ({ feature_id: f, assertion: 'test', expected: 'pass', actual: 'fail' })),
  };
}

describe('negotiate', () => {
  it('both pass → accept', () => {
    const result = negotiate(passVerdict(), passVerdict(), makeMilestone(), [], []);
    expect(result.action).toBe('accept');
  });

  it('scrutiny fails → rescope with failed features', () => {
    const result = negotiate(failVerdict(['#1']), passVerdict(), makeMilestone(), [], []);
    expect(result.action).toBe('rescope');
    expect(result.rescope_changes!.features_to_retry).toEqual(['#1']);
  });

  it('user testing fails → rescope', () => {
    const result = negotiate(passVerdict(), failVerdict(['#2']), makeMilestone(), [], []);
    expect(result.action).toBe('rescope');
    expect(result.rescope_changes!.features_to_retry).toEqual(['#2']);
  });

  it('both fail → rescope with union', () => {
    const result = negotiate(failVerdict(['#1']), failVerdict(['#2']), makeMilestone(), [], []);
    expect(result.action).toBe('rescope');
    expect(result.rescope_changes!.features_to_retry.sort()).toEqual(['#1', '#2']);
  });

  it('max retries exceeded → block', () => {
    const result = negotiate(failVerdict(['#1']), passVerdict(), makeMilestone({ retry_count: 2 }), [], []);
    expect(result.action).toBe('block');
  });

  it('partial pass only retries failed features', () => {
    const result = negotiate(failVerdict(['#1']), passVerdict(), makeMilestone({ features: ['#1', '#2'] }), [], []);
    expect(result.action).toBe('rescope');
    expect(result.rescope_changes!.features_to_retry).toEqual(['#1']);
    expect(result.rescope_changes!.features_to_drop).toEqual([]);
  });
});
