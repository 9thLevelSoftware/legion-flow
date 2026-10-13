import { test, describe } from "node:test";
import { execFile as execFileU } from "node:child_process";
import { promisify as promisifyU } from "node:util";
import { resolveDockerSettings as resolveDockerSettingsU } from "@9thlevelsoftware/legion-flow-sandbox";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, reviewCommand, mapCommand, toolsCommand, decideCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const MEMBERS = { members: [{ id: "ui", adapter: "fake", model: "ui-model" }, { id: "alt", adapter: "fake", model: "alt-model" }, { id: "strict", adapter: "fake", sandbox: "require" }], route: [{ match: ["src/ui/"], member: "ui" }] };

async function project(patch: (cfg: Record<string, any>) => void, tasks: unknown[], approve = true) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-coord-"));
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await writeFile(join(root, "src", "ui", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Coord", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  patch(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Coord" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = tasks;
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = approve ? await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] }) : null;
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ byAttempt: [{}] }));
  const exec = (opts: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });
  return { root, ws, ctx, exec, approved, planJson };
}
const task = (id: string, files: string[], member?: string) => ({ id, title: id, acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: files, verificationCommands: [] }, ...(member ? { member } : {}) });

describe("M4 slice (j1): coordinator route", () => {
  test("a rule routes one task, the plan names another, the rest go to the default; the member is on the run, in the brief and prompt, and in the sandbox evidence", async () => {
    const { root, ws, exec } = await project((c) => (c.coordinator = MEMBERS), [task("T-01", ["src/ui/a.ts"]), task("T-02", ["src/b.ts"], "alt"), task("T-03", ["src/b.ts"])]);
    try {
      const one = ResultEnvelopeSchema.parse(await exec({ taskId: "T-01" }));
      assert.equal(one.status, "ok", JSON.stringify(one.diagnostics));
      assert.match(one.diagnostics.find((d) => d.code === "task_member")!.message, /Member ui \(fake, ui-model\) chosen by route src\/ui\//);
      assert.match(one.diagnostics.find((d) => d.code === "task")!.message, /via adapter fake \(member ui\)/);
      const run = (await ws.runs.load(one.runId!))!.run as { member?: { id: string; model?: string; reason: string } };
      assert.deepEqual([run.member?.id, run.member?.model, run.member?.reason], ["ui", "ui-model", "route src/ui/"]);
      const brief = JSON.parse(await readFile(join(ws.paths.cacheRunsDir, one.runId!, "brief.json"), "utf8"));
      assert.equal(brief.member.id, "ui");
      assert.match(await readFile(join(ws.paths.cacheRunsDir, one.runId!, "prompt.md"), "utf8"), /^Member: ui \(fake, ui-model; chosen by route src\/ui\/\)$/m);
      const loaded = (await ws.runs.load(one.runId!))!;
      const tierEv = await Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { kind?: string; spawn?: { verdict: string; member?: string; kind: string } }));
      const spawn = tierEv.find((r) => r.kind === "sandbox_tier")!.spawn!;
      assert.deepEqual([spawn.kind, spawn.member, spawn.verdict], ["adapter", "ui", "allowed"], "the policy verdict is evidence on the host tier too");

      const two = ResultEnvelopeSchema.parse(await exec({ taskId: "T-02" }));
      assert.equal(((await ws.runs.load(two.runId!))!.run as { member?: { id: string; reason: string } }).member?.reason, "task");
      const three = ResultEnvelopeSchema.parse(await exec({ taskId: "T-03" }));
      assert.equal(((await ws.runs.load(three.runId!))!.run as { member?: { id: string } }).member?.id, "default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a member that requires a sandbox is never delegated to an unhardened run, and no run is created", async () => {
    const { root, ws, exec } = await project((c) => (c.coordinator = MEMBERS), [task("T-01", ["src/b.ts"], "strict")]);
    try {
      const refused = await exec();
      assert.equal(refused.status, "refused");
      assert.equal(refused.diagnostics[0]?.code, "delegation_rejected");
      assert.equal((await ws.runs.list()).filter((r) => r.run.kind === "workflow").length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown member is refused at plan and at approve plan", async () => {
    const { root, ctx, approved } = await project((c) => (c.coordinator = MEMBERS), [task("T-01", ["src/b.ts"], "ghost")]);
    try {
      assert.ok(approved!.diagnostics.some((d) => d.code === "plan_member_unknown"), JSON.stringify(approved!.diagnostics));
      assert.equal(approved!.status, "refused");
      assert.ok((await planCommand(ctx(), {})).diagnostics.some((d) => d.code === "plan_member_unknown"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries of a routed task keep its member", async () => {
    const { root, ws, exec } = await project((c) => (c.coordinator = MEMBERS), [task("T-01", ["src/ui/a.ts"])]);
    try {
      await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ byAttempt: [{ exitCode: 3 }, {}] }));
      const env = await exec({ retry: 1 });
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const members = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.task).map((r) => (r.run as { member?: { id: string } }).member?.id);
      assert.deepEqual(members, ["ui", "ui"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--resume prepares every member's tier before any run moves: a refusal never hides an apply", async () => {
    const { root, ws, ctx, exec } = await project((c) => {
      c.coordinator = MEMBERS;
      c.defaultRiskTier = "R1";
    }, [task("T-01", ["src/ui/a.ts"]), task("T-02", ["src/b.ts"], "alt")]);
    try {
      assert.equal((await exec({ jobs: 2 })).status, "awaiting_decision");
      const runs = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.task);
      for (const r of runs) await decideCommand(ctx(), { interruptId: (await ws.interrupts.list(r.run.id))[0]!.interrupt.id, approve: true, approver: "lead" });
      // The second run's member names an adapter this build no longer has.
      const second = runs.find((r) => (r.run as { task: { taskId: string } }).task.taskId === "T-02")!;
      const record = JSON.parse(await readFile(join(second.dir, "run.json"), "utf8"));
      record.member.adapter = "retired";
      await writeFile(join(second.dir, "run.json"), JSON.stringify(record, null, 2));
      const refused = await exec({ resume: true });
      assert.equal(refused.diagnostics[0]?.code, "delegation_rejected", JSON.stringify(refused.diagnostics));
      const first = (await ws.runs.list()).find((r) => r.run.kind === "workflow" && (r.run as { task?: { taskId: string } }).task?.taskId === "T-01")!;
      assert.equal((first.run as { applied?: unknown }).applied, undefined, "nothing was applied before the refusal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reviewer equal to a routed member that wrote applied code is not independent", async () => {
    const { root, ctx, exec } = await project((c) => {
      c.coordinator = MEMBERS;
      c.review = { adapter: "fake", model: "alt-model" };
    }, [task("T-01", ["src/b.ts"], "alt")]);
    try {
      assert.equal((await exec()).status, "ok");
      const review = await reviewCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(review.diagnostics[0]?.code, "reviewer_equals_executor", JSON.stringify(review.diagnostics));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (j1): sandbox.require", () => {
  test("execute, review, map with a language server, and tools all refuse the host tier, consent on a terminal or not", async () => {
    const { root, ctx, exec } = await project((c) => {
      c.sandbox = { require: true };
      c.review = { adapter: "codex" };
      c.map = { languageServers: [{ language: "fake", extensions: [".fl"], command: "fake-lsp" }] };
      c.mcpServers = [{ name: "fake", command: process.execPath, args: ["-e", "0"] }];
    }, [task("T-01", ["src/b.ts"])]);
    try {
      assert.equal((await exec()).diagnostics[0]?.code, "sandbox_required_by_policy");
      assert.equal((await reviewCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true })).diagnostics[0]?.code, "sandbox_required_by_policy");
      assert.equal((await mapCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true })).diagnostics[0]?.code, "sandbox_required_by_policy");
      assert.equal((await toolsCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true })).diagnostics[0]?.code, "sandbox_required_by_policy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** M4 slice (u): the vm-docker variants run only where Docker and the default node image answer. */
const dockerReadyU = async (t: { skip: (m: string) => void }) => {
  const image = resolveDockerSettingsU(undefined).image;
  const ok = await promisifyU(execFileU)("docker", ["image", "inspect", image]).then(() => true, () => false);
  if (!ok) t.skip(`${image} is not present locally`);
  return ok;
};
/** Containers and networks this tool left behind (they are named lf-...). */
const leftoversU = async () => {
  const run = (args: string[]) => promisifyU(execFileU)("docker", args).then((r) => r.stdout.split("\n").filter((n) => n.startsWith("lf-")), () => [] as string[]);
  return [...(await run(["ps", "-a", "--format", "{{.Names}}"])), ...(await run(["network", "ls", "--format", "{{.Name}}"]))];
};
const evidenceOfU = async (ws: Workspace, runId: string) => {
  const loaded = (await ws.runs.load(runId))!;
  return Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any>));
};

describe("M4 slice (u): routing under vm-docker", () => {
  test("a routed member runs in the hardened container, and the member is on the run and on the sandbox evidence", async (t) => {
    if (!(await dockerReadyU(t))) return;
    const { root, ws, exec } = await project((c) => (c.coordinator = MEMBERS), [task("T-01", ["src/ui/a.ts"])]);
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const run = (await ws.runs.load(env.runId!))!.run as { member?: { id: string; reason: string } };
      assert.deepEqual([run.member?.id, run.member?.reason], ["ui", "route src/ui/"]);
      const recs = await evidenceOfU(ws, env.runId!);
      const tier = recs.find((r) => r.kind === "sandbox_tier")!;
      assert.equal(tier.tier, "vm-docker");
      assert.equal(tier.spawn.member, "ui");
      assert.match((recs.find((r) => r.kind === "adapter_outcome")!.argv as string[]).join(" "), /--network none/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
