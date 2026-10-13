import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand, executeCommand, decideCommand, reviewCommand, evalCommand, shipCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const run = { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 } as const;
const evalOpts = { installSignalHandlers: false } as const;

interface Setup {
  tier?: "R0" | "R1" | "R2" | "R3";
  review?: { adapter: string; model?: string };
  judge?: { baseUrl: string; model: string; apiKeyEnv?: string };
  executorModel?: string;
  otlpEndpoint?: string;
  criteria?: { id: string; statement: string; kind: string }[];
}

/** A project with an approved plan; config set before approval so its fingerprint is current. */
async function approvedProject(root: string, setup: Setup = {}) {
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await initCommand(ctx, { adapter: "fake", name: "Ev", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = setup.tier ?? "R0";
  if (setup.review) cfg.review = setup.review;
  if (setup.judge) cfg.judge = setup.judge;
  if (setup.executorModel) cfg.adapter.http = { model: setup.executorModel };
  if (setup.otlpEndpoint) cfg.evidence = { otlpEndpoint: setup.otlpEndpoint };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
  const created = await specCommand(ctx, { new: "Evals" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = setup.criteria ?? [{ id: "AC-01", statement: "a is edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "edit a", acceptanceIds: spec.acceptanceCriteria.map((c: { id: string }) => c.id), contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
  await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  return { ws, ctx };
}

async function writeDataset(ws: Workspace, id: string, version: number, body: Record<string, unknown>) {
  const dir = join(ws.paths.evalsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `v${version}.json`), JSON.stringify({ schema: "legion-flow-golden-dataset/v1", id, version, ...body }, null, 2), "utf8");
}

const greet = { id: "greets", acceptanceIds: ["AC-01"], argv: `${node} -e "console.log('hello v12')"`, repeat: 2, expected: { stdout: "hello v12", contains: ["hello"], pattern: "v\\d+", exitCode: 0 }, metrics: [
  { metric: "exact", scorer: "exact", threshold: 1 },
  { metric: "contains", scorer: "contains", threshold: 1 },
  { metric: "version", scorer: "regex", threshold: 1 },
  { metric: "exits", scorer: "exit_code", threshold: 1 },
] };

describe("M3 slice (c): eval, golden datasets, eval_goldens", () => {
  test("the span copy: a remote collector is turned off with a warning, an absent loopback collector is a warning, and neither changes the outcome", async () => {
    const remoteRoot = await mkdtemp(join(tmpdir(), "legion-flow-eval-fanout-remote-"));
    const deadRoot = await mkdtemp(join(tmpdir(), "legion-flow-eval-fanout-dead-"));
    try {
      const remote = await approvedProject(remoteRoot, { otlpEndpoint: "http://collector.example.com:4318" });
      await writeDataset(remote.ws, "g", 1, { cases: [greet] });
      const r1 = await evalCommand(remote.ctx, { ...evalOpts, dataset: "g" });
      assert.equal(r1.status, "ok", JSON.stringify(r1.diagnostics));
      assert.match(r1.diagnostics.find((d) => d.code === "span_fanout_disabled")?.message ?? "", /loopback|127\.0\.0\.1/);
      assert.ok(!r1.diagnostics.some((d) => d.code === "span_fanout_failed"), "a disabled copy is never attempted");

      const dead = await approvedProject(deadRoot, { otlpEndpoint: "http://127.0.0.1:9" });
      await writeDataset(dead.ws, "g", 1, { cases: [greet] });
      const r2 = await evalCommand(dead.ctx, { ...evalOpts, dataset: "g" });
      assert.equal(r2.status, "ok", JSON.stringify(r2.diagnostics));
      assert.match(r2.diagnostics.find((d) => d.code === "span_fanout_failed")?.message ?? "", /did not reach the collector/);
      const loaded = (await dead.ws.runs.load(r2.runId!))!;
      assert.ok(loaded.evidenceIndex.some((e) => e.producedBy === "spans"), "the records were still written");
    } finally {
      await rm(remoteRoot, { recursive: true, force: true });
      await rm(deadRoot, { recursive: true, force: true });
    }
  });

  test("scaffold, run with every deterministic scorer and repetitions, freeze, drift refusal, new versions, archive, pin, zero cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-eval-"));
    try {
      const { ws, ctx } = await approvedProject(root);
      const scaffold = await evalCommand(ctx, { ...evalOpts, new: "demo" });
      assert.equal(scaffold.status, "ok");
      assert.equal((await evalCommand(ctx, { ...evalOpts, new: "demo" })).diagnostics[0]?.code, "dataset_exists");
      const example = await evalCommand(ctx, { ...evalOpts, dataset: "demo" });
      assert.equal(example.status, "ok", JSON.stringify(example.diagnostics));

      await writeDataset(ws, "greet", 1, { cases: [greet] });
      const passed = await evalCommand(ctx, { ...evalOpts, dataset: "greet" });
      ResultEnvelopeSchema.parse(passed);
      assert.equal(passed.status, "ok", JSON.stringify(passed.diagnostics));
      const loaded = (await ws.runs.load(passed.runId!))!;
      const result = loaded.run.kind === "workflow" ? loaded.run.eval! : assert.fail();
      assert.equal(result.passed, true);
      assert.equal(result.cases[0]!.metrics.length, 4);
      assert.deepEqual(result.cases[0]!.metrics[0]!.scores, [1, 1], "each repetition recorded");
      assert.equal(loaded.evidenceIndex.filter((e) => e.producedBy === "score").length, 2, "one check evidence per repetition");

      // Editing a version that has run is drift.
      await writeDataset(ws, "greet", 1, { cases: [{ ...greet, repeat: 1 }] });
      const drift = await evalCommand(ctx, { ...evalOpts, dataset: "greet" });
      assert.equal(drift.diagnostics[0]?.code, "dataset_version_drift");
      assert.match(drift.diagnostics[0]?.hint ?? "", /v2\.json/);
      await writeDataset(ws, "greet", 1, { cases: [greet] });

      // v2 with a failing expectation; then archived, so v1 is selected again; a pin still reaches v2.
      await writeDataset(ws, "greet", 2, { cases: [{ ...greet, repeat: 1, expected: { ...greet.expected, stdout: "goodbye" } }] });
      const failed = await evalCommand(ctx, { ...evalOpts, dataset: "greet" });
      assert.equal(failed.status, "blocked");
      assert.ok(failed.diagnostics.some((d) => d.code === "eval_failed"));
      assert.ok(failed.diagnostics.some((d) => d.code === "eval_metric_fail" && d.message.startsWith("greets/exact")));
      await writeDataset(ws, "greet", 3, { archived: true, cases: [greet] });
      const skipArchived = await evalCommand(ctx, { ...evalOpts, dataset: "greet" });
      assert.match(skipArchived.diagnostics.find((d) => d.code === "eval_dataset")?.message ?? "", /greet@v2/, "the highest unarchived version");
      const pinned = await evalCommand(ctx, { ...evalOpts, dataset: "greet", datasetVersion: "1" });
      assert.equal(pinned.status, "ok");

      await writeDataset(ws, "empty", 1, { cases: [] });
      const empty = await evalCommand(ctx, { ...evalOpts, dataset: "empty" });
      assert.equal(empty.status, "blocked");
      assert.match(empty.diagnostics.find((d) => d.code === "eval_failed")?.message ?? "", /zero cases/);

      await writeDataset(ws, "shelly", 1, { cases: [{ ...greet, argv: "echo hi | cat" }] });
      assert.equal((await evalCommand(ctx, { ...evalOpts, dataset: "shelly" })).diagnostics[0]?.code, "dataset_invalid");
      assert.equal((await evalCommand(ctx, { ...evalOpts })).status, "usage_error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("the judge, against a fake OpenAI-compatible server on loopback", () => {
    let server: Server;
    let base: string;
    let content = JSON.stringify({ score: 0.9, reason: "clear and correct" });
    before(async () => {
      server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });
    after(() => server.close());

    const judged = { id: "judged", acceptanceIds: ["AC-01"], argv: `${node} -e "console.log('a friendly greeting')"`, input: "Greet the user.", metrics: [{ metric: "helpful", scorer: "judge", threshold: 0.5, rubric: { steps: ["Is it a greeting?"] } }] };

    test("a judged metric passes with the judge recorded; garbage makes it unevaluable; remote, missing key, and judge-equals-executor are refused", async () => {
      const root = await mkdtemp(join(tmpdir(), "legion-flow-eval-judge-"));
      const roots = [root];
      try {
        const { ws, ctx } = await approvedProject(root, { judge: { baseUrl: base, model: "judge-model" } });
        await writeDataset(ws, "j", 1, { cases: [judged] });
        content = JSON.stringify({ score: 0.9, reason: "clear and correct" });
        const ok = await evalCommand(ctx, { ...evalOpts, dataset: "j" });
        assert.equal(ok.status, "ok", JSON.stringify(ok.diagnostics));
        const r = (await ws.runs.load(ok.runId!))!.run;
        assert.equal(r.kind === "workflow" && r.eval?.judge, "judge:judge-model");
        assert.match(r.kind === "workflow" ? r.eval!.cases[0]!.metrics[0]!.promptHashes[0] ?? "" : "", /^[0-9a-f]{64}$/);
        content = "sure, looks good";
        const garbage = await evalCommand(ctx, { ...evalOpts, dataset: "j" });
        assert.equal(garbage.status, "blocked");
        assert.ok(garbage.diagnostics.some((d) => d.code === "eval_unevaluable"));

        const remoteRoot = await mkdtemp(join(tmpdir(), "legion-flow-eval-remote-"));
        roots.push(remoteRoot);
        const remote = await approvedProject(remoteRoot, { judge: { baseUrl: "https://api.example.com/v1", model: "m" } });
        await writeDataset(remote.ws, "j", 1, { cases: [judged] });
        assert.equal((await evalCommand(remote.ctx, { ...evalOpts, dataset: "j" })).diagnostics[0]?.code, "judge_not_loopback");

        const keyRoot = await mkdtemp(join(tmpdir(), "legion-flow-eval-key-"));
        roots.push(keyRoot);
        const keyed = await approvedProject(keyRoot, { judge: { baseUrl: base, model: "m", apiKeyEnv: "LF_SURELY_UNSET_JUDGE_KEY" } });
        await writeDataset(keyed.ws, "j", 1, { cases: [judged] });
        const blocked = await evalCommand(keyed.ctx, { ...evalOpts, dataset: "j" });
        assert.equal(blocked.status, "blocked");
        assert.equal(blocked.nextAction.type === "credential_required" && blocked.nextAction.variable, "LF_SURELY_UNSET_JUDGE_KEY");

        const sameRoot = await mkdtemp(join(tmpdir(), "legion-flow-eval-same-"));
        roots.push(sameRoot);
        const same = await approvedProject(sameRoot, { judge: { baseUrl: base, model: "one-model" }, executorModel: "one-model" });
        await writeDataset(same.ws, "j", 1, { cases: [judged] });
        content = JSON.stringify({ score: 0.9, reason: "fine" });
        assert.equal((await evalCommand(same.ctx, { ...evalOpts, dataset: "j" })).diagnostics[0]?.code, "judge_equals_executor");
        const waived = await evalCommand(same.ctx, { ...evalOpts, dataset: "j", waive: "eval_goldens: only one local model is available on this machine", approver: "lead" });
        assert.equal(waived.status, "ok", JSON.stringify(waived.diagnostics));
        const wr = (await same.ws.runs.load(waived.runId!))!.run;
        assert.equal(wr.kind === "workflow" && wr.eval?.distinctFromExecutor, false);
      } finally {
        for (const r of roots) await rm(r, { recursive: true, force: true });
      }
    });
  });

  test("R3 end to end: execute, review, accept, then status points at eval; a passing dataset covering the test criterion makes ship ready with a score sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-eval-r3-"));
    try {
      const { ws, ctx } = await approvedProject(root, {
        tier: "R3",
        review: { adapter: "fake", model: "reviewer-model" },
        criteria: [{ id: "AC-01", statement: "a is edited", kind: "behavior" }, { id: "AC-02", statement: "greets with a version", kind: "test" }],
      });
      const paused = await executeCommand(ctx, run);
      if (paused.nextAction.type !== "human_decision") assert.fail(JSON.stringify(paused.diagnostics));
      await decideCommand(ctx, { interruptId: paused.nextAction.interruptId, approve: true, approver: "lead" });
      assert.equal((await executeCommand(ctx, { ...run, resume: true })).status, "ok");
      assert.equal((await reviewCommand(ctx, run)).status, "ok");
      assert.equal((await reviewCommand(ctx, { accept: true, approver: "lead" })).status, "ok");

      const needDataset = await statusCommand(ctx, {});
      assert.equal(needDataset.phase, "plan_ready");
      assert.equal(needDataset.nextAction.type === "command" && needDataset.nextAction.run, "legion-flow eval --new <datasetId>");
      const noEval = await shipCommand(ctx, {});
      assert.equal(noEval.gates.find((g) => g.gateId === "eval_goldens")?.status, "unevaluable");

      await writeDataset(ws, "g", 1, { cases: [{ ...greet, acceptanceIds: ["AC-02"], repeat: 1 }] });
      const needRun = await statusCommand(ctx, {});
      assert.equal(needRun.nextAction.type === "command" && needRun.nextAction.run, "legion-flow eval --dataset g");
      assert.equal((await evalCommand(ctx, { ...evalOpts, dataset: "g" })).status, "ok");

      const ship = await shipCommand(ctx, {});
      assert.equal(ship.status, "ready", JSON.stringify(ship.gates.map((g) => [g.gateId, g.status, g.reason])));
      const gate = ship.gates.find((g) => g.gateId === "eval_goldens")!;
      assert.equal(gate.status, "satisfied");
      assert.equal(gate.inputs.goldenDatasetVersion, "g@v1");
      assert.equal(gate.judge, null, "no judged metric, no judge");
      assert.equal(ship.gates.find((g) => g.gateId === "independent_review")?.judge?.model, "fake:reviewer-model", "the review gate keeps its own judge");
      const shipRunId = basename(ship.diagnostics.find((d) => d.code === "ship_run")!.path!);
      const shipRun = (await ws.runs.load(shipRunId))!;
      const sidecar = shipRun.evidenceIndex.find((e) => e.producedBy === "eval_goldens");
      assert.ok(sidecar, "the score sidecar is in the ship run's index");
      const body = JSON.parse(await readFile(join(ws.paths.project, ...sidecar!.path.split("/")), "utf8"));
      assert.equal(body.kind, "score_sidecar");
      assert.deepEqual(Object.keys(body.entries[0]).sort(), ["caseId", "explanation", "failed", "metric", "prompt_hash", "score", "scorer", "threshold"]);
      assert.equal((await ws.runs.verifyEvidence(shipRun)).ok, true);

      // A newest version that cannot be read makes the gate unevaluable, never a silent fallback to an older one.
      await writeFile(join(ws.paths.evalsDir, "g", "v2.json"), "{ not json", "utf8");
      const broken = await shipCommand(ctx, {});
      const brokenGate = broken.gates.find((g) => g.gateId === "eval_goldens")!;
      assert.equal(brokenGate.status, "unevaluable");
      assert.match(brokenGate.reason, /g@v2: unreadable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
