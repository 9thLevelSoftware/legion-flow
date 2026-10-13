import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { runWorkflow, continueRun, forkRun, reviewWorkflow, workflowFingerprint, type Workflow } from "../dist/index.js";
import { mkdir, access } from "node:fs/promises";

const t0 = new Date("2026-10-09T09:00:00.000Z");
const clock = (ms = 0) => () => new Date(t0.getTime() + ms);

describe("the effects ledger and fork invalidation records", () => {
  test("an effect node is ledgered started then done; a failure is ledgered failed and may run again; a crash (started, never accounted for) refuses to re-run and marks unknown_after_crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-effects-"));
    const ws = Workspace.at(root);
    try {
      await ws.lock.withLock((held) => ws.project.create({ name: "E", adapterId: "fake", ownerId: "lead" }, held), "test");
      let spawns = 0;
      let failOnce = true;
      const wf: Workflow = {
        id: "effects",
        version: "1",
        entry: "start",
        state: { trail: { kind: "append" } },
        nodes: {
          start: () => ({ writes: { trail: "start" }, next: ["spawn"] }),
          spawn: {
            effect: "adapter_spawn",
            retry: { maxAttempts: 1 },
            run: () => {
              spawns += 1;
              if (failOnce) {
                failOnce = false;
                throw new Error("adapter exited 1");
              }
              return { writes: { trail: "spawned" }, next: ["finish"] };
            },
          },
          finish: () => ({ writes: { trail: "finish" } }),
        },
      };
      const failed = await ws.lock.withLock((held) => runWorkflow(ws, wf, held, { now: clock() }), "test");
      assert.equal(failed.kind, "failed");
      if (failed.kind !== "failed") return;
      let ledger = await ws.runs.readEffects(failed.runId);
      assert.deepEqual(ledger.map((l) => l.status), ["started", "failed"]);

      // A known failure may be continued: the ledger says failed, so the effect runs again.
      const continued = await ws.lock.withLock((held) => continueRun(ws, wf, failed.runId, held, { now: clock(1000) }), "test");
      assert.equal(continued.kind, "complete");
      ledger = await ws.runs.readEffects(failed.runId);
      assert.deepEqual(ledger.map((l) => l.status), ["started", "failed", "started", "done"]);
      assert.equal(spawns, 2);

      // A crash: the ledger says started with no account, and the node is not journaled. Re-entry refuses.
      const crashed = await ws.lock.withLock((held) => runWorkflow(ws, { ...wf, id: "effects-crash" }, held, { now: clock() }), "test");
      // The second workflow instance has failOnce=false already, so this run completes; simulate the crash on a fresh run instead.
      assert.equal(crashed.kind, "complete");
      const fresh = await ws.lock.withLock(async (held) => {
        const { run } = await ws.runs.create({ kind: "workflow", workflowId: "effects", graphFingerprint: (await ws.runs.load(failed.runId))!.run.kind === "workflow" ? ((await ws.runs.load(failed.runId))!.run as { graphFingerprint: string }).graphFingerprint : "", durability: "sync" }, held);
        await ws.runs.writeSnapshot({ schema: "legion-flow-step-snapshot/v1", runId: run.id, seq: 1, parentSeq: 0, namespace: "", source: "loop", values: { trail: ["start"] }, next: ["spawn"], tasks: [], graphFingerprint: (run as { graphFingerprint: string }).graphFingerprint, durability: "sync", createdAt: t0.toISOString() }, held);
        await ws.runs.appendEffect(run.id, { seq: 2, node: "spawn", effect: "adapter_spawn", status: "started", at: t0.toISOString() }, held);
        return run.id;
      }, "test");
      const before = spawns;
      const refused = await ws.lock.withLock((held) => continueRun(ws, wf, fresh, held, { now: clock(5000) }), "test");
      assert.equal(refused.kind, "failed");
      if (refused.kind !== "failed") return;
      assert.match(refused.error, /^effect_unknown_after_crash: adapter_spawn by node 'spawn'/);
      assert.equal(spawns, before, "the side effect was not re-run");
      const crashLedger = await ws.runs.readEffects(fresh);
      assert.deepEqual(crashLedger.map((l) => l.status), ["started", "unknown_after_crash"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fork records itself on the parent; only an edited fork is marked edited", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-fork-inv-"));
    const ws = Workspace.at(root);
    try {
      await ws.lock.withLock((held) => ws.project.create({ name: "F", adapterId: "fake", ownerId: "lead" }, held), "test");
      const wf: Workflow = { id: "lin", version: "1", entry: "a", state: { trail: { kind: "append" } }, nodes: { a: () => ({ writes: { trail: "a" }, next: ["b"] }), b: () => ({ writes: { trail: "b" } }) } };
      const done = await ws.lock.withLock((held) => runWorkflow(ws, wf, held, { now: clock() }), "test");
      if (done.kind !== "complete") assert.fail();
      const plain = await ws.lock.withLock((held) => forkRun(ws, wf, done.runId, 1, undefined, held, { now: clock(1000) }), "test");
      const edited = await ws.lock.withLock((held) => forkRun(ws, wf, done.runId, 1, { trail: ["x"] }, held, { now: clock(2000) }), "test");
      if (plain.kind !== "complete" || edited.kind !== "complete") assert.fail();
      const records = await ws.runs.readInvalidations(done.runId);
      assert.equal(records.length, 2);
      assert.deepEqual(records.map((r) => [r.forkedTo, r.edited, r.fromSeq]), [[plain.runId, false, 1], [edited.runId, true, 1]]);
      assert.equal(records[1]?.at, clock(2000)().toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a review run that crashed during the reviewer spawn is refused on continue and its copy is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-review-crash-"));
  const ws = Workspace.at(root);
  try {
    await ws.lock.withLock((held) => ws.project.create({ name: "R", adapterId: "fake", ownerId: "lead" }, held), "test");
    let spawned = 0;
    let disposed = 0;
    const wf = reviewWorkflow({
      ws,
      materializer: { tier: "fake", materialize: async () => ({ treeDir: "" }), dispose: async () => { disposed += 1; }, exec: async () => ({ exitCode: 0, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" }) },
      adapter: { id: "fake", profile: { supportsTools: false, supportsJsonOutput: false, reportsUsage: { turns: false, tokens: false, cost: false }, image: "x" }, run: async () => { spawned += 1; return { exitCode: 0, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" }; } },
    });
    const runId = await ws.lock.withLock(async (held) => {
      const { run } = await ws.runs.create({ kind: "workflow", workflowId: "review", graphFingerprint: workflowFingerprint(wf), durability: "sync" }, held);
      const tree = join(ws.paths.sandboxDir, run.id, "tree");
      await mkdir(tree, { recursive: true });
      await ws.runs.writeSnapshot({ schema: "legion-flow-step-snapshot/v1", runId: run.id, seq: 1, parentSeq: 0, namespace: "", source: "loop", values: { treeDir: tree }, next: ["spawn"], tasks: [], graphFingerprint: workflowFingerprint(wf), durability: "sync", createdAt: t0.toISOString() }, held);
      await ws.runs.appendEffect(run.id, { seq: 2, node: "spawn", effect: "reviewer_spawn", status: "started", at: t0.toISOString() }, held);
      return run.id;
    }, "test");
    const result = await ws.lock.withLock((held) => continueRun(ws, wf, runId, held, { now: clock(1000) }), "test");
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.error, /^effect_unknown_after_crash: reviewer_spawn/);
    assert.equal(spawned, 0, "the reviewer is never re-run after a crash it cannot account for");
    assert.equal(disposed, 0);
    await access(join(ws.paths.sandboxDir, runId, "tree"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
