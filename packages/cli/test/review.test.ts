import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, ReviewReceiptSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand, executeCommand, decideCommand, reviewCommand, shipCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const run = { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 } as const;

/** A project at R2 with every task applied (through the R1+ apply interrupt), optionally with a reviewer configured. */
async function appliedProject(root: string, review?: { adapter: string; model?: string }) {
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await initCommand(ctx, { adapter: "fake", name: "Rv", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R2";
  if (review) cfg.review = review;
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
  const created = await specCommand(ctx, { new: "Review" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "a is edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "edit a", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
  await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  const paused = await executeCommand(ctx, run);
  assert.equal(paused.status, "awaiting_decision", JSON.stringify(paused.diagnostics));
  if (paused.nextAction.type !== "human_decision") assert.fail();
  await decideCommand(ctx, { interruptId: paused.nextAction.interruptId, approve: true, approver: "lead" });
  const applied = await executeCommand(ctx, { ...run, resume: true });
  assert.equal(applied.status, "ok", JSON.stringify(applied.diagnostics));
  return { ws, ctx };
}

const fakePlan = (ws: Workspace, plan: unknown) => writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(plan), "utf8");

describe("M3 slice (b): review, review --accept, the reviewing phase, the independent_review gate", () => {
  test("R2: applied plan enters reviewing; an independent PASS awaits acceptance; accept records a receipt; ship is ready with the reviewer as judge", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-review-"));
    try {
      const { ws, ctx } = await appliedProject(root, { adapter: "fake", model: "reviewer-model" });
      const status = await statusCommand(ctx, {});
      assert.equal(status.phase, "reviewing");
      assert.equal(status.nextAction.type === "command" && status.nextAction.run, "legion-flow review");
      assert.ok(status.diagnostics.some((d) => d.code === "review_required"));

      const early = await shipCommand(ctx, {});
      assert.equal(early.status, "blocked");
      assert.equal(early.gates.find((g) => g.gateId === "independent_review")?.status, "unevaluable");

      const reviewed = await reviewCommand(ctx, run);
      ResultEnvelopeSchema.parse(reviewed);
      assert.equal(reviewed.status, "ok", JSON.stringify(reviewed.diagnostics));
      assert.ok(reviewed.diagnostics.some((d) => d.code === "review_passed"));
      assert.equal(reviewed.nextAction.type === "command" && reviewed.nextAction.run, "legion-flow review --accept --approver <id>");
      const loaded = (await ws.runs.load(reviewed.runId!))!;
      assert.equal(loaded.run.kind === "workflow" && loaded.run.review?.verdict, "PASS");
      assert.equal(loaded.run.kind === "workflow" && loaded.run.review?.independent, true);
      assert.ok(loaded.evidenceIndex.some((e) => e.producedBy === "verdict"), "review notes are evidence");
      assert.equal((await ws.runs.verifyEvidence(loaded)).ok, true);
      const afterReview = await statusCommand(ctx, {});
      assert.equal(afterReview.phase, "reviewing");
      assert.equal(afterReview.nextAction.type === "command" && afterReview.nextAction.run, "legion-flow review --accept --approver <id>");

      const pending = await shipCommand(ctx, {});
      assert.match(pending.gates.find((g) => g.gateId === "independent_review")?.reason ?? "", /awaits acceptance/);

      const piped = await reviewCommand({ ...ctx, isTTY: false }, { accept: true, approver: "lead" });
      assert.equal(piped.diagnostics[0]?.code, "review_accept_requires_tty");
      const exclusive = await reviewCommand(ctx, { accept: true, approver: "lead", resume: true });
      assert.equal(exclusive.status, "usage_error");
      const accepted = await reviewCommand(ctx, { accept: true, approver: "lead" });
      assert.equal(accepted.status, "ok", JSON.stringify(accepted.diagnostics));
      const receiptPath = accepted.diagnostics.find((d) => d.code === "review_accepted")!.path!;
      const receipt = ReviewReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
      assert.equal(receipt.runId, reviewed.runId);
      assert.equal(receipt.decidedBy.id, "lead");
      assert.equal(accepted.phase, "plan_ready");
      assert.equal(accepted.nextAction.type === "command" && accepted.nextAction.run, "legion-flow ship");
      assert.equal((await reviewCommand(ctx, { accept: true, approver: "lead" })).diagnostics[0]?.code, "review_unchanged");

      const ship = await shipCommand(ctx, {});
      assert.equal(ship.status, "ready", JSON.stringify(ship.gates.map((g) => [g.gateId, g.status, g.reason])));
      const gate = ship.gates.find((g) => g.gateId === "independent_review")!;
      assert.equal(gate.status, "satisfied");
      assert.deepEqual(gate.judge, { model: "fake:reviewer-model", role: "judge", distinctFromExecutor: true });
      assert.ok(gate.evidence.length === 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strict PASS: a FAIL line, a missing verdict line, and a crashed reviewer are all FAIL; a changed checkout makes the PASS stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-review-fail-"));
    try {
      const { ws, ctx } = await appliedProject(root, { adapter: "fake", model: "reviewer-model" });
      await fakePlan(ws, { review: { notes: "AC-01 is not met: a is unchanged in meaning.", verdict: "FAIL" } });
      const failed = await reviewCommand(ctx, run);
      assert.equal(failed.status, "blocked");
      assert.match(failed.diagnostics.find((d) => d.code === "review_failed")?.message ?? "", /acceptance criteria unmet/);
      const status = await statusCommand(ctx, {});
      assert.equal(status.phase, "reviewing");
      assert.ok(status.diagnostics.some((d) => d.code === "review_failed"));
      assert.equal((await shipCommand(ctx, {})).gates.find((g) => g.gateId === "independent_review")?.status, "unsatisfied");
      assert.equal((await reviewCommand(ctx, { accept: true, approver: "lead" })).diagnostics[0]?.code, "review_not_passed");

      assert.equal(failed.nextAction.type === "command" && failed.nextAction.run, "legion-flow execute <taskId>");
      await rm(join(ws.paths.varDir, "fake-adapter.json"));
      // The way out: re-execute the rejected task by name, which a failed review allows; bare execute still has nothing to do.
      assert.equal((await executeCommand(ctx, run)).diagnostics[0]?.code, "no_task_remaining");
      const again = await executeCommand(ctx, { ...run, taskId: "T-01" });
      assert.equal(again.status, "awaiting_decision", JSON.stringify(again.diagnostics));
      if (again.nextAction.type !== "human_decision") assert.fail();
      await decideCommand(ctx, { interruptId: again.nextAction.interruptId, approve: true, approver: "lead" });
      assert.equal((await executeCommand(ctx, { ...run, resume: true })).status, "ok");
      const afterRerun = await statusCommand(ctx, {});
      assert.equal(afterRerun.phase, "reviewing");
      assert.ok(afterRerun.diagnostics.some((d) => d.code === "review_required"), "the failed review is stale for the new tree");

      await fakePlan(ws, { review: { notes: "looks fine", verdict: "none" } });
      const noLine = await reviewCommand(ctx, run);
      assert.match(noLine.diagnostics.find((d) => d.code === "review_failed")?.message ?? "", /not a verdict line/);

      await fakePlan(ws, { exitCode: 9 });
      const crashed = await reviewCommand(ctx, run);
      assert.match(crashed.diagnostics.find((d) => d.code === "review_failed")?.message ?? "", /exited 9/);

      await rm(join(ws.paths.varDir, "fake-adapter.json"));
      const passed = await reviewCommand(ctx, run);
      assert.equal(passed.status, "ok");
      await writeFile(join(root, "src", "a.ts"), "export const a = 99;\n");
      const stale = await reviewCommand(ctx, { accept: true, approver: "lead" });
      assert.equal(stale.diagnostics[0]?.code, "review_stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no reviewer configured, and a reviewer equal to the executor, are refused; a review-time waiver runs it but the gate stays unsatisfied", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-review-same-"));
    try {
      const { ws, ctx } = await appliedProject(root);
      const unconfigured = await reviewCommand(ctx, run);
      assert.equal(unconfigured.diagnostics[0]?.code, "reviewer_unconfigured");
      assert.match(unconfigured.diagnostics[0]?.hint ?? "", /^FIX: set review.adapter/);

      // Same adapter, no model: the reviewer is the executor. Changing the config re-approves spec and plan.
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.review = { adapter: "fake" };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      await approveCommand(ctx, { subject: "spec", approver: "lead" });
      await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
      const same = await reviewCommand(ctx, run);
      assert.equal(same.diagnostics[0]?.code, "reviewer_equals_executor");

      const waived = await reviewCommand(ctx, { ...run, waive: "independent_review: no second model is available on this machine yet", approver: "lead" });
      assert.equal(waived.status, "ok", JSON.stringify(waived.diagnostics));
      assert.ok(waived.diagnostics.some((d) => d.code === "reviewer" && d.severity === "warning"));
      const accepted = await reviewCommand(ctx, { accept: true, approver: "lead" });
      assert.ok(accepted.diagnostics.some((d) => d.code === "review_not_independent"));
      const ship = await shipCommand(ctx, {});
      const gate = ship.gates.find((g) => g.gateId === "independent_review")!;
      assert.equal(gate.status, "unsatisfied");
      assert.equal(gate.judge?.distinctFromExecutor, false);
      assert.match(gate.reason, /only a ship waiver can carry this gate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
