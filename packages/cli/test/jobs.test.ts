import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, decideCommand, executeCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

async function project(tier: string, tasks: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-jobs-"));
  await mkdir(join(root, "src"), { recursive: true });
  for (const f of ["a", "b", "c"]) await writeFile(join(root, "src", `${f}.ts`), `export const ${f} = 1;\n`);
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "Jobs", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = tier;
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx, { new: "Jobs" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = tasks;
  await writeFile(planJson, JSON.stringify(p, null, 2));
  await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  // One script for every run: each run keeps only the edit its contract allows and reverts the rest.
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }, { path: "src/b.ts", content: "export const b = 2;\n" }, { path: "src/c.ts", content: "export const c = 2;\n" }] }));
  const exec = (opts: Record<string, unknown> = {}) => executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });
  return { root, ws, ctx, exec };
}

const task = (id: string, files: string[], dependsOn: string[] = []) => ({ id, title: id, acceptanceIds: ["AC-01"], dependsOn, contract: { filesAllowed: files, verificationCommands: [] } });

describe("M4 slice (d): execute --jobs", () => {
  test("R0: disjoint tasks run in parallel and all apply, later applies rebasing on earlier ones; an overlapping task waits for the next batch", async () => {
    const { root, ws, exec } = await project("R0", [task("T-01", ["src/a.ts"]), task("T-02", ["src/b.ts"]), task("T-03", ["src/"])]);
    try {
      const batch = ResultEnvelopeSchema.parse(await exec({ jobs: 3 }));
      assert.equal(batch.status, "ok", JSON.stringify(batch.diagnostics));
      assert.match(batch.diagnostics.find((d) => d.code === "execute_batch")?.message ?? "", /Running 2 task\(s\) in parallel \(T-01, T-02\)/);
      assert.match(batch.diagnostics.find((d) => d.code === "task_deferred")?.message ?? "", /T-03 waits for a later batch: its contract may overlap T-01/);
      assert.equal(batch.diagnostics.filter((d) => d.code === "execution_auto_applied").length, 2);
      assert.equal(batch.runId, undefined, "a batch envelope names no single run");
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 2;\n");
      assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 2;\n");
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; rebase?: string | null });
      const applies = events.filter((e) => e.type === "proposal_auto_applied");
      assert.equal(applies.length, 2);
      assert.equal(applies.filter((e) => e.rebase).length, 1, "the second apply rebased on the first");
      assert.equal((await ws.audit.verify()).valid, true, "parallel runs kept the chain intact");
      const { shipCommand } = await import("../dist/index.js");
      const shipped = await shipCommand({ cwd: root, isTTY: true, workspace: ws }, {});
      assert.equal(shipped.gates.find((g) => g.gateId === "deterministic_verification")?.status, "satisfied", "a rebased apply ships: the gate verifies the checkout the last apply produced");

      const next = await exec({ jobs: 3 });
      assert.equal(next.status, "ok", JSON.stringify(next.diagnostics));
      assert.equal(await readFile(join(root, "src", "c.ts"), "utf8"), "export const c = 2;\n", "the deferred task runs alone next time");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R1: every parallel run pauses on its own; --resume settles each decided one in plan order, rebasing, and names the one still pending", async () => {
    const { root, ws, ctx, exec } = await project("R1", [task("T-01", ["src/a.ts"]), task("T-02", ["src/b.ts"]), task("T-03", ["src/c.ts"])]);
    try {
      const paused = await exec({ jobs: 3 });
      assert.equal(paused.status, "awaiting_decision");
      const pending = paused.diagnostics.filter((d) => d.code === "proposal_pending");
      assert.equal(pending.length, 3);
      const interrupts = await Promise.all((await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.task).map(async (r) => ({ task: (r.run as { task: { taskId: string } }).task.taskId, id: (await ws.interrupts.list(r.run.id))[0]!.interrupt.id })));
      const idOf = (t: string) => interrupts.find((i) => i.task === t)!.id;
      await decideCommand(ctx, { interruptId: idOf("T-01"), approve: true, approver: "lead" });
      await decideCommand(ctx, { interruptId: idOf("T-02"), approve: true, approver: "lead" });
      const resumed = await exec({ resume: true });
      assert.equal(resumed.status, "awaiting_decision", JSON.stringify(resumed.diagnostics));
      assert.equal(resumed.diagnostics.filter((d) => d.code === "execution_applied").length, 2);
      assert.match(resumed.diagnostics.find((d) => d.code === "decision_pending")?.message ?? "", /T-03/);
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 2;\n");
      assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 2;\n");
      assert.equal(await readFile(join(root, "src", "c.ts"), "utf8"), "export const c = 1;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--jobs is validated and does not combine with a task id or --resume", async () => {
    const { root, exec } = await project("R0", [task("T-01", ["src/a.ts"])]);
    try {
      assert.equal((await exec({ jobs: 0 })).status, "usage_error");
      assert.equal((await exec({ jobs: 9 })).status, "usage_error");
      assert.equal((await exec({ jobs: "two" })).status, "usage_error");
      assert.equal((await exec({ jobs: 2, taskId: "T-01" })).status, "usage_error");
      assert.equal((await exec({ jobs: 2, resume: true })).status, "usage_error");
      assert.equal((await exec({ jobs: 2, materialize: "worktree" })).diagnostics[0]?.code, "jobs_conflict");
      const single = await exec({ jobs: 4 });
      assert.equal(single.status, "ok");
      assert.match(single.diagnostics.find((d) => d.code === "execute_batch")?.message ?? "", /Only T-01 can run now/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
