import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { collectDiff } from '../../../src/agents/review-agent/diff-collector.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('collectDiff', () => {
  let tmpDir: string;
  let mainBranch: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-diff-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export function hello() { return "world"; }\n');
    execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    mainBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b aelvyril/ticket-#1', { cwd: tmpDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export function hello() { return "hello"; }\n');
    fs.writeFileSync(path.join(tmpDir, 'new-file.ts'), 'export const NEW = true;\n');
    execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "ticket(#1): update hello"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects diff between ticket branch and base branch', () => {
    const result = collectDiff(tmpDir, 'aelvyril/ticket-#1', mainBranch);
    expect(result.files).toContain('hello.ts');
    expect(result.files).toContain('new-file.ts');
    expect(result.diff).toContain('return "hello"');
    expect(result.diff).toContain('NEW = true');
  });

  it('returns empty diff when no changes', () => {
    execSync(`git checkout ${mainBranch}`, { cwd: tmpDir, stdio: 'pipe' });
    execSync('git checkout -b empty-branch', { cwd: tmpDir, stdio: 'pipe' });

    const result = collectDiff(tmpDir, 'empty-branch', mainBranch);
    expect(result.files).toEqual([]);
    expect(result.diff).toBe('');
  });

  it('throws when branch does not exist', () => {
    expect(() => collectDiff(tmpDir, 'nonexistent-branch', mainBranch)).toThrow();
  });
});
