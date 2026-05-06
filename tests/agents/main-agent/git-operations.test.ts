import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let realExecSync: typeof import('child_process').execSync;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  realExecSync = actual.execSync;
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { execSync } from 'child_process';
import * as gitOps from '../../../src/agents/main-agent/git-operations.js';

const mockedExecSync = vi.mocked(execSync);

function setupGitRepo(): { tmpDir: string; repoDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-git-'));
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  realExecSync('git init', { cwd: repoDir, stdio: 'pipe' });
  realExecSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
  realExecSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test');
  realExecSync('git add .', { cwd: repoDir, stdio: 'pipe' });
  realExecSync('git commit -m "initial"', { cwd: repoDir, stdio: 'pipe' });
  realExecSync('git checkout -b aelvyril/session-sess1', { cwd: repoDir, stdio: 'pipe' });
  return { tmpDir, repoDir };
}

describe('git-operations', () => {
  describe('createTicketBranch', () => {
    let tmpDir: string;
    let repoDir: string;

    beforeEach(() => {
      mockedExecSync.mockClear();
      ({ tmpDir, repoDir } = setupGitRepo());
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a ticket branch from session branch', () => {
      gitOps.createTicketBranch(repoDir, 'tkt-1', 'sess1');
      const current = realExecSync('git branch --show-current', { cwd: repoDir }).toString().trim();
      expect(current).toBe('aelvyril/ticket-tkt-1');
    });

    it('checks out session branch first then creates ticket branch', () => {
      gitOps.createTicketBranch(repoDir, 'tkt-2', 'sess1');
      const branches = realExecSync('git branch', { cwd: repoDir }).toString();
      expect(branches).toContain('aelvyril/ticket-tkt-2');
      expect(branches).toContain('aelvyril/session-sess1');
    });
  });

  describe('mergeTicketBranch', () => {
    let tmpDir: string;
    let repoDir: string;

    beforeEach(() => {
      mockedExecSync.mockClear();
      ({ tmpDir, repoDir } = setupGitRepo());
      realExecSync('git checkout -b aelvyril/ticket-tkt-99', { cwd: repoDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'new feature');
      realExecSync('git add .', { cwd: repoDir, stdio: 'pipe' });
      realExecSync('git commit -m "feature"', { cwd: repoDir, stdio: 'pipe' });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('merges ticket branch into session branch', () => {
      gitOps.mergeTicketBranch(repoDir, 'tkt-99', 'sess1');
      const current = realExecSync('git branch --show-current', { cwd: repoDir }).toString().trim();
      expect(current).toBe('aelvyril/session-sess1');
      expect(fs.existsSync(path.join(repoDir, 'feature.txt'))).toBe(true);
    });
  });

  describe('resetTicketBranch', () => {
    let tmpDir: string;
    let repoDir: string;

    beforeEach(() => {
      mockedExecSync.mockClear();
      ({ tmpDir, repoDir } = setupGitRepo());
      realExecSync('git checkout -b aelvyril/ticket-tkt-50', { cwd: repoDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(repoDir, 'unwanted.txt'), 'bad changes');
      realExecSync('git add .', { cwd: repoDir, stdio: 'pipe' });
      realExecSync('git commit -m "bad"', { cwd: repoDir, stdio: 'pipe' });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resets ticket branch to session branch state', () => {
      gitOps.resetTicketBranch(repoDir, 'tkt-50', 'sess1');
      const current = realExecSync('git branch --show-current', { cwd: repoDir }).toString().trim();
      expect(current).toBe('aelvyril/ticket-tkt-50');
      expect(fs.existsSync(path.join(repoDir, 'unwanted.txt'))).toBe(false);
    });
  });

  describe('createPR', () => {
    beforeEach(() => {
      mockedExecSync.mockClear();
    });

    it('pushes branch and returns PR URL', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git push')) return '';
        if (cmd.includes('gh pr create')) return 'https://github.com/repo/pull/42\n';
        return '';
      });

      const result = gitOps.createPR('/fake/workspace', 'sess1');
      expect(result).toBe('https://github.com/repo/pull/42');
      expect(mockedExecSync).toHaveBeenCalledTimes(2);
    });

    it('uses the correct session branch name', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('git push')) return '';
        if (cmd.includes('gh pr create')) return 'https://github.com/repo/pull/1\n';
        return '';
      });

      gitOps.createPR('/fake/workspace', 'sess1');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('aelvyril/session-sess1'),
        expect.anything()
      );
    });
  });

  describe('mergePR', () => {
    beforeEach(() => {
      mockedExecSync.mockClear();
    });

    it('merges PR via gh CLI', () => {
      mockedExecSync.mockReturnValue('');
      gitOps.mergePR('/fake/workspace', 'sess1');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('gh pr merge'),
        expect.objectContaining({ cwd: '/fake/workspace' })
      );
    });

    it('uses the correct session branch in merge command', () => {
      mockedExecSync.mockReturnValue('');
      gitOps.mergePR('/fake/workspace', 'sess1');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('aelvyril/session-sess1'),
        expect.anything()
      );
    });
  });
});
