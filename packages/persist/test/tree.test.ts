import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTree, fingerprintTree, copyTree, diffTrees, detectTreeMode } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

describe("tree listing, fingerprint, copy", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-tree-"));
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".legion-flow", "var"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "a");
    await writeFile(join(root, "src", "deep", "b.ts"), "b");
    await writeFile(join(root, "README.md"), "r");
    await writeFile(join(root, ".git", "HEAD"), "ref");
    await writeFile(join(root, ".legion-flow", "var", "x"), "x");
    await writeFile(join(root, "node_modules", "x", "index.js"), "m");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("fs mode excludes .git, .legion-flow, node_modules at any depth, lists sorted forward-slash paths, skips symlinks", async () => {
    let linked = false;
    try {
      await symlink(join(root, "README.md"), join(root, "link.md"));
      linked = true;
    } catch {
      // creating symlinks may need privilege on Windows; the walker's behavior is asserted when it can be
    }
    const listing = await listTree(root);
    assert.equal(listing.mode, "fs");
    assert.deepEqual(listing.files, ["README.md", "src/a.ts", "src/deep/b.ts"]);
    if (linked) assert.deepEqual(listing.skippedSymlinks, ["link.md"]);
    assert.equal(await detectTreeMode(root), "fs", "a bare .git directory with no repository is not git mode");
  });

  test("fingerprint changes with content and with paths; copy reproduces exactly the listed files", async () => {
    const before = await fingerprintTree(root);
    assert.match(before.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(before.files), ["README.md", "src/a.ts", "src/deep/b.ts"]);

    const dst = join(root, ".legion-flow", "var", "sandbox", "run_x", "tree");
    const copied = await copyTree(root, dst);
    assert.equal(copied, 3);
    assert.equal((await fingerprintTree(dst)).fingerprint, before.fingerprint, "a copy fingerprints identically");
    assert.equal(await readFile(join(dst, "src", "deep", "b.ts"), "utf8"), "b");

    await writeFile(join(dst, "src", "a.ts"), "a2");
    await writeFile(join(dst, "new.txt"), "n");
    const afterEdit = await fingerprintTree(dst);
    assert.notEqual(afterEdit.fingerprint, before.fingerprint);
    assert.deepEqual(diffTrees(before.files, afterEdit.files).map((d) => [d.path, d.before === null, d.after === null]), [
      ["new.txt", true, false],
      ["src/a.ts", false, false],
    ]);
  });
});

describe("git mode: git's view of the checkout", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "legion-flow-tree-git-"));
    await git(repo, "init", "-q", "-b", "main");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), "dist/\n.env\n");
    await writeFile(join(repo, "src", "a.ts"), "a\n");
    await writeFile(join(repo, "src", "gone.ts"), "gone\n");
    await writeFile(join(repo, "dist", "a.js"), "built\n");
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "init");
    await writeFile(join(repo, "src", "untracked.ts"), "u\n");
    await rm(join(repo, "src", "gone.ts"));
    await mkdir(join(repo, ".legion-flow", "var"), { recursive: true });
    await writeFile(join(repo, ".legion-flow", "var", "state"), "s");
    // init writes this file in every project: var/ is ignored, so git lists nothing under a materialized copy.
    await writeFile(join(repo, ".legion-flow", ".gitignore"), "var/\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("a repository root detects as git; tracked and untracked-not-ignored files are listed; ignored, deleted, and .legion-flow are not", async () => {
    assert.equal(await detectTreeMode(repo), "git");
    const listing = await listTree(repo, { mode: "git" });
    assert.deepEqual(listing.files, [".gitignore", "src/a.ts", "src/untracked.ts"], ".legion-flow/.gitignore is excluded with its directory");
    const fs = await listTree(repo, { mode: "fs" });
    assert.ok(fs.files.includes(".env") && fs.files.includes("dist/a.js"), "fs mode would carry the secret and the build output");
  });

  test("a copy made in git mode fingerprints equal to the source in fs mode; a copy under an ignored directory is never listed empty", async () => {
    const source = await fingerprintTree(repo, { mode: "git" });
    const dst = join(repo, ".legion-flow", "var", "sandbox", "run_g", "tree");
    await copyTree(repo, dst, { mode: "git" });
    assert.equal(await detectTreeMode(dst), "fs", "a directory inside the repository but not its top level is fs");
    const copy = await fingerprintTree(dst, { mode: "fs" });
    assert.equal(copy.fingerprint, source.fingerprint);
    assert.equal(Object.keys(copy.files).length, 3);
    const wrong = await listTree(dst, { mode: "git" });
    assert.equal(wrong.files.length, 0, "git mode on the ignored copy lists nothing, which is why the mode is explicit");
  });

  test("a .git file (as in a worktree) is excluded like a .git directory", async () => {
    const wt = join(repo, ".legion-flow", "var", "worktrees", "run_w");
    await git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    try {
      const listing = await listTree(wt, { mode: "fs" });
      assert.ok(!listing.files.includes(".git"));
      assert.deepEqual(listing.files, [".gitignore", "src/a.ts", "src/gone.ts"], "HEAD content, before any overlay");
    } finally {
      await git(repo, "worktree", "remove", "--force", wt);
    }
  });
});
