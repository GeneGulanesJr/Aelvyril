import { describe, it, expect } from 'vitest';
import { isDistillable } from '../src/lib/filter.mjs';

const base = {
  type: 'decision',
  title: 't',
  content: 'c',
  deleted_at: null,
  expires_at: null,
};

const DISTILL_TYPES = ['decision', 'architecture', 'bugfix', 'pattern', 'preference', 'learning'];
const NOISE_TYPES = ['progress', 'accomplished', 'session_summary', 'discovery'];

describe('isDistillable', () => {
  it('accepts every distillable type', () => {
    for (const type of DISTILL_TYPES) {
      expect(isDistillable({ ...base, type }), type).toBe(true);
    }
  });

  it('rejects noise types', () => {
    for (const type of NOISE_TYPES) {
      expect(isDistillable({ ...base, type }), type).toBe(false);
    }
  });

  it('rejects unknown type', () => {
    expect(isDistillable({ ...base, type: 'musing' })).toBe(false);
  });

  it('rejects soft-deleted rows', () => {
    expect(isDistillable({ ...base, deleted_at: '2026-08-01T00:00:00Z' })).toBe(false);
  });

  it('accepts null expires_at', () => {
    expect(isDistillable({ ...base, expires_at: null })).toBe(true);
  });

  it('rejects expired rows (past expires_at)', () => {
    expect(isDistillable({ ...base, expires_at: '2020-01-01T00:00:00Z' })).toBe(false);
  });

  it('accepts future expires_at', () => {
    expect(isDistillable({ ...base, expires_at: '2099-01-01T00:00:00Z' })).toBe(true);
  });

  it('accepts and rejects around the boundary (now)', () => {
    const now = new Date();
    expect(isDistillable({ ...base, expires_at: new Date(now.getTime() + 1).toISOString() })).toBe(true);
    expect(isDistillable({ ...base, expires_at: new Date(now.getTime() - 1).toISOString() })).toBe(false);
  });

  it('rejects rows missing a type', () => {
    expect(isDistillable({ ...base, type: undefined })).toBe(false);
  });
});
