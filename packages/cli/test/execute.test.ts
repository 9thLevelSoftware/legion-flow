import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, fingerprintTree } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand, decideCommand, executeCommand, shipCommand, reviewCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

describe("execute (M2 slice a) through the handlers, fake adapter spawned for real", () => {
  let root: string;
  let ws: Workspace;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-execute-cli-"));
    ws = Workspace.at(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  const exec = (opts: Parameters<typeof executeCommand>[1] = {}) =>
    executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });

  async function toPlanReady(tasks: unknown[]) {
    await initCommand(ctx(), { adapter: "fake", name: "X", owner: "lead" });
    const created = await specCommand(ctx(), { new: "Exec" });
    const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
    const spec = JSON.parse(await readFile(specJson, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "a and b are edited", kind: "behavior" }];
    await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    const plan = await planCommand(ctx(), { new: true });
    const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks = tasks;
    await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  }

  test("refusals before anything runs: no plan, tier not hardened, confirmation off a terminal, unknown tier", async () => {
    await initCommand(ctx(), { adapter: "fake", name: "X", owner: "lead" });
    const noPlan = await exec();
    assert.equal(noPlan.status, "refused");
    assert.equal(noPlan.diagnostics[0]?.code, "plan_not_approved");

    const notHardened = await executeCommand(ctx(), { sandbox: "unhardened", installSignalHandlers: false });
    assert.equal(notHardened.diagnostics[0]?.code, "sandbox_not_hardened");
    assert.match(notHardened.diagnostics[0]?.hint ?? "", /^FIX:/);
    const piped = await executeCommand(ctx(false), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false });
    assert.equal(piped.diagnostics[0]?.code, "sandbox_confirmation_requires_tty");
    const later = await exec({ sandbox: "jail-bwrap" });
    assert.equal(later.diagnostics[0]?.code, "sandbox_tier_unavailable");
    const bogus = await exec({ sandbox: "cloud" });
    assert.equal(bogus.status, "usage_error");
  });

  test("R1: execute proposes and pauses; status shows awaiting_decision; decide --edit is refused; approve then --resume applies; ship verifies in the applied tree", async () => {
    // Fresh workspace state for this test: the project exists from the previous test.
    await rm(join(root, ".legion-flow"), { recursive: true, force: true });
    await toPlanReady([
      { id: "T-01", title: "edit a", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [`${node} -e 0`] } },
      { id: "T-02", title: "edit b", acceptanceIds: ["AC-01"], dependsOn: ["T-01"], contract: { filesAllowed: ["src/b.ts"], verificationCommands: [] } },
    ]);
    const before = await statusCommand(ctx(), {});
    assert.equal(before.phase, "plan_ready");
    assert.equal(before.nextAction.type === "command" && before.nextAction.run, "legion-flow execute T-01");

    const outOfOrder = await exec({ taskId: "T-02" });
    assert.equal(outOfOrder.diagnostics[0]?.code, "dependencies_unapplied");
    const unknown = await exec({ taskId: "T-09" });
    assert.equal(unknown.diagnostics[0]?.code, "task_unknown");

    const paused = await exec();
    ResultEnvelopeSchema.parse(paused);
    assert.equal(paused.status, "awaiting_decision", JSON.stringify(paused.diagnostics));
    assert.equal(paused.phase, "awaiting_decision");
    assert.ok(paused.runId);
    assert.equal(paused.nextAction.type, "human_decision");
    if (paused.nextAction.type !== "human_decision") return;
    const interruptId = paused.nextAction.interruptId;
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing applied before the decision");

    const status = await statusCommand(ctx(), {});
    assert.equal(status.status, "awaiting_decision");
    const again = await exec();
    assert.equal(again.diagnostics[0]?.code, "run_in_progress");
    const resumeEarly = await exec({ resume: true });
    assert.equal(resumeEarly.status, "awaiting_decision");
    assert.equal(resumeEarly.diagnostics[0]?.code, "decision_pending");

    const edited = await decideCommand(ctx(), { interruptId, edit: '{"files":[]}', approver: "lead" });
    assert.equal(edited.status, "refused");
    assert.equal(edited.diagnostics[0]?.code, "edit_not_supported");
    const approved = await decideCommand(ctx(), { interruptId, approve: true, approver: "lead" });
    assert.equal(approved.status, "ok");

    const applied = await exec({ resume: true });
    ResultEnvelopeSchema.parse(applied);
    assert.equal(applied.status, "ok", JSON.stringify(applied.diagnostics));
    assert.ok(applied.diagnostics.some((d) => d.code === "execution_applied"));
    assert.match(await readFile(join(root, "src", "a.ts"), "utf8"), /fake adapter touched/);
    assert.equal(applied.phase, "plan_ready");
    assert.equal(applied.nextAction.type === "command" && applied.nextAction.run, "legion-flow execute T-02");

    const run = await ws.runs.load(paused.runId!);
    assert.equal(run?.run.kind === "workflow" && run.run.applied?.mode, "decided");
    assert.equal(run?.run.kind === "workflow" && run.run.applied?.sourceFingerprint, (await fingerprintTree(root)).fingerprint);

    // The same-tree rule at ship: the applied tree verifies; a drifted checkout is unevaluable.
    const shipOk = await shipCommand(ctx(), {});
    const dv = shipOk.gates.find((g) => g.gateId === "deterministic_verification");
    assert.equal(dv?.status, "satisfied", dv?.reason);
    assert.equal(dv?.inputs.sourceFingerprint, (await fingerprintTree(root)).fingerprint);
    await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
    const shipDrift = await shipCommand(ctx(), {});
    const dvDrift = shipDrift.gates.find((g) => g.gateId === "deterministic_verification");
    assert.equal(dvDrift?.status, "unevaluable");
    assert.match(dvDrift?.reason ?? "", /not the tree the last applied proposal produced/);
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  });

  test("R0 auto-applies; the fake adapter's plan file drives an out-of-contract edit that is reverted and a failure that blocks", async () => {
    // Drop the project's tier to R0 by editing the record (a new config fingerprint invalidates the approvals, so re-approve).
    const projectJson = ws.paths.projectConfig;
    const cfg = JSON.parse(await readFile(projectJson, "utf8"));
    cfg.defaultRiskTier = "R0";
    await writeFile(projectJson, JSON.stringify(cfg, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });

    await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/b.ts", content: "export const b = 3;\n" }, { path: "src/a.ts", content: "tamper\n" }] }));
    const auto = await exec({ taskId: "T-02" });
    assert.equal(auto.status, "ok", JSON.stringify(auto.diagnostics));
    assert.ok(auto.diagnostics.some((d) => d.code === "execution_auto_applied"));
    assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 3;\n");
    assert.match(await readFile(join(root, "src", "a.ts"), "utf8"), /fake adapter touched/, "the out-of-contract edit to a.ts was reverted");
    assert.equal(auto.nextAction.type === "command" && auto.nextAction.run, "legion-flow ship", "every task applied");
    const done = await exec();
    assert.equal(done.diagnostics[0]?.code, "no_task_remaining");

    // A failing adapter on a fresh plan state: blocked, tree kept.
    const chain = (await ws.audit.verify()).verifiedCount;
    await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ exitCode: 9 }));
    const p = JSON.parse(await readFile(join((await ws.plans.current() as { dir: string }).dir, "plan.json"), "utf8"));
    p.tasks.push({ id: "T-03", title: "fails", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } });
    await writeFile(join((await ws.plans.current() as { dir: string }).dir, "plan.json"), JSON.stringify(p, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
    const failed = await exec({ taskId: "T-03" });
    assert.equal(failed.status, "blocked");
    assert.match(failed.diagnostics.find((d) => d.code === "execution_failed")?.message ?? "", /adapter_failed: fake exited 9/);
    assert.ok(failed.diagnostics.some((d) => d.code === "sandbox_tree_kept"));
    assert.ok((await ws.audit.verify()).verifiedCount > chain);
    const afterFail = await statusCommand(ctx(), {});
    assert.equal(afterFail.phase, "plan_ready", "a failed run is terminal; the project is not executing");
  });
});

import { readdir } from "node:fs/promises";
import { dockerCheapChecks, realDockerCli, resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";

describe("execute in the default vm-docker tier (skipped when Docker or the image is absent)", async () => {
  const cheap = await dockerCheapChecks({ docker: realDockerCli, settings: resolveDockerSettings(undefined) }).catch(() => null);
  const available = cheap?.checks.every((c) => c.status === "pass") ?? false;
  const skip = available ? undefined : `docker not usable here: ${cheap?.checks.find((c) => c.status !== "pass")?.message ?? "client failed"}`;

  test("preflight passes, the fake adapter edits the tree inside a hardened container, R0 auto-applies, and the run carries the tier evidence", { skip }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-execute-docker-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: false, workspace: ws };
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
      await writeFile(join(root, ".env"), "SECRET=1\n");
      await initCommand(ctx, { adapter: "fake", name: "D", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Docker" });
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

      const result = await executeCommand(ctx, { installSignalHandlers: false, adapterTimeoutMs: 180_000 });
      ResultEnvelopeSchema.parse(result);
      assert.equal(result.status, "ok", JSON.stringify(result.diagnostics));
      assert.ok(result.diagnostics.some((d) => d.code === "execution_auto_applied"));
      assert.match(result.diagnostics.find((d) => d.code === "sandbox_tier")?.message ?? "", /^Tier vm-docker/);
      assert.match(await readFile(join(root, "src", "a.ts"), "utf8"), /fake adapter touched/);

      const evidenceDir = join(ws.paths.runsDir, result.runId!, "evidence");
      const records = await Promise.all((await readdir(evidenceDir)).map(async (f) => JSON.parse(await readFile(join(evidenceDir, f), "utf8"))));
      const tier = records.find((r) => r.kind === "sandbox_tier");
      assert.equal(tier?.tier, "vm-docker");
      assert.equal(tier?.preflight?.ok, true);
      assert.ok(tier?.preflight?.checks.some((c: { id: string }) => c.id === "docker_probe"));
      const adapterOutcome = records.find((r) => r.kind === "adapter_outcome");
      assert.equal(adapterOutcome?.argv?.[0], "docker");
      assert.ok(adapterOutcome?.argv?.includes("--network") && adapterOutcome?.argv?.includes("none"));
      assert.equal(adapterOutcome?.argv?.some((a: string) => a.includes("SECRET")), false, "no secret value in the recorded argv");
      // M4 slice x: the agent ran by the local Id preflight resolved, never by the tag, and never pulls.
      assert.match(tier?.preflight?.imageId ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.ok(adapterOutcome?.argv?.includes(tier.preflight.imageId), "the agent runs by the pinned Id");
      assert.equal(adapterOutcome?.argv?.includes("node:22-alpine"), false, "not by the tag");
      assert.deepEqual(adapterOutcome?.argv?.slice(1, 4), ["run", "--pull", "never"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("egress routes gate execute before anything starts", () => {
  test("a route whose secret variable is unset refuses with egress_secret_missing and a FIX naming the variable; duplicate aliases refuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-execute-egress-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: true, workspace: ws };
    try {
      await initCommand(ctx, { adapter: "fake", name: "E", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.egress = { routes: [{ alias: "up", host: "api.example.com", secrets: [{ header: "authorization", ref: "env:LF_SURELY_UNSET_KEY" }] }] };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      delete process.env.LF_SURELY_UNSET_KEY;
      const missing = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      assert.equal(missing.status, "refused");
      assert.equal(missing.diagnostics[0]?.code, "egress_secret_missing");
      assert.match(missing.diagnostics[0]?.hint ?? "", /^FIX: set LF_SURELY_UNSET_KEY/);

      cfg.egress = { routes: [{ alias: "up", host: "a.example.com" }, { alias: "up", host: "b.example.com" }] };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const dup = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      assert.equal(dup.diagnostics[0]?.code, "egress_route_conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("real adapters: credentials and usage limits gate execute before anything starts", () => {
  test("claude on vm-docker without ANTHROPIC_API_KEY is blocked with a credential_required next action; an unreportable cost limit is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-execute-cred-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: true, workspace: ws };
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      await initCommand(ctx, { adapter: "claude", name: "C", owner: "lead" });
      const blocked = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      ResultEnvelopeSchema.parse(blocked);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.nextAction.type, "credential_required");
      if (blocked.nextAction.type !== "credential_required") return;
      assert.equal(blocked.nextAction.variable, "ANTHROPIC_API_KEY");
      assert.equal(blocked.nextAction.adapter, "claude");
      assert.equal(blocked.diagnostics[0]?.code, "credential_required");
      assert.match(blocked.diagnostics[0]?.hint ?? "", /^FIX: set ANTHROPIC_API_KEY/);
      assert.equal((await ws.runs.list()).length, 0, "nothing ran");

      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.adapter.default = "codex";
      cfg.adapter.limits = { costLimitUsd: 1 };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const unreportable = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false });
      assert.equal(unreportable.status, "refused");
      assert.equal(unreportable.diagnostics[0]?.code, "usage_unreportable");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M3 slice (a): span evidence on a task run", () => {
  test("a run leaves otlp_spans records carrying the acceptance ids and node names, indexed as produced by spans, re-hashing clean, with one evidence_recorded audit event", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-spans-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: true, workspace: ws };
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
      await initCommand(ctx, { adapter: "fake", name: "S", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Spans" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: "a edited", kind: "behavior" }, { id: "AC-02", statement: "b", kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
      await approveCommand(ctx, { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx, { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: "edit a", acceptanceIds: ["AC-01", "AC-02"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
      await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });

      const chainBefore = (await ws.audit.verify()).verifiedCount;
      const result = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
      assert.equal(result.status, "ok", JSON.stringify(result.diagnostics));
      const loaded = (await ws.runs.load(result.runId!))!;
      const spanEntries = loaded.evidenceIndex.filter((e) => e.producedBy === "spans");
      assert.ok(spanEntries.length >= 2, `one record per step plus the final flush, got ${spanEntries.length}`);
      assert.equal((await ws.runs.verifyEvidence(loaded)).ok, true);
      const records = await Promise.all(spanEntries.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8"))));
      const spans = records.flatMap((r) => (r.resourceSpans as { scopeSpans: { spans: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[]).flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
      const names = spans.map((s) => s.name);
      for (const n of ["legion.run", "legion.step", "legion.node.materialize", "legion.node.spawn", "legion.node.propose", "legion.node.apply"]) assert.ok(names.includes(n), n);
      const spawn = spans.find((s) => s.name === "legion.node.spawn")!;
      const attr = (key: string) => spawn.attributes.find((a) => a.key === key)?.value;
      assert.deepEqual(attr("legion.ac.id"), { arrayValue: { values: [{ stringValue: "AC-01" }, { stringValue: "AC-02" }] } });
      assert.deepEqual(attr("legion.task.id"), { stringValue: "T-01" });
      assert.deepEqual(attr("legion.effect"), { stringValue: "adapter_spawn" });
      assert.equal(spawn.attributes.some((a) => a.key.includes("path") || a.key.includes("prompt")), false);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const recorded = events.filter((e) => e.type === "evidence_recorded");
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].records, spanEntries.length);
      assert.ok((await ws.audit.verify()).verifiedCount > chainBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M3 slice (a): span records are load-bearing at ship", () => {
  test("tampering with an otlp_spans record of the applied run makes deterministic_verification unevaluable", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-spans-gate-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: true, workspace: ws };
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
      await initCommand(ctx, { adapter: "fake", name: "G", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Gate" });
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
      const run = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
      assert.equal(run.status, "ok", JSON.stringify(run.diagnostics));
      const clean = await shipCommand(ctx, {});
      assert.equal(clean.gates.find((g) => g.gateId === "deterministic_verification")?.status, "satisfied");

      const loaded = (await ws.runs.load(run.runId!))!;
      const spanEntry = loaded.evidenceIndex.find((e) => e.producedBy === "spans")!;
      const spanPath = join(ws.paths.project, ...spanEntry.path.split("/"));
      // Any byte change is drift: the gate re-hashes, it does not parse.
      await writeFile(spanPath, (await readFile(spanPath, "utf8")) + " ", "utf8");
      const drifted = await shipCommand(ctx, {});
      const dv = drifted.gates.find((g) => g.gateId === "deterministic_verification");
      assert.equal(dv?.status, "unevaluable");
      assert.match(dv?.reason ?? "", /no longer matches its index: drifted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (y): a provider on adapter.http", () => {
  test("claude with a provider pauses for the provider's variable on every tier; codex as the default needs a model, then pauses for the same variable; config validation holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-provider-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: true, workspace: ws };
    try {
      delete process.env.LF_SURELY_UNSET_PROVIDER_KEY;
      await initCommand(ctx, { adapter: "claude", name: "P", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.adapter.http = { baseUrl: "https://token-plan.example.com/anthropic", apiKeyEnv: "LF_SURELY_UNSET_PROVIDER_KEY", model: "provider-model-1" };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      for (const tier of [{ sandbox: "vm-docker" }, { sandbox: "unhardened", allowNoSandbox: true }]) {
        const blocked = await executeCommand(ctx, { ...tier, installSignalHandlers: false });
        assert.equal(blocked.status, "blocked", tier.sandbox);
        assert.equal(blocked.nextAction.type === "credential_required" && blocked.nextAction.variable, "LF_SURELY_UNSET_PROVIDER_KEY", tier.sandbox);
        const text = `${blocked.diagnostics[0]?.message} ${blocked.diagnostics[0]?.hint}`;
        if (tier.sandbox === "vm-docker") assert.match(text, /proxy container only/);
        else assert.ok(/reads it directly/.test(text) && !/proxy/.test(text), `the host tier has no proxy: ${text}`);
      }
      // The reviewer is built by the same adapterFor, so a claude reviewer routes through the provider too.
      cfg.review = { adapter: "claude", model: "provider-model-2" };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const reviewEnv = await reviewCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      if (reviewEnv.nextAction.type === "credential_required") assert.equal(reviewEnv.nextAction.variable, "LF_SURELY_UNSET_PROVIDER_KEY");
      assert.ok(!JSON.stringify(reviewEnv).includes("ANTHROPIC_API_KEY"), "a provider-routed reviewer never asks for the vendor's key");
      delete cfg.review;

      // M4 slice aa: codex as the default takes the provider too, and needs a model for its catalog.
      cfg.adapter.default = "codex";
      const savedModel = cfg.adapter.http.model;
      delete cfg.adapter.http.model;
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const codex = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      assert.equal(codex.status, "refused");
      assert.equal(codex.diagnostics[0]?.code, "adapter_provider_model_required");
      assert.match(codex.diagnostics[0]?.hint ?? "", /^FIX: /);
      cfg.adapter.http.model = savedModel;
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const codexKey = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
      assert.equal(codexKey.nextAction.type === "credential_required" && codexKey.nextAction.variable, "LF_SURELY_UNSET_PROVIDER_KEY", "codex pauses for the provider's variable, not OPENAI_API_KEY");

      for (const bad of [{ baseUrl: "http://token-plan.example.com/anthropic", apiKeyEnv: "K" }, { baseUrl: "https://x.example.com/a?q=1", apiKeyEnv: "K" }, { baseUrl: "https://x.example.com/a" }, { baseUrl: "https://x.example.com/a", apiKeyEnv: "lower-case" }]) {
        cfg.adapter.default = "claude";
        cfg.adapter.http = bad;
        await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
        const invalid = await executeCommand(ctx, { sandbox: "vm-docker", installSignalHandlers: false });
        assert.notEqual(invalid.status, "ok", JSON.stringify(bad));
        assert.ok(invalid.diagnostics.some((d) => d.code === "project_config_invalid"), JSON.stringify(bad));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
