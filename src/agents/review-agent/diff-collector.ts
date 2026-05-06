import { execSync } from 'child_process';

export interface DiffResult {
  files: string[];
  diff: string;
  stats: { additions: number; deletions: number };
}

export function collectDiff(
  workspace: string,
  ticketBranch: string,
  baseBranch: string
): DiffResult {
  try {
    execSync(`git rev-parse --verify "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git rev-parse --verify "${baseBranch}"`, { cwd: workspace, stdio: 'pipe' });
  } catch {
    throw new Error(`Branch not found: ${ticketBranch} or ${baseBranch}`);
  }

  let diff: string;
  try {
    diff = execSync(`git diff "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch {
    throw new Error(`Failed to get diff between ${ticketBranch} and ${baseBranch}`);
  }

  const files: string[] = [];
  if (diff.trim().length > 0) {
    const fileLines = execSync(`git diff --name-only "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    if (fileLines) {
      files.push(...fileLines.split('\n'));
    }
  }

  let additions = 0;
  let deletions = 0;
  if (diff.trim().length > 0) {
    const statLine = execSync(`git diff --shortstat "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const addMatch = statLine.match(/(\d+) insertion/);
    const delMatch = statLine.match(/(\d+) deletion/);
    additions = addMatch ? parseInt(addMatch[1], 10) : 0;
    deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  }

  return { files, diff, stats: { additions, deletions } };
}
