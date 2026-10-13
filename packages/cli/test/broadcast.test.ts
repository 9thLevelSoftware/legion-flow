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
import { previousAttemptsFor } from "@9thlevelsoftware/legion-flow-engine";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, decideCommand, statusCommand, shipCommand, reviewCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const MEMBERS = { members: [{ id: "ui", adapter: "fake", model: "ui-model" }, { id: "alt", adapter: "fake", model: "alt-model" }, { id: "strict", adapter: "fake", sandbox: "require" }] };
const edit = (path: string, content: string) => ({ path, content });
const SCRIPT = {
  byMember: {
    default: { edits: [edit("src/a.ts", "export const a = 'good';\n"), edit("src/b.ts", "export const b = 'also';\n")] },
    ui: { edits: [edit("src/a.ts", "export const a = 'good';\n")] },
    alt: { edits: [edit("src/a.ts", "export const a = 'bad';\n")] },
  },
};

async function project(script: unknown, patch: (cfg: Record<string, any>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-broadcast-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(join(root, "check.cjs"), 'process.exit(require("fs").readFileSync("src/a.ts", "utf8").includes("bad") ? 1 : 0);\n');
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Broadcast", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.coordinator = MEMBERS;
  patch(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Broadcast" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "a is good", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Fix a", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/"], verificationCommands: [`${node} check.cjs`] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  assert.equal((await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] })).status, "ok");
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(script));
  const exec = (opts: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });
  const planId = p.id as string;
  return { root, ws, ctx, exec, planId };
}

const choiceOf = (env: { nextAction: unknown }) => (env.nextAction as { interruptId: string }).interruptId;

describe("M4 slice (j2): execute --broadcast", () => {
  test("three members, each withheld even at R0; the fewer-files passing one is recommended; --approve applies it through the same apply; members never become previous attempts", async () => {
    const { root, ws, ctx, exec, planId } = await project(SCRIPT);
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ taskId: "T-01", broadcast: true, members: "default,ui,alt" }));
      assert.equal(env.status, "awaiting_decision", JSON.stringify(env.diagnostics));
      const members = env.diagnostics.filter((d) => d.code === "broadcast_member").map((d) => d.message);
      assert.equal(members.length, 3);
      assert.match(members.find((m) => m.startsWith("ui"))!, /1 file\(s\), 2\/2 check\(s\) passed; every check passed .* \[recommended\]/);
      assert.match(members.find((m) => m.startsWith("alt"))!, /1 of 2 check\(s\) did not pass/);
      assert.match(members.find((m) => m.startsWith("default"))!, /2 file\(s\)/);
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n", "nothing applied before the choice");
      const status = await statusCommand(ctx(), {});
      assert.equal(status.phase, "awaiting_decision");
      assert.equal(status.nextAction.type, "human_decision");
      assert.equal((await exec({ taskId: "T-01" })).diagnostics[0]?.code, "run_in_progress");

      assert.equal((await decideCommand(ctx(), { interruptId: choiceOf(env), approve: true, approver: "lead" })).status, "ok");
      const resumed = ResultEnvelopeSchema.parse(await exec({ resume: true }));
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 'good';\n");
      assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 1;\n", "only the chosen member's change");
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; proposalSha256?: string; memberProposalSha256?: string; member?: string; recommended?: boolean });
      const chosen = events.find((e) => e.type === "broadcast_chosen")!;
      assert.deepEqual([chosen.member, chosen.recommended], ["ui", true]);
      assert.equal(chosen.proposalSha256, chosen.memberProposalSha256, "the copy is the member's proposal byte for byte");
      assert.ok(events.some((e) => e.type === "proposal_applied"));
      assert.deepEqual(await previousAttemptsFor(ws, planId, "T-01"), [], "broadcast members are not previous attempts");
      assert.notEqual((await statusCommand(ctx(), {})).phase, "awaiting_decision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("at R1 the members only withhold and the one pending decision is the choice; after it applies, ship's deterministic gate is satisfied and review counts the chosen member as a writer", async () => {
    const { root, ws, ctx, exec } = await project(SCRIPT, (c) => {
      c.defaultRiskTier = "R1";
      c.review = { adapter: "fake", model: "ui-model" };
    });
    try {
      const env = await exec({ taskId: "T-01", broadcast: true, members: "ui,alt" });
      assert.equal(env.status, "awaiting_decision", JSON.stringify(env.diagnostics));
      const runs = (await ws.runs.list()).filter((r) => r.run.kind === "workflow");
      const members = runs.filter((r) => (r.run as { broadcast?: { role: string } }).broadcast?.role === "member");
      assert.equal(members.length, 2);
      assert.ok(members.every((r) => r.run.status === "complete"), "no member paused on its own apply decision");
      const pending = (await Promise.all(runs.map((r) => ws.interrupts.list(r.run.id)))).flat().filter((i) => i.effectiveStatus === "pending");
      assert.deepEqual(pending.map((i) => i.interrupt.action.name), ["fs.choose_proposal"]);
      await decideCommand(ctx(), { interruptId: choiceOf(env), approve: true, approver: "lead" });
      assert.equal((await exec({ resume: true })).status, "ok");
      const shipped = await shipCommand(ctx(), {});
      assert.equal(shipped.gates.find((g) => g.gateId === "deterministic_verification")?.status, "satisfied", "the gate found the applied proposal in the choice run's own evidence");
      const review = await reviewCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(review.diagnostics[0]?.code, "reviewer_equals_executor", "the chosen member wrote the applied code");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--edit picks another member, even a failing one; a member that is not choosable is edit_invalid; --reject applies nothing", async () => {
    const a = await project(SCRIPT);
    try {
      const env = await a.exec({ taskId: "T-01", broadcast: true, members: "ui,alt" });
      assert.equal((await decideCommand(a.ctx(), { interruptId: choiceOf(env), edit: JSON.stringify({ member: "strict" }), approver: "lead" })).diagnostics[0]?.code, "edit_invalid");
      await decideCommand(a.ctx(), { interruptId: choiceOf(env), edit: JSON.stringify({ member: "alt" }), approver: "lead" });
      assert.equal((await a.exec({ resume: true })).status, "ok");
      assert.equal(await readFile(join(a.root, "src", "a.ts"), "utf8"), "export const a = 'bad';\n", "a human may choose a failing proposal; that is recorded as their call");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project(SCRIPT);
    try {
      const env = await b.exec({ taskId: "T-01", broadcast: true, members: "ui,alt" });
      await decideCommand(b.ctx(), { interruptId: choiceOf(env), reject: true, approver: "lead" });
      assert.equal((await b.exec({ resume: true })).status, "ok");
      assert.equal(await readFile(join(b.root, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("nothing recommended: --approve is choice_required; a failed member is listed without a proposal; no proposal at all is blocked", async () => {
    const a = await project({ byMember: { ui: { edits: [edit("src/a.ts", "export const a = 'bad';\n")] }, alt: { exitCode: 3 } } });
    try {
      const env = await a.exec({ taskId: "T-01", broadcast: true, members: "ui,alt" });
      assert.equal(env.status, "awaiting_decision");
      assert.ok(env.diagnostics.some((d) => d.code === "broadcast_no_recommendation"));
      assert.match(env.diagnostics.find((d) => d.code === "broadcast_member" && d.message.startsWith("alt"))!.message, /no proposal; adapter_failed: fake exited 3/);
      assert.equal((await decideCommand(a.ctx(), { interruptId: choiceOf(env), approve: true, approver: "lead" })).diagnostics[0]?.code, "choice_required");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({ exitCode: 3 });
    try {
      const env = await b.exec({ taskId: "T-01", broadcast: true, members: "ui,alt" });
      assert.equal(env.status, "blocked");
      assert.ok(env.diagnostics.some((d) => d.code === "broadcast_no_proposal"));
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("refusals: no task id, with --jobs, one member, a duplicate, over the cap, an unknown member, --members alone, a sandbox-requiring member on the host", async () => {
    const { root, exec } = await project(SCRIPT);
    try {
      const code = async (opts: Record<string, unknown>) => (await exec(opts)).diagnostics[0]?.code;
      assert.equal(await code({ broadcast: true }), "broadcast_usage");
      assert.equal(await code({ taskId: "T-01", broadcast: true, jobs: 2 }), "broadcast_usage");
      assert.equal(await code({ taskId: "T-01", broadcast: true, members: "ui" }), "broadcast_needs_members");
      assert.equal(await code({ taskId: "T-01", broadcast: true, members: "ui,ui" }), "broadcast_members_invalid");
      assert.equal(await code({ taskId: "T-01", broadcast: true }), "broadcast_too_many", "default plus three declared is over the default cap of 3");
      assert.equal(await code({ taskId: "T-01", broadcast: true, members: "ghost,ui" }), "delegation_rejected");
      assert.equal(await code({ taskId: "T-01", members: "ui,alt" }), "members_needs_broadcast");
      assert.equal(await code({ taskId: "T-01", broadcast: true, members: "ui,strict" }), "delegation_rejected");
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

describe("M4 slice (u): broadcast under vm-docker", () => {
  test("two members run at once, each in its own hardened container; the choice applies; nothing is left behind", async (t) => {
    if (!(await dockerReadyU(t))) return;
    const { root, ws, ctx, exec } = await project(SCRIPT);
    // Other test files run containers in parallel, so only names carrying this test's own run ids are checked.
    let runIds: string[] = [];
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ taskId: "T-01", broadcast: true, members: "default,ui", sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "awaiting_decision", JSON.stringify(env.diagnostics));
      const members = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.broadcast?.role === "member");
      assert.equal(members.length, 2);
      runIds = members.map((m) => m.run.id);
      for (const m of members) {
        const recs = await evidenceOfU(ws, m.run.id);
        assert.equal(recs.find((r) => r.kind === "sandbox_tier")?.tier, "vm-docker");
        assert.match((recs.find((r) => r.kind === "adapter_outcome")!.argv as string[]).join(" "), /--network none/);
      }
      assert.equal((await decideCommand(ctx(), { interruptId: choiceOf(env), approve: true, approver: "lead" })).status, "ok");
      const resumed = ResultEnvelopeSchema.parse(await exec({ resume: true, sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 'good';\n");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      const mine = (await leftoversU()).filter((n) => runIds.some((id) => n.includes(id)));
      assert.deepEqual(mine, [], "no container or network of this broadcast is left behind");
    }
  });
});
