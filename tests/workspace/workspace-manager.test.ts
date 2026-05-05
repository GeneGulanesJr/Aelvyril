// tests/workspace/workspace-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

describe('WorkspaceManager', () => {
  let wm: WorkspaceManager;
  let tmpDir: string;
  let remoteRepo: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-ws-'));

    // Create a bare remote repo
    remoteRepo = path.join(tmpDir, 'remote-repo');
    fs.mkdirSync(remoteRepo);
    execSync('git init --bare', { cwd: remoteRepo });

    // Create a working copy to push initial commit
    const workDir = path.join(tmpDir, 'init-repo');
    execSync(`git clone "${remoteRepo}" "${workDir}"`, { stdio: 'pipe' });
    fs.writeFileSync(path.join(workDir, 'README.md'), '# Test Repo');
    execSync('git add . && git commit -m "initial"', { cwd: workDir });
    execSync('git push origin master', { cwd: workDir, stdio: 'pipe' });

    wm = new WorkspaceManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clones a repo and creates session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-1');
    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'README.md'))).toBe(true);

    const branch = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(branch).toBe('aelvyril/session-test-session-1');
  });

  it('creates a ticket branch from session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-2');
    wm.createTicketBranch(workspace, 'ticket-42');

    const branches = execSync('git branch', { cwd: workspace }).toString();
    expect(branches).toContain('aelvyril/ticket-ticket-42');

    const current = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(current).toBe('aelvyril/ticket-ticket-42');
  });

  it('merges ticket branch into session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-3');
    wm.createTicketBranch(workspace, 'ticket-99');

    // Make a change on the ticket branch
    fs.writeFileSync(path.join(workspace, 'test.txt'), 'hello');
    execSync('git add .', { cwd: workspace });
    execSync('git commit -m "test change"', { cwd: workspace });

    // Merge back
    wm.mergeTicketBranch(workspace, 'ticket-99', 'test-session-3');

    const current = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(current).toBe('aelvyril/session-test-session-3');

    expect(fs.existsSync(path.join(workspace, 'test.txt'))).toBe(true);
  });

  it('commits all changes in workspace', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-4');
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'content');
    wm.commit(workspace, 'add new file');

    const log = execSync('git log --oneline -1', { cwd: workspace }).toString();
    expect(log).toContain('add new file');
  });
});
