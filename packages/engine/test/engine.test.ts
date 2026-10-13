import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Decision } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, type HeldLock } from "@9thlevelsoftware/legion-flow-persist";
import {
  runWorkflow,
  resumeWorkflow,
  continueRun,
  forkRun,
  overwrite,
  applyWrites,
  withRetry,
  workflowFingerprint,
  type Workflow,
  type EngineResult,
} from "../dist/index.js";

const t0 = new Date("2026-10-08T12:00:00.000Z");
const clock = (ms = 0) => () => new Date(t0.getTime() + ms);
const instant = { sleep: async () => {}, random: () => 0.5 };

describe("reducers and retry (pure)", () => {
  test("overwrite, append, upsertById, custom, and the overwrite marker", () => {
    const schema: Workflow["state"] = {
      log: { kind: "append" },
      items: { kind: "upsertById", key: "id" },
      total: { kind: "custom", name: "sum", reduce: (p, n) => ((p as number) ?? 0) + (n as number) },
    };
    let s = applyWrites(schema, {}, { log: "a", items: [{ id: 1, v: "x" }], total: 2, name: "n" });
    s = applyWrites(schema, s, { log: ["b", "c"], items: { id: 1, v: "y" }, total: 3, name: "m" });
    assert.deepEqual(s.log, ["a", "b", "c"]);
    assert.deepEqual(s.items, [{ id: 1, v: "y" }]);
    assert.equal(s.total, 5);
    assert.equal(s.name, "m");
    s = applyWrites(schema, s, { log: overwrite(["z"]) });
    assert.deepEqual(s.log, ["z"]);
  });

  test("retry: three attempts with backoff for transient errors, none for deterministic ones", async () => {
    const sleeps: number[] = [];
    const hooks = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5 };
    let calls = 0;
    const value = await withRetry(async (attempt) => { calls = attempt; if (attempt < 3) throw new Error("flaky"); return "ok"; }, undefined, hooks);
    assert.equal(value, "ok");
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [500, 1000]);

    let typeCalls = 0;
    await assert.rejects(withRetry(async () => { typeCalls++; throw new TypeError("bug"); }, undefined, hooks), TypeError);
    assert.equal(typeCalls, 1);
  });
});

describe("engine runs", () => {
  let base: string;
  let ws: Workspace;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-engine-"));
    ws = Workspace.at(base);
    await ws.lock.withLock((held) => ws.project.create({ name: "E", adapterId: "fake", ownerId: "lead" }, held), "test");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const locked = <T>(fn: (held: HeldLock) => Promise<T>) => ws.lock.withLock(fn, "test");

  const linear: Workflow = {
    id: "linear",
    version: "1",
    entry: "a",
    state: { trail: { kind: "append" } },
    nodes: {
      a: () => ({ writes: { trail: "a" }, next: ["b", "c"] }),
      b: () => ({ writes: { trail: "b", fromB: true }, next: ["d"] }),
      c: () => ({ writes: { trail: "c" }, next: ["d"] }),
      d: (state) => ({ writes: { trail: "d", count: (state.trail as string[]).length + 1 } }),
    },
  };

  test("runs to completion with super-steps, folding writes in node order; sync writes every snapshot, exit only the ends", async () => {
    const sync = await locked((held) => runWorkflow(ws, linear, held, { durability: "sync", now: clock() }));
    assert.equal(sync.kind, "complete");
    if (sync.kind !== "complete") return;
    assert.deepEqual(sync.values.trail, ["a", "b", "c", "d"]);
    assert.equal(sync.values.count, 4);
    assert.equal(sync.seq, 3);
    assert.equal((await readdir(join(ws.paths.runsDir, sync.runId, "steps"))).length, 4, "seq 0..3");
    const run = await ws.runs.load(sync.runId);
    assert.equal(run?.run.kind === "workflow" && run.run.status, "complete");

    const exit = await locked((held) => runWorkflow(ws, linear, held, { durability: "exit", now: clock() }));
    if (exit.kind !== "complete") assert.fail();
    assert.equal((await readdir(join(ws.paths.runsDir, exit.runId, "steps"))).length, 4, "journal dirs exist for every step");
    assert.equal(await ws.runs.loadSnapshot(exit.runId, 1), null, "no mid-run snapshot under exit");
    assert.ok(await ws.runs.loadSnapshot(exit.runId, 3), "final snapshot always written");

    const forced = await locked((held) => runWorkflow(ws, linear, held, { durability: "exit", riskTier: "R2", now: clock() }));
    if (forced.kind !== "complete") assert.fail();
    assert.ok(await ws.runs.loadSnapshot(forced.runId, 1), "R2 forces sync");
  });

  const gated: Workflow = {
    id: "gated",
    version: "1",
    entry: "prepare",
    state: { trail: { kind: "append" } },
    nodes: {
      prepare: () => ({
        writes: { trail: "prepare" },
        interrupt: {
          kind: "approve_action",
          action: { name: "fs.write", riskClass: "edit", args: { path: "src/a.ts" } },
          payload: { diff: "+1" },
          expiresInMs: 60_000,
          onTimeout: "cancel",
          resume: { onApprove: "apply", onReject: "abandon", onSkip: "finish" },
        },
      }),
      apply: (_s, ctx) => ({ writes: { trail: `apply:${ctx.decision?.decision}:${JSON.stringify(ctx.decision?.editedArgs)}` }, next: ["finish"] }),
      abandon: (_s, ctx) => ({ writes: { trail: `abandon:${ctx.decision?.decision}` } }),
      finish: () => ({ writes: { trail: "finish" } }),
    },
  };

  const decide = (runId: string, interruptId: string, decision: Decision["decision"], editedArgs: Record<string, unknown> | null = null) =>
    locked(async (held) => {
      const d: Decision = {
        schema: SCHEMA_VERSIONS.DECISION,
        interruptId,
        expectedStatus: "pending",
        decision,
        editedArgs,
        note: "test",
        decidedBy: { id: "lead", displayName: "lead", kind: "human" },
        decidedAt: t0.toISOString(),
        source: "tty",
        idempotencyKey: `${interruptId}:${decision}`,
      };
      await ws.decisions.write(runId, d, held);
      await ws.interrupts.update(runId, interruptId, { status: decision === "reject" ? "rejected" : "approved" }, held);
    });

  test("an interrupt pauses the run as typed step output; a decision resumes at the named node without re-running the interrupting node", async () => {
    const paused = await locked((held) => runWorkflow(ws, gated, held, { now: clock() }));
    assert.equal(paused.kind, "awaiting_decision");
    if (paused.kind !== "awaiting_decision") return;
    assert.equal(paused.interrupt.status, "pending");
    assert.equal(paused.interrupt.resume?.onApprove, "apply");
    assert.match(paused.interrupt.payloadRef.path, /evidence\/[0-9a-f]{64}\.json$/);
    const run = await ws.runs.load(paused.runId);
    assert.equal(run?.run.kind === "workflow" && run.run.status, "awaiting_decision");
    const snap = await ws.runs.loadLatestSnapshot(paused.runId);
    assert.deepEqual(snap?.tasks[0]?.interrupts, [paused.interrupt.id]);

    const tooEarly = await locked((held) => resumeWorkflow(ws, gated, paused.runId, paused.interrupt.id, held, { now: clock() }));
    assert.equal(tooEarly.kind === "refused" && tooEarly.code, "interrupt_pending");

    await decide(paused.runId, paused.interrupt.id, "edit", { path: "src/b.ts" });
    const resumed = await locked((held) => resumeWorkflow(ws, gated, paused.runId, paused.interrupt.id, held, { now: clock(1000) }));
    assert.equal(resumed.kind, "complete");
    if (resumed.kind !== "complete") return;
    assert.deepEqual(resumed.values.trail, ["prepare", 'apply:edit:{"path":"src/b.ts"}', "finish"]);

    const twice = await locked((held) => resumeWorkflow(ws, gated, paused.runId, paused.interrupt.id, held, { now: clock(2000) }));
    assert.equal(twice.kind === "refused" && twice.code, "interrupt_consumed");
    // The resume target was made durable before anything ran: a resume snapshot names the route and the interrupt.
    const resumeSnap = await ws.runs.loadSnapshot(paused.runId, paused.seq + 1);
    assert.equal(resumeSnap?.source, "resume");
    assert.equal(resumeSnap?.next[0], "apply");
    assert.deepEqual(resumeSnap?.tasks[0]?.interrupts, [paused.interrupt.id]);

    // A crash right after resume (here: an already-aborted signal) leaves that position; continueRun re-enters it
    // and rebuilds the decision from the interrupt, so the approval still reaches the apply node.
    const crashy = await locked((held) => runWorkflow(ws, gated, held, { now: clock() }));
    if (crashy.kind !== "awaiting_decision") assert.fail();
    await decide(crashy.runId, crashy.interrupt.id, "approve");
    const dead = new AbortController();
    dead.abort();
    const interrupted = await locked((held) => resumeWorkflow(ws, gated, crashy.runId, crashy.interrupt.id, held, { now: clock(), signal: dead.signal }));
    assert.equal(interrupted.kind, "cancelled");
    assert.equal((await ws.runs.loadLatestSnapshot(crashy.runId))?.source, "resume", "the abort did not overwrite the resume snapshot");
    const recovered = await locked((held) => continueRun(ws, gated, crashy.runId, held, { now: clock() }));
    assert.equal(recovered.kind, "complete");
    if (recovered.kind !== "complete") return;
    assert.deepEqual(recovered.values.trail, ["prepare", "apply:approve:null", "finish"]);

    const rejected = await locked((held) => runWorkflow(ws, gated, held, { now: clock() }));
    if (rejected.kind !== "awaiting_decision") assert.fail();
    await decide(rejected.runId, rejected.interrupt.id, "reject");
    const afterReject = await locked((held) => resumeWorkflow(ws, gated, rejected.runId, rejected.interrupt.id, held, { now: clock() }));
    assert.equal(afterReject.kind === "complete" && (afterReject.values.trail as string[]).at(-1), "abandon:reject");
  });

  test("expiry applies onTimeout: cancel ends the run, skip routes to onSkip, reject routes to onReject", async () => {
    const cancel = await locked((held) => runWorkflow(ws, gated, held, { now: clock() }));
    if (cancel.kind !== "awaiting_decision") assert.fail();
    const expired = await locked((held) => resumeWorkflow(ws, gated, cancel.runId, cancel.interrupt.id, held, { now: clock(61_000) }));
    assert.equal(expired.kind, "cancelled");
    assert.equal((await ws.interrupts.load(cancel.runId, cancel.interrupt.id, clock(61_000)()))?.interrupt.status, "expired");

    const skipping: Workflow = { ...gated, id: "gated-skip", nodes: { ...gated.nodes, prepare: () => ({ writes: { trail: "prepare" }, interrupt: { ...(gated.nodes.prepare as () => { interrupt: never })().interrupt, onTimeout: "skip" } }) } };
    const s = await locked((held) => runWorkflow(ws, skipping, held, { now: clock() }));
    if (s.kind !== "awaiting_decision") assert.fail();
    const skipped = await locked((held) => resumeWorkflow(ws, skipping, s.runId, s.interrupt.id, held, { now: clock(61_000) }));
    assert.equal(skipped.kind === "complete" && (skipped.values.trail as string[]).at(-1), "finish");

    const rejecting: Workflow = { ...gated, id: "gated-reject", nodes: { ...gated.nodes, prepare: () => ({ writes: { trail: "prepare" }, interrupt: { ...(gated.nodes.prepare as () => { interrupt: never })().interrupt, onTimeout: "reject" } }) } };
    const r = await locked((held) => runWorkflow(ws, rejecting, held, { now: clock() }));
    if (r.kind !== "awaiting_decision") assert.fail();
    const rej = await locked((held) => resumeWorkflow(ws, rejecting, r.runId, r.interrupt.id, held, { now: clock(61_000) }));
    assert.equal(rej.kind === "complete" && (rej.values.trail as string[]).at(-1), "abandon:reject");
  });

  test("resume keeps the paused step's frontier: a sibling's successors still run after the resume target; two interrupts in one step fail the run", async () => {
    const interruptOf = (gated.nodes.prepare as () => { interrupt: never })().interrupt;
    const sibling: Workflow = {
      id: "sibling",
      version: "1",
      entry: "start",
      state: { trail: { kind: "append" } },
      nodes: {
        start: () => ({ writes: { trail: "start" }, next: ["prepare", "log"] }),
        prepare: () => ({ writes: { trail: "prepare" }, interrupt: interruptOf }),
        log: () => ({ writes: { trail: "log" }, next: ["finish"] }),
        apply: () => ({ writes: { trail: "apply" } }),
        abandon: () => ({ writes: { trail: "abandon" } }),
        finish: () => ({ writes: { trail: "finish" } }),
      },
    };
    const paused = await locked((held) => runWorkflow(ws, sibling, held, { now: clock() }));
    if (paused.kind !== "awaiting_decision") assert.fail();
    assert.deepEqual((await ws.runs.loadLatestSnapshot(paused.runId))?.next, ["finish"]);
    await decide(paused.runId, paused.interrupt.id, "approve");
    const resumed = await locked((held) => resumeWorkflow(ws, sibling, paused.runId, paused.interrupt.id, held, { now: clock() }));
    assert.equal(resumed.kind, "complete");
    if (resumed.kind !== "complete") return;
    assert.deepEqual(resumed.values.trail, ["start", "prepare", "log", "apply", "finish"]);

    const twoPauses: Workflow = {
      ...sibling,
      id: "two-pauses",
      nodes: { ...sibling.nodes, log: () => ({ writes: { trail: "log" }, interrupt: interruptOf }) },
    };
    const failed = await locked((held) => runWorkflow(ws, twoPauses, held, { now: clock() }));
    assert.equal(failed.kind, "failed");
    if (failed.kind !== "failed") return;
    assert.match(failed.error, /^multiple_interrupts_in_step: prepare, log/);
    assert.equal((await ws.runs.load(failed.runId))?.run.status, "failed");
    assert.equal((await ws.interrupts.list(failed.runId, clock()())).length, 0, "neither interrupt is written as pending");
  });

  test("crash mid-step: a journaled node is replayed, not re-run, when the run continues", async () => {
    let aRuns = 0;
    let bShouldFail = true;
    const crashy: Workflow = {
      id: "crashy",
      version: "1",
      entry: "start",
      state: { trail: { kind: "append" } },
      nodes: {
        start: () => ({ writes: { trail: "start" }, next: ["a", "b"] }),
        a: () => { aRuns++; return { writes: { trail: "a" }, next: ["done"] }; },
        b: { run: () => { if (bShouldFail) throw new Error("boom"); return { writes: { trail: "b" }, next: ["done"] }; }, retry: { maxAttempts: 1 } },
        done: () => ({ writes: { trail: "done" } }),
      },
    };
    const failed = await locked((held) => runWorkflow(ws, crashy, held, { now: clock(), ...instant }));
    assert.equal(failed.kind, "failed");
    if (failed.kind !== "failed") return;
    assert.equal(failed.node, "b");
    assert.equal(aRuns, 1);
    assert.equal((await ws.runs.readJournal(failed.runId, 2)).has("a"), true, "a's writes are journaled");

    bShouldFail = false;
    const continued = await locked((held) => continueRun(ws, crashy, failed.runId, held, { now: clock(), ...instant }));
    assert.equal(continued.kind, "complete");
    if (continued.kind !== "complete") return;
    assert.equal(aRuns, 1, "a was replayed from the journal, not executed again");
    assert.deepEqual(continued.values.trail, ["start", "a", "b", "done"]);
  });

  test("abort stops before the next node with a snapshot and status cancelled; a changed graph refuses resume; fork starts a new run from a snapshot", async () => {
    const controller = new AbortController();
    const aborting: Workflow = {
      ...linear,
      id: "aborting",
      nodes: { ...linear.nodes, a: () => { controller.abort(); return { writes: { trail: "a" }, next: ["b", "c"] }; } },
    };
    const aborted = await locked((held) => runWorkflow(ws, aborting, held, { signal: controller.signal, now: clock() }));
    assert.equal(aborted.kind, "cancelled");
    if (aborted.kind !== "cancelled") return;
    assert.equal((await ws.runs.load(aborted.runId))?.run.status, "cancelled");

    const done = await locked((held) => runWorkflow(ws, linear, held, { now: clock() }));
    if (done.kind !== "complete") assert.fail();
    const changed: Workflow = { ...linear, version: "2" };
    assert.notEqual(workflowFingerprint(changed), workflowFingerprint(linear));
    const refused = await locked((held) => continueRun(ws, changed, done.runId, held));
    assert.equal(refused.kind === "refused" && refused.code, "graph_changed");

    const fork = await locked((held) => forkRun(ws, linear, done.runId, 1, { trail: overwrite(["forked"]) }, held, { now: clock() }));
    assert.equal(fork.kind, "complete");
    if (fork.kind !== "complete") return;
    const forkRun_ = await ws.runs.load(fork.runId);
    assert.deepEqual(forkRun_?.run.kind === "workflow" && forkRun_.run.forkedFrom, { runId: done.runId, seq: 1 });
    const seq0 = await ws.runs.loadSnapshot(fork.runId, 0);
    assert.equal(seq0?.source, "update");
    assert.deepEqual(seq0?.next, ["b", "c"]);
    const driven = await locked((held) => continueRun(ws, linear, fork.runId, held, { now: clock() }));
    assert.equal(driven.kind === "complete" && JSON.stringify(driven.values.trail), JSON.stringify(["forked", "b", "c", "d"]));
    const parent = await ws.runs.load(done.runId);
    assert.equal(parent?.run.status, "complete", "the parent is untouched");
  });

  test("invalid node names and unknown entry are typed refusals", async () => {
    const bad: Workflow = { id: "bad", version: "1", entry: "Start", state: {}, nodes: { Start: () => ({}) } };
    const r: EngineResult = await locked((held) => runWorkflow(ws, bad, held));
    assert.equal(r.kind === "refused" && r.code, "workflow_invalid");
  });
});
