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

    remoteRepo = path.join(tmpDir, 'remote-repo');
    fs.mkdirSync(remoteRepo);
    execSync('git config --global user.email "test@test.com"');
    execSync('git config --global user.name "Test"');
    execSync('git init', { cwd: remoteRepo });
    fs.writeFileSync(path.join(remoteRepo, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: remoteRepo });
    execSync('git commit -m "initial"', { cwd: remoteRepo });

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

    fs.writeFileSync(path.join(workspace, 'test.txt'), 'hello');
    execSync('git add .', { cwd: workspace });
    execSync('git commit -m "test change"', { cwd: workspace });

    wm.mergeTicketBranch(workspace, 'ticket-99', 'test-session-3');

    const current = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(current).toBe('aelvyril/session-test-session-3');

    expect(fs.existsSync(path.join(workspace, 'test.txt'))).toBe(true);
  });
});
