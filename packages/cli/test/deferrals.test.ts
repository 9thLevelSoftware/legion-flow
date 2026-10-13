import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { forkRun, taskWorkflow, type Workflow } from "@9thlevelsoftware/legion-flow-engine";
import { createMaterializer } from "@9thlevelsoftware/legion-flow-sandbox";
import { adapterById } from "@9thlevelsoftware/legion-flow-adapters";
import { runCheck } from "@9thlevelsoftware/legion-flow-gates";
import { initCommand, statusCommand, nextCommand, renderNextText, doctorCommand, renderDoctorText, specCommand, planCommand, approveCommand, executeCommand, shipCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

async function projectAtR0(root: string, ws: Workspace) {
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await initCommand(ctx, { adapter: "fake", name: "D", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
  const created = await specCommand(ctx, { new: "Deferrals" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "a edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "edit a", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
  await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  return ctx;
}

describe("M2 slice (e): next, doctor --metrics, doctor --rebaseline-audit, fork invalidation", () => {
  test("next is status rendered as one line; it never disagrees with status", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-next-"));
    const ws = Workspace.at(root);
    try {
      const ctx = { cwd: root, isTTY: false, workspace: ws };
      const beforeInit = await nextCommand(ctx, {});
      ResultEnvelopeSchema.parse(beforeInit);
      assert.equal(beforeInit.command, "next");
      assert.equal(beforeInit.status, "blocked");
      assert.equal(renderNextText(beforeInit), "legion-flow init --adapter <id>");
      await initCommand(ctx, { adapter: "fake", name: "N", owner: "lead" });
      const status = await statusCommand(ctx, {});
      const next = await nextCommand(ctx, {});
      assert.deepEqual({ ...next, command: "status" }, status, "same envelope, different command name");
      assert.equal(renderNextText(next), "legion-flow spec --new <title>");
      assert.equal(renderNextText({ ...next, nextAction: { type: "credential_required", variable: "ANTHROPIC_API_KEY", adapter: "claude", hint: "x" } }), "set ANTHROPIC_API_KEY (claude adapter), then: legion-flow execute");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor --metrics adds metric_* facts without changing status; the text renderer prints them as a table", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-metrics-"));
    const ws = Workspace.at(root);
    try {
      const ctx = await projectAtR0(root, ws);
      const run = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
      assert.equal(run.status, "ok", JSON.stringify(run.diagnostics));
      const plain = await doctorCommand(ctx, {});
      const withMetrics = await doctorCommand(ctx, { metrics: true });
      assert.equal(withMetrics.status, plain.status);
      const codes = withMetrics.diagnostics.map((d) => d.code);
      for (const c of ["metric_runs_total", "metric_tasks_applied", "metric_interrupts_pending", "metric_releases", "metric_audit_events", "metric_usage_turns", "metric_egress_requests"]) assert.ok(codes.includes(c), c);
      assert.match(withMetrics.diagnostics.find((d) => d.code === "metric_tasks_applied")?.message ?? "", /1 of 1/);
      assert.match(withMetrics.diagnostics.find((d) => d.code === "metric_usage_turns")?.message ?? "", /unknown \(unknown for 1 adapter run that reported none\)/);
      const text = renderDoctorText(withMetrics);
      assert.match(text, /Metrics\n/);
      assert.match(text, /tasks_applied\s+1 of 1/);
      assert.equal(plain.diagnostics.some((d) => d.code.startsWith("metric_")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor --rebaseline-audit: usage and refusal paths, then the recorded repair of a tampered log", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-rebase-cli-"));
    const ws = Workspace.at(root);
    try {
      const ctx = { cwd: root, isTTY: true, workspace: ws };
      await initCommand(ctx, { adapter: "fake", name: "R", owner: "lead" });
      await specCommand(ctx, { new: "x" });
      const reason = "disk incident corrupted one line; operator accepts the log as it stands";
      assert.equal((await doctorCommand(ctx, { rebaselineAudit: true, approver: "lead" })).diagnostics[0]?.code, "rebaseline_reason_required");
      assert.equal((await doctorCommand(ctx, { rebaselineAudit: true, reason, approver: "nobody" })).diagnostics[0]?.code, "approver_not_decision_owner");
      assert.equal((await doctorCommand({ ...ctx, isTTY: false }, { rebaselineAudit: true, reason, approver: "lead" })).diagnostics[0]?.code, "rebaseline_requires_tty");
      const clean = await doctorCommand(ctx, { rebaselineAudit: true, reason, approver: "lead" });
      assert.equal(clean.status, "refused");
      assert.equal(clean.diagnostics[0]?.code, "audit_rebaseline_unneeded");

      const lines = (await readFile(ws.paths.eventsJsonl, "utf8")).split("\n").filter(Boolean);
      lines[0] = lines[0]!.replace("spec_created", "tampered_event").replace(/"type":"[a-z_]+"/, '"type":"tampered"');
      await writeFile(ws.paths.eventsJsonl, lines.join("\n") + "\n", "utf8");
      const broken = await doctorCommand(ctx, {});
      assert.equal(broken.status, "blocked");
      assert.equal(broken.diagnostics.find((d) => d.code === "audit_chain")?.severity, "error");

      const repaired = await doctorCommand(ctx, { rebaselineAudit: true, reason, approver: "lead", now: new Date("2026-10-09T11:00:00.000Z") });
      ResultEnvelopeSchema.parse(repaired);
      assert.equal(repaired.status, "ok", JSON.stringify(repaired.diagnostics));
      assert.equal(repaired.diagnostics[0]?.code, "audit_rebaselined");
      assert.match(repaired.diagnostics.find((d) => d.code === "audit_chain")?.message ?? "", /baselined at seq/);
      const after = await doctorCommand(ctx, {});
      assert.equal(after.diagnostics.find((d) => d.code === "audit_chain")?.status, undefined);
      assert.match(after.diagnostics.find((d) => d.code === "audit_chain")?.message ?? "", /rebaselined at seq \d+ by lead/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an edited fork of an applied task run withdraws ready_to_ship with reason fork_invalidated; an unedited fork does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-fork-cli-"));
    const ws = Workspace.at(root);
    try {
      const ctx = await projectAtR0(root, ws);
      const run = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
      assert.equal(run.status, "ok", JSON.stringify(run.diagnostics));
      const ship = await shipCommand(ctx, {});
      assert.equal(ship.status, "ready", JSON.stringify(ship.diagnostics));
      assert.equal((await statusCommand(ctx, {})).phase, "ready_to_ship");

      const wf: Workflow = taskWorkflow({ ws, materializer: createMaterializer({ tier: "unhardened", strategy: "copy", paths: ws.paths, runId: "x" })!, adapter: adapterById("fake")!, runCheck });
      const plain = await ws.lock.withLock((held) => forkRun(ws, wf, run.runId!, 1, undefined, held), "test");
      assert.equal(plain.kind, "complete");
      assert.equal((await statusCommand(ctx, {})).phase, "ready_to_ship", "an unedited fork invalidates nothing");

      await new Promise((r) => setTimeout(r, 5));
      const edited = await ws.lock.withLock((held) => forkRun(ws, wf, run.runId!, 1, { log: ["edited by hand"] }, held), "test");
      assert.equal(edited.kind, "complete");
      const status = await statusCommand(ctx, {});
      assert.equal(status.phase, "plan_ready");
      assert.ok(status.diagnostics.some((d) => d.code === "fork_invalidated"), JSON.stringify(status.diagnostics.map((d) => d.code)));

      const again = await shipCommand(ctx, {});
      assert.equal(again.status, "ready", "a fresh evaluation after the fork stands");
      assert.equal((await statusCommand(ctx, {})).phase, "ready_to_ship");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
