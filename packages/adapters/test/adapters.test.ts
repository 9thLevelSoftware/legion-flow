import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterEnv, FORCED_TELEMETRY_OPT_OUT, adapterById, FakeAdapter, spawnFrozen } from "../dist/index.js";
import type { SandboxExec } from "@9thlevelsoftware/legion-flow-engine";

/** The host tier's exec, as the sandbox package implements it: identity paths, env as values. */
const hostExec: SandboxExec = async (spec) => {
  const id = (p: string) => p;
  return spawnFrozen({ command: spec.command, args: spec.args(id), cwd: spec.cwd(id), env: spec.env, signal: spec.signal, timeoutMs: spec.timeoutMs });
};

describe("adapter environment", () => {
  test("keeps only the allowlist and the named credential, matches case-insensitively on win32, forces telemetry off", () => {
    const source = { Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", AWS_SECRET: "nope", MY_KEY: "k", DO_NOT_TRACK: "0" };
    const win = buildAdapterEnv(source, { credentialEnv: "MY_KEY", platform: "win32" });
    assert.equal(win.Path, "C:\\bin");
    assert.equal(win.MY_KEY, "k");
    assert.equal(win.AWS_SECRET, undefined);
    assert.equal(win.DO_NOT_TRACK, "1", "the forced set wins over the operator's value");
    for (const [k, v] of Object.entries(FORCED_TELEMETRY_OPT_OUT)) assert.equal(win[k], v);

    const linux = buildAdapterEnv({ Path: "x", PATH: "/bin" }, { platform: "linux" });
    assert.equal(linux.PATH, "/bin");
    assert.equal(linux.Path, undefined, "exact names elsewhere");
    const container = buildAdapterEnv({ PATH: "/host/bin", HOME: "/home/x" }, { mode: "container", extraAllowlist: ["LF_PROXY"] , platform: "linux" });
    assert.equal(container.PATH, undefined, "the image's PATH applies inside a container");
    assert.equal(container.DO_NOT_TRACK, "1");
  });
});

describe("fake adapter, spawned for real", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-fake-adapter-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function setup(name: string, plan?: unknown) {
    const ws = join(root, name);
    const tree = join(ws, ".legion-flow", "var", "sandbox", "run_x", "tree");
    const promptDir = join(ws, ".legion-flow", "var", "cache", "runs", "run_x");
    await mkdir(join(tree, "src"), { recursive: true });
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(tree, "src", "a.ts"), "a\n");
    await writeFile(join(promptDir, "prompt.md"), "# prompt\n");
    await writeFile(join(promptDir, "brief.json"), JSON.stringify({ filesAllowed: ["src/a.ts", "gen/"], expectedArtifacts: ["gen/out.txt"] }));
    if (plan) await writeFile(join(ws, ".legion-flow", "var", "fake-adapter.json"), JSON.stringify(plan));
    return { ws, tree, promptPath: join(promptDir, "prompt.md") };
  }

  test("default behavior: marks allowed files, creates expected artifacts, writes summary.md, exits 0", async () => {
    const { ws, tree, promptPath } = await setup("default");
    const adapter = adapterById("fake")!;
    assert.ok(adapter instanceof FakeAdapter);
    const outcome = await adapter.run({ runId: "run_x", workspaceRoot: ws, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 20_000, exec: hostExec, envMode: "host" });
    assert.equal(outcome.exitCode, 0, outcome.stderrTail);
    assert.match(await readFile(join(tree, "src", "a.ts"), "utf8"), /fake adapter touched/);
    assert.match(await readFile(join(tree, "gen", "out.txt"), "utf8"), /created by the legion-flow fake adapter/);
    assert.match(await readFile(join(ws, ".legion-flow", "var", "cache", "runs", "run_x", "summary.md"), "utf8"), /Touched 2 path/);
    assert.match(outcome.stdoutTail, /touched 2 path/);
  });

  test("a plan file scripts edits and the exit code; a timeout kills the child", async () => {
    const { ws, tree, promptPath } = await setup("scripted", { edits: [{ path: "src/a.ts", content: "b\n" }, { path: "src/gone.ts", content: null }], exitCode: 3 });
    const outcome = await adapterById("fake")!.run({ runId: "run_x", workspaceRoot: ws, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 20_000, exec: hostExec, envMode: "host" });
    assert.equal(outcome.exitCode, 3);
    assert.equal(await readFile(join(tree, "src", "a.ts"), "utf8"), "b\n");

    const slow = await setup("slow", { sleepMs: 10_000 });
    const timed = await adapterById("fake")!.run({ runId: "run_x", workspaceRoot: slow.ws, treeDir: slow.tree, promptPath: slow.promptPath, signal: new AbortController().signal, timeoutMs: 300, exec: hostExec, envMode: "host" });
    assert.equal(timed.timedOut, true);
    assert.notEqual(timed.exitCode, 0);
    assert.ok(adapterById("claude") && adapterById("codex"), "the real adapters are registered");
    assert.equal(adapterById("gemini"), null);
  });
});
