// src/workspace/workspace-manager.ts
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export class WorkspaceManager {
  constructor(private baseDir: string) {}

  clone(repoUrl: string, sessionId: string): string {
    const workspace = path.join(this.baseDir, 'workspaces', sessionId);
    fs.mkdirSync(path.dirname(workspace), { recursive: true });

    execSync(`git clone "${repoUrl}" "${workspace}"`, { stdio: 'pipe' });

    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`git checkout -b "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });

    return workspace;
  }

  createTicketBranch(workspace: string, ticketId: string): string {
    const branch = `aelvyril/ticket-${ticketId}`;
    execSync(`git checkout -b "${branch}"`, { cwd: workspace, stdio: 'pipe' });
    return branch;
  }

  mergeTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    const ticketBranch = `aelvyril/ticket-${ticketId}`;

    execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git merge "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  resetTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    const ticketBranch = `aelvyril/ticket-${ticketId}`;

    execSync(`git checkout "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git reset --hard "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  commit(workspace: string, message: string): void {
    execSync('git add -A', { cwd: workspace, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: workspace, stdio: 'pipe' });
  }

  createPR(workspace: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`git push origin "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`gh pr create --fill --head "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  mergePR(workspace: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`gh pr merge "${sessionBranch}" --merge --auto`, { cwd: workspace, stdio: 'pipe' });
  }
}
