// #80: the diff envelope's producer. The gateway owns the spawn cwd, so on
// a settled execution turn it computes the workspace's working-tree diff
// itself — the agent never has to be trusted to report its own changes.
// Injectable exec keeps tests hermetic; the default shells out to git.

import { execFile } from "node:child_process";

export interface FilePatch {
  path: string;
  patch: string;
}

export type GitExec = (
  args: string[],
  cwd: string,
) => Promise<{ ok: boolean; stdout: string }>;

export const defaultGitExec: GitExec = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout ?? "") });
      },
    );
  });

/**
 * Per-file patches of the working tree vs HEAD (`git diff HEAD`) — what did
 * THIS execution change. Untracked files are included as synthetic new-file
 * patches (the most common outcome of "create a component"); their content
 * is not inlined (bounded envelopes), the path list is the review signal.
 *
 * Returns null when the cwd is not a git work tree — callers skip the diff
 * envelope rather than fail the turn; returns [] for a clean tree.
 */
export async function computeWorkspaceDiff(
  cwd: string,
  exec: GitExec = defaultGitExec,
): Promise<FilePatch[] | null> {
  const probe = await exec(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!probe.ok || probe.stdout.trim() !== "true") return null;

  const head = await exec(["--no-pager", "diff", "HEAD"], cwd);
  const patches = splitUnifiedDiff(head.stdout);

  const others = await exec(["ls-files", "--others", "--exclude-standard"], cwd);
  if (others.ok) {
    for (const line of others.stdout.split("\n")) {
      const path = line.trim();
      if (path) patches.push({ path, patch: untrackedPatch(path) });
    }
  }
  return patches;
}

/** Split `git diff` output into per-file unified patches. */
function splitUnifiedDiff(diff: string): FilePatch[] {
  if (!diff.trim()) return [];
  const out: FilePatch[] = [];
  const chunks = diff.split(/^diff --git /m).filter((c) => c.trim().length > 0);
  for (const chunk of chunks) {
    // First line of the chunk: "a/path b/path"
    const header = chunk.slice(0, chunk.indexOf("\n"));
    const bPath = header.match(/ b\/(.+)$/)?.[1];
    if (!bPath) continue;
    out.push({ path: bPath, patch: `diff --git ${chunk}`.trimEnd() });
  }
  return out;
}

function untrackedPatch(path: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n(untracked file — content not inlined)\n`;
}
