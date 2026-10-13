import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { copyTree, copyFileInto, fingerprintTree, diffTrees, type LegionFlowPaths } from "@9thlevelsoftware/legion-flow-persist";
import type { MaterializeInput } from "@9thlevelsoftware/legion-flow-engine";

const execFileAsync = promisify(execFile);

export type MaterializeStrategy = "copy" | "worktree";

/** How a tree is made and unmade; orthogonal to the tier that runs things against it. */
export interface TreeStrategy {
  kind: MaterializeStrategy;
  materialize(input: MaterializeInput): Promise<{ treeDir: string }>;
  dispose(treeDir: string): Promise<void>;
}

export class WorktreeUnsupportedError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "WorktreeUnsupportedError";
  }
}

/** A plain copy of the listed files under var/sandbox/<runId>/tree. */
export function copyStrategy(paths: LegionFlowPaths): TreeStrategy {
  return {
    kind: "copy",
    async materialize({ runId, sourceRoot, sourceMode }) {
      const treeDir = join(paths.sandboxDir, runId, "tree");
      await copyTree(sourceRoot, treeDir, { mode: sourceMode });
      return { treeDir };
    },
    async dispose(treeDir) {
      await rm(dirname(treeDir), { recursive: true, force: true });
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `git worktree add --detach HEAD`, then an overlay by hash: every path whose
 * content differs between the checkout (listed in git mode) and the fresh
 * worktree is copied in or deleted, so the result fingerprints exactly like a
 * copy regardless of eol filters. Ignored files are absent by definition.
 */
export function worktreeStrategy(paths: LegionFlowPaths): TreeStrategy {
  const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return {
    kind: "worktree",
    async materialize({ runId, sourceRoot, sourceMode }) {
      if (sourceMode !== "git") throw new WorktreeUnsupportedError("worktree_requires_git", `${sourceRoot} is not the top level of a git repository without submodules; use the copy strategy`);
      const gitDir = (await git(sourceRoot, "rev-parse", "--git-dir")).stdout.trim();
      const absGitDir = join(sourceRoot, gitDir);
      for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "BISECT_LOG"]) {
        if (await exists(join(absGitDir, marker))) throw new WorktreeUnsupportedError("worktree_unsupported_state", `the repository is in the middle of an operation (${marker}); finish it or use the copy strategy`);
      }
      const treeDir = join(paths.varDir, "worktrees", runId);
      await mkdir(dirname(treeDir), { recursive: true });
      await git(sourceRoot, "worktree", "prune");
      await git(sourceRoot, "worktree", "add", "--detach", treeDir, "HEAD");
      const source = await fingerprintTree(sourceRoot, { mode: "git" });
      const fresh = await fingerprintTree(treeDir, { mode: "fs" });
      for (const d of diffTrees(fresh.files, source.files)) {
        if (d.after === null) await rm(join(treeDir, ...d.path.split("/")), { force: true });
        else await copyFileInto(sourceRoot, treeDir, d.path);
      }
      return { treeDir };
    },
    async dispose(treeDir) {
      // The worktree's .git file names the repository; `remove --force` from inside works without knowing the source root.
      try {
        await git(treeDir, "worktree", "remove", "--force", treeDir);
      } catch {
        await rm(treeDir, { recursive: true, force: true });
      }
    },
  };
}

export function strategyFor(kind: MaterializeStrategy, paths: LegionFlowPaths): TreeStrategy {
  return kind === "worktree" ? worktreeStrategy(paths) : copyStrategy(paths);
}
