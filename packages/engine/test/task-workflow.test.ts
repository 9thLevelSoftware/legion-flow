import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Decision, type PlanTask } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, copyTree, fingerprintTree, type HeldLock } from "@9thlevelsoftware/legion-flow-persist";
import {
  taskWorkflow,
  runWorkflow,
  resumeWorkflow,
  selectNextTask,
  contractViolation,
  usageOverLimit,
  parseReviewVerdict,
  selectBatch,
  contractsMayOverlap,
  type Adapter,
  type Materializer,
  type CheckRunner,
  type TaskInput,
} from "../dist/index.js";

const t0 = new Date("2026-10-08T12:00:00.000Z");
const clock = (ms = 0) => () => new Date(t0.getTime() + ms);

/** A materializer that copies the source into var/sandbox, the shape the real one has. */
function copyMaterializer(ws: Workspace): Materializer & { disposed: string[] } {
  const m = {
    tier: "fake",
    disposed: [] as string[],
    async materialize({ runId, sourceRoot }: { runId: string; sourceRoot: string }) {
      const treeDir = join(ws.paths.sandboxDir, runId, "tree");
      await copyTree(sourceRoot, treeDir);
      return { treeDir };
    },
    async dispose(treeDir: string) {
      m.disposed.push(treeDir);
      await rm(join(treeDir, ".."), { recursive: true, force: true });
    },
    /** Never reached: the scripted adapters edit the tree themselves. */
    async exec() {
      return { exitCode: 0, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" };
    },
  };
  return m;
}

/** An in-memory adapter: edits the tree per scenario. */
function scriptedAdapter(script: (treeDir: string) => Promise<void>, exitCode = 0): Adapter {
  return {
    id: "scripted",
    async run({ treeDir }) {
      await script(treeDir);
      return { exitCode, signal: null, timedOut: false, stdoutTail: "", stderrTail: exitCode === 0 ? "" : "boom" };
    },
  };
}

const passingChecks: CheckRunner = async (check, input) => ({
  status: "satisfied",
  reason: "exit 0",
  evidence: {
    schema: SCHEMA_VERSIONS.CHECK_EVIDENCE,
    check,
    argv: check.split(" "),
    cwd: input.cwd,
    source: input.source,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    startedAt: t0.toISOString(),
    endedAt: t0.toISOString(),
    exitCode: 0,
    signal: null,
    timedOut: false,
    viaCmdShim: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  },
});

const task: PlanTask = {
  id: "T-01",
  title: "edit a",
  acceptanceIds: ["AC-01"],
  dependsOn: [],
  contract: { schema: SCHEMA_VERSIONS.FILE_CONTRACT, filesAllowed: ["src/a.ts", "generated/"], filesForbidden: ["src/secret.ts"], expectedArtifacts: [], verificationCommands: ["node -e 0"], maxFilesTouched: 3 },
};

describe("task workflow (execute) with in-memory ports", () => {
  let base: string;
  let n = 0;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-task-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** A fresh workspace with a small source tree and a project record. */
  async function workspace(): Promise<{ ws: Workspace; root: string }> {
    const root = join(base, `ws${n++}`);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "secret.ts"), "export const s = 1;\n");
    await writeFile(join(root, "README.md"), "# r\n");
    const ws = Workspace.at(root);
    await ws.lock.withLock((held) => ws.project.create({ name: "T", adapterId: "fake", ownerId: "lead" }, held), "test");
    return { ws, root };
  }

  const input = (root: string, riskTier: TaskInput["riskTier"] = "R1"): TaskInput => ({
    workspaceRoot: root,
    planId: "pln_test",
    task,
    acceptanceCriteria: [{ id: "AC-01", statement: "a is edited", kind: "behavior", surface: "unit", priority: "P1" }],
    receiptChecks: ["node -e 0"],
    riskTier,
  });

  const run = (ws: Workspace, root: string, adapter: Adapter, riskTier: TaskInput["riskTier"], m = copyMaterializer(ws)) =>
    ws.lock.withLock(
      (held: HeldLock) =>
        runWorkflow(ws, taskWorkflow({ ws, materializer: m, adapter, runCheck: passingChecks, now: clock() }), held, {
          input: input(root, riskTier) as unknown as Record<string, unknown>,
          task: { planId: "pln_test", taskId: task.id },
          riskTier,
          now: clock(),
        }),
      "test"
    );

  test("R0: an in-contract edit is proposed, checked in the corrected tree, auto-applied, and the tree disposed", async () => {
    const { ws, root } = await workspace();
    const m = copyMaterializer(ws);
    const adapter = scriptedAdapter(async (tree) => {
      await writeFile(join(tree, "src", "a.ts"), "export const a = 2;\n");
      await mkdir(join(tree, "generated"), { recursive: true });
      await writeFile(join(tree, "generated", "out.txt"), "g\n");
    });
    const result = await run(ws, root, adapter, "R0", m);
    assert.equal(result.kind, "complete");
    if (result.kind !== "complete") return;
    assert.equal(result.values.outcome, "auto_applied");
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(root, "generated", "out.txt"), "utf8"), "g\n");
    const loaded = await ws.runs.load(result.runId);
    assert.equal(loaded?.run.kind === "workflow" && loaded.run.applied?.mode, "auto");
    assert.equal(loaded?.run.kind === "workflow" && loaded.run.applied?.sourceFingerprint, (await fingerprintTree(root)).fingerprint);
    assert.equal(loaded?.run.kind === "workflow" && loaded.run.task?.taskId, "T-01");
    assert.equal(m.disposed.length, 1);
    await assert.rejects(access(join(ws.paths.sandboxDir, result.runId)), "the sandbox tree is removed after apply");
    assert.ok(await readFile(join(ws.paths.cacheRunsDir, result.runId, "prompt.md"), "utf8").then((p) => p.includes("T-01: edit a")));
  });

  test("R0 with the architecture port: a throwing analysis pauses, a proposal introducing a violation pauses, a clean one applies (ADR-0009)", async () => {
    const violation = { id: "a".repeat(64), rule: "layer" as const, from: "src/a.ts", to: "src/b.ts", detail: "x may not import y" };
    const cases: { name: string; port: () => Promise<{ architecture?: { rulesSha256: string; introduced: (typeof violation)[]; resolved: (typeof violation)[]; unchanged: number } }>; expect: "awaiting_decision" | "complete" }[] = [
      { name: "throws", port: async () => { throw new Error("extractor exploded"); }, expect: "awaiting_decision" },
      { name: "introduces", port: async () => ({ architecture: { rulesSha256: "b".repeat(64), introduced: [violation], resolved: [], unchanged: 0 } }), expect: "awaiting_decision" },
      { name: "clean", port: async () => ({ architecture: { rulesSha256: "b".repeat(64), introduced: [], resolved: [violation], unchanged: 0 } }), expect: "complete" },
    ];
    for (const c of cases) {
      const { ws, root } = await workspace();
      const adapter = scriptedAdapter(async (tree) => writeFile(join(tree, "src", "a.ts"), "export const a = 3;\n"));
      const result = await ws.lock.withLock(
        (held: HeldLock) =>
          runWorkflow(ws, taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter, runCheck: passingChecks, now: clock(), architecture: c.port }), held, {
            input: input(root, "R0") as unknown as Record<string, unknown>,
            task: { planId: "pln_test", taskId: task.id },
            riskTier: "R0",
            now: clock(),
          }),
        "test"
      );
      assert.equal(result.kind, c.expect, c.name);
      if (result.kind === "awaiting_decision") {
        const payload = JSON.parse(await readFile(join(ws.paths.project, ...result.interrupt.payloadRef.path.split("/")), "utf8")).payload;
        assert.equal(Boolean(payload.architecture), c.name === "introduces", `${c.name}: the proposal records the analysis only when it ran`);
      }
    }
  });

  test("R1: out-of-contract edits are restored before the checks, the proposal pauses, approve applies, and a changed checkout refuses", async () => {
    const { ws, root } = await workspace();
    const adapter = scriptedAdapter(async (tree) => {
      await writeFile(join(tree, "src", "a.ts"), "export const a = 3;\n");
      await writeFile(join(tree, "src", "secret.ts"), "leak\n");
      await writeFile(join(tree, "README.md"), "# tampered\n");
    });
    const paused = await run(ws, root, adapter, "R1");
    assert.equal(paused.kind, "awaiting_decision");
    if (paused.kind !== "awaiting_decision") return;
    assert.equal(paused.interrupt.action.name, "fs.apply_proposal");
    assert.equal(paused.interrupt.action.riskClass, "edit");
    const snap = await ws.runs.loadLatestSnapshot(paused.runId);
    const proposal = snap!.values.proposal as { files: { path: string }[]; contractCheck: { touched: number; reverted: { path: string; reason: string }[] }; appliedTreeFingerprint: string; verification: { treeFingerprint: string; results: unknown[] } };
    assert.deepEqual(proposal.files.map((f) => f.path), ["src/a.ts"]);
    assert.equal(proposal.contractCheck.touched, 3);
    assert.deepEqual(proposal.contractCheck.reverted.map((r) => r.path), ["README.md", "src/secret.ts"]);
    assert.equal(proposal.verification.treeFingerprint, proposal.appliedTreeFingerprint, "checks ran in the corrected tree");
    assert.equal(proposal.verification.results.length, 2, "one task check plus one receipt check");
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing applied yet");

    // Someone edits the checkout while the human is deciding.
    await writeFile(join(root, "README.md"), "# moved on\n");
    await decide(ws, paused.runId, paused.interrupt.id, "approve");
    const wf = taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter, runCheck: passingChecks, now: clock() });
    const changed = await ws.lock.withLock((held) => resumeWorkflow(ws, wf, paused.runId, paused.interrupt.id, held, { now: clock() }), "test");
    assert.equal(changed.kind, "failed");
    if (changed.kind !== "failed") return;
    assert.match(changed.error, /^source_changed/);
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n");

    // A clean checkout applies through the decided path.
    await writeFile(join(root, "README.md"), "# r\n");
    const again = await run(ws, root, adapter, "R1");
    if (again.kind !== "awaiting_decision") assert.fail();
    await decide(ws, again.runId, again.interrupt.id, "approve");
    const applied = await ws.lock.withLock((held) => resumeWorkflow(ws, wf, again.runId, again.interrupt.id, held, { now: clock() }), "test");
    assert.equal(applied.kind, "complete");
    if (applied.kind !== "complete") return;
    assert.equal(applied.values.outcome, "applied");
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 3;\n");
    assert.equal(await readFile(join(root, "src", "secret.ts"), "utf8"), "export const s = 1;\n", "the forbidden edit never reached the checkout");
    const loaded = await ws.runs.load(applied.runId);
    assert.equal(loaded?.run.kind === "workflow" && loaded.run.applied?.mode, "decided");
  });

  test("reject abandons; too many files is a contract violation; no changes completes without a proposal", async () => {
    const { ws, root } = await workspace();
    const adapter = scriptedAdapter(async (tree) => writeFile(join(tree, "src", "a.ts"), "x\n"));
    const paused = await run(ws, root, adapter, "R1");
    if (paused.kind !== "awaiting_decision") assert.fail();
    await decide(ws, paused.runId, paused.interrupt.id, "reject");
    const wf = taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter, runCheck: passingChecks, now: clock() });
    const rejected = await ws.lock.withLock((held) => resumeWorkflow(ws, wf, paused.runId, paused.interrupt.id, held, { now: clock() }), "test");
    assert.equal(rejected.kind === "complete" && rejected.values.outcome, "rejected");
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n");

    const spray = scriptedAdapter(async (tree) => {
      await mkdir(join(tree, "generated"), { recursive: true });
      for (let i = 0; i < 4; i++) await writeFile(join(tree, "generated", `f${i}.txt`), String(i));
    });
    const violated = await run(ws, root, spray, "R0");
    assert.equal(violated.kind, "failed");
    if (violated.kind !== "failed") return;
    assert.match(violated.error, /^contract_violation: 4 files touched, more than maxFilesTouched 3/);
    await access(join(ws.paths.sandboxDir, violated.runId, "tree"), undefined).then(() => {}, () => assert.fail("a failed run keeps its tree"));

    const idle = await run(ws, root, scriptedAdapter(async () => {}), "R0");
    assert.equal(idle.kind === "complete" && idle.values.outcome, "no_changes");
    assert.equal((await ws.interrupts.list(idle.runId)).length, 0);
  });

  test("adapter failure and abort are typed failures; selectNextTask honors plan order and dependencies", async () => {
    const { ws, root } = await workspace();
    const failing = await run(ws, root, scriptedAdapter(async () => {}, 2), "R0");
    assert.equal(failing.kind === "failed" && failing.error.startsWith("adapter_failed: scripted exited 2"), true);

    const controller = new AbortController();
    const aborting: Adapter = { id: "aborting", async run() { controller.abort(); return { exitCode: null, signal: "SIGINT", timedOut: false, stdoutTail: "", stderrTail: "" }; } };
    const aborted = await ws.lock.withLock(
      (held) => runWorkflow(ws, taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter: aborting, runCheck: passingChecks }), held, { input: input(root, "R0") as unknown as Record<string, unknown>, signal: controller.signal }),
      "test"
    );
    assert.equal(aborted.kind === "failed" && aborted.error.startsWith("adapter_aborted"), true);

    const plan = {
      schema: SCHEMA_VERSIONS.PLAN,
      id: "pln_sel",
      specId: "spc_x",
      specFingerprint: "sha256:" + "0".repeat(64),
      createdAt: t0.toISOString(),
      tasks: [
        { ...task, id: "T-01", dependsOn: [] },
        { ...task, id: "T-02", dependsOn: ["T-01"] },
        { ...task, id: "T-03", dependsOn: ["T-02"] },
      ],
    } as const;
    const runs = await ws.runs.list();
    assert.equal(selectNextTask(plan, runs).kind === "task" && (selectNextTask(plan, runs) as { task: PlanTask }).task.id, "T-01");
    const blocked = selectNextTask(plan, runs, "T-03");
    assert.equal(blocked.kind === "blocked" && blocked.reason, "T-03 depends on unapplied T-02");
    assert.equal(contractViolation(".legion-flow/project/project.json", task), "control artifacts under .legion-flow/ are never writable by a run");
    assert.equal(contractViolation("generated/x/y.txt", task), null);
    // The shared matcher (schema): contracts accept globs too, the same ones map rules use.
    const globbed = { ...task, contract: { ...task.contract, filesAllowed: ["src/**/*.ts"], filesForbidden: ["src/secret/*"] } };
    assert.equal(contractViolation("src/deep/a.ts", globbed), null);
    assert.equal(contractViolation("src/deep/a.js", globbed), "not in filesAllowed");
    assert.equal(contractViolation("src/secret/k.ts", globbed), "matches filesForbidden");
    assert.equal(contractViolation("src/b.ts", task), "not in filesAllowed");
  });
});

async function decide(ws: Workspace, runId: string, interruptId: string, decision: Decision["decision"]) {
  await ws.lock.withLock(async (held) => {
    const d: Decision = {
      schema: SCHEMA_VERSIONS.DECISION,
      interruptId,
      expectedStatus: "pending",
      decision,
      editedArgs: null,
      note: "test",
      decidedBy: { id: "lead", displayName: "lead", kind: "human" },
      decidedAt: new Date().toISOString(),
      source: "tty",
      idempotencyKey: `${interruptId}:${decision}`,
    };
    await ws.decisions.write(runId, d, held);
    await ws.interrupts.update(runId, interruptId, { status: decision === "reject" ? "rejected" : "approved" }, held);
  }, "test");
}

test("usage limits: over turns, over cost, unknown usage with a limit set, and no limit at all", () => {
  const known = { known: true as const, turns: 4, inputTokens: 10, outputTokens: 5, costUsd: 0.5 };
  assert.equal(usageOverLimit(known, undefined), null);
  assert.equal(usageOverLimit(known, {}), null);
  assert.equal(usageOverLimit(known, { maxTurns: 4, costLimitUsd: 0.5 }), null, "at the limit is within it");
  assert.match(usageOverLimit(known, { maxTurns: 3 }) ?? "", /4 turns exceeds maxTurns 3/);
  assert.match(usageOverLimit(known, { costLimitUsd: 0.25 }) ?? "", /cost 0.5 USD exceeds costLimitUsd 0.25/);
  assert.match(usageOverLimit({ known: false, reason: "no stdout" }, { maxTurns: 3 }) ?? "", /reported no usage \(no stdout\)/);
  assert.match(usageOverLimit(undefined, { maxTurns: 3 }) ?? "", /nothing parsed/);
  assert.equal(usageOverLimit({ known: false, reason: "x" }, undefined), null, "unknown usage without a limit is not a violation");
});

test("the strict review verdict: exit 0, notes, and an exact final line; anything else is FAIL with a reason", () => {
  const ok = { exitCode: 0, timedOut: false, signal: null };
  assert.equal(parseReviewVerdict("All criteria met.\r\n\r\nVerdict: PASS\r\n", ok).verdict, "PASS");
  assert.match(parseReviewVerdict("All criteria met.\nVerdict: FAIL\n", ok).reason, /unmet/);
  assert.match(parseReviewVerdict("Verdict: PASS\n", ok).reason, /no notes/);
  assert.match(parseReviewVerdict("notes\nverdict: pass\n", ok).reason, /not a verdict line/);
  assert.match(parseReviewVerdict(null, ok).reason, /no review.md/);
  assert.match(parseReviewVerdict("notes\nVerdict: PASS\n", { exitCode: 2, timedOut: false, signal: null }).reason, /exited 2/);
  assert.match(parseReviewVerdict("notes\nVerdict: PASS\n", { exitCode: null, timedOut: true, signal: "SIGTERM" }).reason, /time limit/);
});

describe("parallel tasks (M4 slice d): batch selection and the rebase at apply", () => {
  let base: string;
  let n = 0;
  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-batch-"));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const taskFor = (id: string, files: string[]): PlanTask => ({ ...task, id, contract: { ...task.contract, filesAllowed: files, filesForbidden: [], verificationCommands: [] } });
  async function workspace() {
    const root = join(base, `ws${n++}`);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
    await writeFile(join(root, "README.md"), "# r\n");
    const ws = Workspace.at(root);
    await ws.lock.withLock((held) => ws.project.create({ name: "B", adapterId: "fake", ownerId: "lead" }, held), "test");
    return { ws, root };
  }
  const edit = (path: string, content: string) => scriptedAdapter(async (tree) => writeFile(join(tree, ...path.split("/")), content));
  const go = (ws: Workspace, root: string, t: PlanTask, adapter: Adapter, riskTier: TaskInput["riskTier"], runCheck: CheckRunner = passingChecks) =>
    ws.lock.withLock(
      (held: HeldLock) =>
        runWorkflow(ws, taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter, runCheck, now: clock() }), held, {
          input: { workspaceRoot: root, planId: "pln_test", task: t, acceptanceCriteria: [], receiptChecks: ["node -e 0"], riskTier } as unknown as Record<string, unknown>,
          task: { planId: "pln_test", taskId: t.id },
          riskTier,
          now: clock(),
        }),
      "test"
    );
  const resume = (ws: Workspace, runId: string, interruptId: string, runCheck: CheckRunner = passingChecks) =>
    ws.lock.withLock((held) => resumeWorkflow(ws, taskWorkflow({ ws, materializer: copyMaterializer(ws), adapter: edit("x", ""), runCheck, now: clock() }), runId, interruptId, held, { now: clock() }), "test");

  test("contracts that may overlap are never batched; dependencies decide what is ready", async () => {
    assert.equal(contractsMayOverlap(["src/a.ts"], ["src/b.ts"]), null);
    assert.ok(contractsMayOverlap(["src/"], ["src/b.ts"]));
    assert.ok(contractsMayOverlap(["src/**/*.ts"], ["src/x/y.ts"]), "a glob compares by its literal prefix");
    assert.ok(contractsMayOverlap(["**/*.ts"], ["docs/a.md"]), "a glob with no literal prefix overlaps everything");
    assert.equal(contractsMayOverlap(["web/**"], ["api/**"]), null);
    const plan = { id: "pln_test", tasks: [taskFor("T-01", ["src/a.ts"]), taskFor("T-02", ["src/"]), taskFor("T-03", ["docs/x.md"]), { ...taskFor("T-04", ["lib/z.ts"]), dependsOn: ["T-01"] }] } as never;
    const batch = selectBatch(plan, [], 4);
    assert.deepEqual(batch.tasks.map((t) => t.id), ["T-01", "T-03"]);
    assert.deepEqual(batch.deferred.map((d) => d.taskId), ["T-02", "T-04"]);
    assert.match(batch.deferred[1]!.reason, /depends on T-01, in this batch/);
    assert.deepEqual(selectBatch(plan, [], 1).tasks.map((t) => t.id), ["T-01"]);
  });

  test("a decided proposal rebases on a peer run's apply: checks rerun in the checkout plus the proposal, evidence recorded, both changes land", async () => {
    const { ws, root } = await workspace();
    const a = await go(ws, root, taskFor("T-01", ["src/a.ts"]), edit("src/a.ts", "export const a = 2;\n"), "R1");
    if (a.kind !== "awaiting_decision") assert.fail(a.kind);
    const b = await go(ws, root, taskFor("T-02", ["src/b.ts"]), edit("src/b.ts", "export const b = 2;\n"), "R0");
    assert.equal(b.kind, "complete");
    await decide(ws, a.runId, a.interrupt.id, "approve");
    const applied = await resume(ws, a.runId, a.interrupt.id);
    assert.equal(applied.kind, "complete", applied.kind === "failed" ? applied.error : "");
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 2;\n");
    const loaded = (await ws.runs.load(a.runId))!;
    const rebase = await Promise.all(loaded.evidenceIndex.filter((e) => e.producedBy === "apply").map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { kind?: string; peers?: string[]; absorbed?: string[] }));
    const record = rebase.find((r) => r.kind === "rebase")!;
    assert.deepEqual(record.peers, [b.runId]);
    assert.deepEqual(record.absorbed, ["src/b.ts"]);
  });

  test("a rebase refuses what it cannot vouch for: a human's edit, a peer touching the same file, and checks that fail once the peer's change is in", async () => {
    // A human edits the checkout while the decision is pending: still source_changed.
    {
      const { ws, root } = await workspace();
      const a = await go(ws, root, taskFor("T-01", ["src/a.ts"]), edit("src/a.ts", "export const a = 2;\n"), "R1");
      if (a.kind !== "awaiting_decision") assert.fail();
      await writeFile(join(root, "README.md"), "# a human was here\n");
      await decide(ws, a.runId, a.interrupt.id, "approve");
      const r = await resume(ws, a.runId, a.interrupt.id);
      assert.equal(r.kind, "failed");
      assert.match(r.kind === "failed" ? r.error : "", /^source_changed.*README\.md/);
    }
    // A peer applied the same file.
    {
      const { ws, root } = await workspace();
      const a = await go(ws, root, taskFor("T-01", ["src/a.ts"]), edit("src/a.ts", "export const a = 2;\n"), "R1");
      if (a.kind !== "awaiting_decision") assert.fail();
      await go(ws, root, taskFor("T-09", ["src/a.ts"]), edit("src/a.ts", "export const a = 9;\n"), "R0");
      await decide(ws, a.runId, a.interrupt.id, "approve");
      const r = await resume(ws, a.runId, a.interrupt.id);
      assert.match(r.kind === "failed" ? r.error : "", /^rebase_conflict/);
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 9;\n", "nothing applied");
    }
    // The checks pass alone and fail with the peer's change in: nothing applied.
    {
      const { ws, root } = await workspace();
      const { readFileSync } = await import("node:fs");
      const failsWithPeer: CheckRunner = async (check, input) => {
        const ok = !readFileSync(join(input.cwd, "src", "b.ts"), "utf8").includes("peer");
        const base = await passingChecks(check, input);
        return ok ? base : { ...base, status: "unsatisfied", reason: "exit 1" };
      };
      const a = await go(ws, root, taskFor("T-01", ["src/a.ts"]), edit("src/a.ts", "export const a = 2;\n"), "R1", failsWithPeer);
      if (a.kind !== "awaiting_decision") assert.fail();
      await go(ws, root, taskFor("T-02", ["src/b.ts"]), edit("src/b.ts", "export const b = 'peer';\n"), "R0");
      await decide(ws, a.runId, a.interrupt.id, "approve");
      const r = await resume(ws, a.runId, a.interrupt.id, failsWithPeer);
      assert.match(r.kind === "failed" ? r.error : "", /^rebase_failed/);
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    }
  });
});
