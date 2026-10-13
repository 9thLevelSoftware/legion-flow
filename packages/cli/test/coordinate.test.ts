import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResultEnvelopeSchema, PlanTaskSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { addStepUsage } from "@9thlevelsoftware/legion-flow-engine";
import { resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, reviewCommand, decideCommand, recallCommand, doctorCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const MEMBERS = { members: [{ id: "tester", adapter: "fake", model: "tester-model" }, { id: "polisher", adapter: "fake", model: "polisher-model" }] };
/** A check that passes once src/flag.txt says ok. */
const FLAG_CHECK = `${node} -e "process.exit(require('fs').readFileSync('src/flag.txt','utf8').trim()==='ok'?0:1)"`;

async function project(taskPatch: Record<string, unknown>, fake: Record<string, unknown>, patch: (cfg: Record<string, any>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-coordinate-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "flag.txt"), "start\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Coordinate", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.coordinator = MEMBERS;
  patch(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Coordinate" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Coordinated", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/"], verificationCommands: [] }, ...taskPatch }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(fake));
  const exec = (o: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...o });
  return { root, ws, ctx, exec, approved };
}

async function recordsOf(ws: Workspace, runId: string) {
  const loaded = (await ws.runs.load(runId))!;
  return Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any>));
}
const auditOf = async (ws: Workspace) => (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

const twoSteps = { steps: [{ member: "default", role: "Write the module." }, { member: "tester", role: "Add a test for what step 1 wrote." }] };

describe("M4 slice (m): the coordinate strategy", () => {
  test("declared steps run in order in one tree, each as its member; the steps are recorded on the run, tagged in evidence, and every step member counts for review", async () => {
    const fake = { byMember: { default: { edits: [{ path: "src/new.ts", content: "export const made = 1;\n" }], summary: "Wrote src/new.ts." }, tester: { requireFiles: ["src/new.ts"], edits: [{ path: "src/new.test.ts", content: "import './new.js';\n" }] } } };
    const { root, ws, ctx, exec } = await project({ coordinate: twoSteps }, fake, (c) => (c.review = { adapter: "fake", model: "tester-model" }));
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const run = (await ws.runs.load(env.runId!))!.run as { member?: { id: string; reason: string }; coordinate?: { steps: { id: string; model?: string }[] } };
      assert.deepEqual([run.member?.id, run.member?.reason], ["default", "coordinate"]);
      assert.deepEqual(run.coordinate?.steps.map((s) => s.id), ["default", "tester"]);
      assert.equal(await readFile(join(root, "src", "new.test.ts"), "utf8"), "import './new.js';\n", "step 2's file was applied with step 1's");
      assert.equal(await readFile(join(root, "src", "new.ts"), "utf8"), "export const made = 1;\n");
      const recs = await recordsOf(ws, env.runId!);
      assert.deepEqual(recs.filter((r) => r.kind === "adapter_outcome").map((r) => `${r.round}:${r.step}:${r.member}`), ["1:1:default", "1:2:tester"]);
      const step2 = JSON.parse(await readFile(join(ws.paths.cacheRunsDir, env.runId!, "steps", "r1-s2", "brief.json"), "utf8"));
      assert.equal(step2.member.id, "tester");
      assert.deepEqual(step2.coordinate.touchedSoFar, ["src/new.ts"]);
      assert.match(step2.coordinate.earlier[0].summary, /Wrote src\/new\.ts/);
      const prompt2 = await readFile(join(ws.paths.cacheRunsDir, env.runId!, "steps", "r1-s2", "prompt.md"), "utf8");
      assert.match(prompt2, /^Role \(coordinate step 2 of 2, round 1 of 1, from the approved plan\): Add a test for what step 1 wrote\.$/m);
      assert.ok(prompt2.indexOf("Role (coordinate") < prompt2.indexOf("### Acceptance criteria"), "the role sits at the top, beside the member");
      assert.match(prompt2, /<untrusted-content source="agent">\n- round 1 step 1 \(default, Write the module\.\): [\s\S]*Wrote src\/new\.ts\.[\s\S]*<\/untrusted-content>/);
      const finished = (await auditOf(ws)).find((e) => e.type === "coordinate_finished")!;
      assert.deepEqual([finished.steps, finished.rounds, finished.stoppedBy], [2, 1, "single_round"]);
      const review = await reviewCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(review.diagnostics[0]?.code, "reviewer_equals_executor", "the second step's member wrote applied code: " + JSON.stringify(review.diagnostics));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the steps repeat until the proposal's own checks pass: round 1 fails the check, round 2's brief carries the failure, and the loop stops there", async () => {
    const fake = { byRound: [{ edits: [{ path: "src/flag.txt", content: "not yet\n" }] }, { edits: [{ path: "src/flag.txt", content: "ok\n" }] }, { edits: [{ path: "src/flag.txt", content: "round three\n" }] }] };
    const { root, ws, exec } = await project({ coordinate: { steps: [{ member: "default", role: "Make the check pass." }], maxIterations: 3 }, contract: { filesAllowed: ["src/"], verificationCommands: [FLAG_CHECK] } }, fake);
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const finished = (await auditOf(ws)).find((e) => e.type === "coordinate_finished")!;
      assert.deepEqual([finished.rounds, finished.stoppedBy], [2, "checks_passed"]);
      const round2 = JSON.parse(await readFile(join(ws.paths.cacheRunsDir, env.runId!, "steps", "r2-s1", "brief.json"), "utf8"));
      assert.equal(round2.coordinate.failingChecks.length, 1);
      assert.equal(round2.coordinate.failingChecks[0].status, "unsatisfied");
      assert.equal(await readFile(join(root, "src", "flag.txt"), "utf8"), "ok\n", "round three never ran");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maxIterations exhausted ends in an ordinary proposal; a failing step fails the run and names the step", async () => {
    const a = await project({ coordinate: { steps: [{ member: "default", role: "Try." }], maxIterations: 2 }, contract: { filesAllowed: ["src/"], verificationCommands: [FLAG_CHECK] } }, { edits: [{ path: "src/flag.txt", content: "never\n" }] });
    try {
      const env = ResultEnvelopeSchema.parse(await a.exec());
      assert.ok(env.runId, JSON.stringify(env.diagnostics));
      const finished = (await auditOf(a.ws)).find((e) => e.type === "coordinate_finished")!;
      assert.deepEqual([finished.rounds, finished.stoppedBy], [2, "max_iterations"]);
      assert.ok((await recordsOf(a.ws, env.runId!)).some((r) => r.kind === "legion-flow-proposal/v1" || r.schema === "legion-flow-proposal/v1"), "the tree still went through propose");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({ coordinate: twoSteps }, { byMember: { default: { edits: [{ path: "src/new.ts", content: "x\n" }] }, tester: { exitCode: 1 } } });
    try {
      const env = ResultEnvelopeSchema.parse(await b.exec());
      assert.equal(env.status, "blocked");
      assert.match(JSON.stringify(env.diagnostics), /adapter_failed: step 2 of 2 \(tester, fake\), round 1 of 1 exited 1/);
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("approval refuses coordinate with member and an unknown step member; the schema caps steps and rounds; broadcast refuses a coordinate task", async () => {
    const both = await project({ coordinate: twoSteps, member: "tester" }, {});
    try {
      assert.ok(both.approved.diagnostics.some((d) => d.code === "plan_coordinate_with_member"), JSON.stringify(both.approved.diagnostics));
    } finally {
      await rm(both.root, { recursive: true, force: true });
    }
    const ghost = await project({ coordinate: { steps: [{ member: "ghost", role: "Haunt." }] } }, {});
    try {
      assert.ok(ghost.approved.diagnostics.some((d) => d.code === "plan_member_unknown" && /step 1/.test(d.message)));
    } finally {
      await rm(ghost.root, { recursive: true, force: true });
    }
    const base = { id: "T-01", title: "x", contract: { filesAllowed: ["src/"], verificationCommands: [] } };
    assert.equal(PlanTaskSchema.safeParse({ ...base, coordinate: { steps: Array.from({ length: 5 }, () => ({ member: "default", role: "r" })) } }).success, false);
    assert.equal(PlanTaskSchema.safeParse({ ...base, coordinate: { steps: [{ member: "default", role: "r" }], maxIterations: 4 } }).success, false);
    assert.equal(PlanTaskSchema.safeParse({ ...base, coordinate: { steps: [] } }).success, false);
    const bc = await project({ coordinate: twoSteps }, {});
    try {
      const env = await bc.exec({ taskId: "T-01", broadcast: true });
      assert.equal(env.diagnostics[0]?.code, "broadcast_coordinate", JSON.stringify(env.diagnostics));
    } finally {
      await rm(bc.root, { recursive: true, force: true });
    }
  });

  test("usage limits apply to the running total across steps, and one unknown step makes the total unknown", () => {
    const total = { turns: 0 as number | null, costUsd: 0 as number | null, unknown: null as string | null };
    addStepUsage(total, { known: true, turns: 3, inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    addStepUsage(total, { known: true, turns: 4, inputTokens: 1, outputTokens: 1, costUsd: null });
    assert.deepEqual(total, { turns: 7, costUsd: null, unknown: null });
    addStepUsage(total, { known: false, reason: "no stdout captured" });
    assert.equal(total.unknown, "no stdout captured");
  });

  test("under vm-docker each step runs in its own hardened container against the run's one tree", async (t) => {
    const image = resolveDockerSettings(undefined).image;
    if (!(await promisify(execFile)("docker", ["image", "inspect", image]).then(() => true, () => false))) return t.skip(`${image} is not present locally`);
    const fake = { byMember: { default: { edits: [{ path: "src/new.ts", content: "export const made = 1;\n" }] }, tester: { requireFiles: ["src/new.ts"], edits: [{ path: "src/new.test.ts", content: "import './new.js';\n" }] } } };
    const { root, ws, exec } = await project({ coordinate: twoSteps }, fake);
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const outcomes = (await recordsOf(ws, env.runId!)).filter((r) => r.kind === "adapter_outcome");
      assert.equal(outcomes.length, 2);
      for (const o of outcomes) assert.match((o.argv as string[]).join(" "), /--network none/);
      assert.equal(await readFile(join(root, "src", "new.test.ts"), "utf8"), "import './new.js';\n");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("M4 slice (m): coordinate runs through the other verbs", () => {
  const fake = { byMember: { default: { edits: [{ path: "src/new.ts", content: "export const made = 1;\n" }], summary: "Wrote the zanzibar module." }, tester: { requireFiles: ["src/new.ts"], edits: [{ path: "src/new.test.ts", content: "import './new.js';\n" }], summary: "Tested the zanzibar module." } } };

  test("recall lists every step's summary, and doctor --metrics counts every step's adapter run", async () => {
    const { root, ws, ctx, exec } = await project({ coordinate: twoSteps }, fake);
    try {
      assert.equal((await exec()).status, "ok");
      const recalled = await recallCommand(ctx() as never, { query: "zanzibar module" });
      const doc = JSON.parse(await readFile(recalled.diagnostics.find((d) => d.code === "recall_document")!.path!, "utf8")) as { blocks: { source: string; items: { text: string }[] }[] };
      const transcript = doc.blocks.find((b) => b.source === "transcript")!;
      assert.ok(transcript.items.some((i) => /Wrote the zanzibar module/.test(i.text)) && transcript.items.some((i) => /Tested the zanzibar module/.test(i.text)), JSON.stringify(transcript));
      const metrics = await doctorCommand(ctx(), { metrics: true });
      assert.match(metrics.diagnostics.find((d) => d.code === "metric_usage_turns")!.message, /unknown \(unknown for 2 adapter runs that reported none\)/);
      void ws;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R1: the coordinated proposal waits for a decision; --resume applies it with the recorded steps, and review still counts them", async () => {
    const { root, ws, ctx, exec } = await project({ coordinate: twoSteps }, fake, (c) => {
      c.defaultRiskTier = "R1";
      c.review = { adapter: "fake", model: "tester-model" };
    });
    try {
      const first = ResultEnvelopeSchema.parse(await exec());
      assert.equal(first.status, "awaiting_decision", JSON.stringify(first.diagnostics));
      const interruptId = (first.nextAction as { interruptId: string }).interruptId;
      assert.equal((await decideCommand(ctx(), { interruptId, approve: true, approver: "lead" })).status, "ok");
      const resumed = ResultEnvelopeSchema.parse(await exec({ resume: true }));
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      const run = (await ws.runs.load(first.runId!))!.run as { applied?: unknown; coordinate?: { steps: { id: string }[] } };
      assert.ok(run.applied, "applied after the decision");
      assert.deepEqual(run.coordinate?.steps.map((s) => s.id), ["default", "tester"]);
      assert.equal(await readFile(join(root, "src", "new.test.ts"), "utf8"), "import './new.js';\n");
      const review = await reviewCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(review.diagnostics[0]?.code, "reviewer_equals_executor", JSON.stringify(review.diagnostics));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
