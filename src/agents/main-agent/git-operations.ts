// src/agents/main-agent/git-operations.ts
import { execSync } from 'child_process';

export function createTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git checkout -b "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function mergeTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git merge "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function resetTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git reset --hard "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function createPR(workspace: string, sessionId: string): string {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  execSync(`git push origin "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  const output = execSync(`gh pr create --fill --head "${sessionBranch}"`, {
    cwd: workspace, stdio: 'pipe',
  }).toString().trim();
  return output;
}

export function mergePR(workspace: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  execSync(`gh pr merge "${sessionBranch}" --merge`, { cwd: workspace, stdio: 'pipe' });
}
