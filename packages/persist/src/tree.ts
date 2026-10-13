import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { access, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Names skipped at any depth, as files or directories. `.legion-flow` keeps a copy of the workspace from recursing into itself. */
export const DEFAULT_TREE_EXCLUDES: readonly string[] = [".git", ".legion-flow", "node_modules"];

/**
 * How "the tree" is defined. `git` is git's view of a checkout: tracked files
 * plus untracked files that are not ignored, so `.env` and `dist/` never enter
 * a sandbox. `fs` is every regular file under the root minus the excludes, and
 * is the only honest mode for a materialized copy, which lives under an ignored
 * path where git would list nothing.
 */
export type TreeMode = "fs" | "git";

export interface TreeOptions {
  mode?: TreeMode;
  excludes?: readonly string[];
}

export interface TreeListing {
  mode: TreeMode;
  /** Relative paths of regular files, forward slashes, sorted. */
  files: string[];
  skippedSymlinks: string[];
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
 * `git` when the root is itself the top level of a git repository with no
 * submodules; `fs` otherwise. A directory merely inside a repository (such as a
 * materialized copy) is `fs`, because git would list nothing there.
 */
export async function detectTreeMode(root: string): Promise<TreeMode> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    const top = stdout.trim();
    if (!top) return "fs";
    const same = (await lstat(top)).ino === (await lstat(root)).ino || relative(top, root) === "";
    if (!same) return "fs";
    if (await exists(join(root, ".gitmodules"))) return "fs";
    return "git";
  } catch {
    return "fs";
  }
}

function excluded(rel: string, skip: Set<string>): boolean {
  return rel.split("/").some((part) => skip.has(part));
}

async function listFs(root: string, skip: Set<string>): Promise<{ files: string[]; skippedSymlinks: string[] }> {
  const files: string[] = [];
  const skippedSymlinks: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        const st = await lstat(abs);
        if (st.isSymbolicLink()) skippedSymlinks.push(rel);
      }
    }
  };
  await visit(root);
  return { files, skippedSymlinks };
}

async function listGit(root: string, skip: Set<string>): Promise<{ files: string[]; skippedSymlinks: string[] }> {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  const files: string[] = [];
  const skippedSymlinks: string[] = [];
  const seen = new Set<string>();
  for (const rel of stdout.split("\0")) {
    if (!rel || seen.has(rel) || excluded(rel, skip)) continue;
    seen.add(rel);
    // `--cached` still lists tracked files deleted in the working tree; lstat decides what is really there.
    let st;
    try {
      st = await lstat(join(root, ...rel.split("/")));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) skippedSymlinks.push(rel);
    else if (st.isFile()) files.push(rel);
  }
  return { files, skippedSymlinks };
}

/** The one listing both the fingerprint and the copy are built on, so they can never disagree about what the tree is. */
export async function listTree(root: string, options: TreeOptions = {}): Promise<TreeListing> {
  const mode = options.mode ?? "fs";
  const skip = new Set(options.excludes ?? DEFAULT_TREE_EXCLUDES);
  const listed = mode === "git" ? await listGit(root, skip) : await listFs(root, skip);
  listed.files.sort();
  return { mode, ...listed };
}

/** @deprecated name kept for callers of slice (a); the filesystem walk. */
export function walkTree(root: string, excludes: readonly string[] = DEFAULT_TREE_EXCLUDES): Promise<TreeListing> {
  return listTree(root, { mode: "fs", excludes });
}

export function fileSha256(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolutePath).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

export interface TreeFingerprint {
  mode: TreeMode;
  /** `sha256:` over the sorted (path, sha256) lines. */
  fingerprint: string;
  /** Relative path to file sha256, for diffing two trees. */
  files: Record<string, string>;
}

export async function fingerprintTree(root: string, options: TreeOptions = {}): Promise<TreeFingerprint> {
  const listing = await listTree(root, options);
  const files: Record<string, string> = {};
  const hash = createHash("sha256");
  for (const rel of listing.files) {
    const sha = await fileSha256(join(root, ...rel.split("/")));
    files[rel] = sha;
    hash.update(`${rel}\0${sha}\n`);
  }
  return { mode: listing.mode, fingerprint: "sha256:" + hash.digest("hex"), files };
}

export async function copyFileInto(src: string, dst: string, rel: string): Promise<void> {
  const parts = rel.split("/");
  if (parts.length > 1) await mkdir(join(dst, ...parts.slice(0, -1)), { recursive: true });
  await copyFile(join(src, ...parts), join(dst, ...parts));
}

/** Copy every file the listing names into `dst`. Returns the file count. */
export async function copyTree(src: string, dst: string, options: TreeOptions = {}): Promise<number> {
  const listing = await listTree(src, options);
  await mkdir(dst, { recursive: true });
  for (const rel of listing.files) await copyFileInto(src, dst, rel);
  return listing.files.length;
}

/** Paths whose hash differs between two listings: changed, added (before null), or removed (after null). */
export function diffTrees(before: Record<string, string>, after: Record<string, string>): { path: string; before: string | null; after: string | null }[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { path: string; before: string | null; after: string | null }[] = [];
  for (const path of [...paths].sort()) {
    const b = before[path] ?? null;
    const a = after[path] ?? null;
    if (b !== a) out.push({ path, before: b, after: a });
  }
  return out;
}
