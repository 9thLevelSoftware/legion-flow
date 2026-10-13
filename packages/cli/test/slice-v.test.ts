import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, decideCommand, statusCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

async function project() {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-v-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Recover", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.coordinator = { members: [{ id: "alt", adapter: "fake", model: "alt-model" }] };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Recover" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Edit a", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  assert.equal((await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] })).status, "ok");
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ byMember: { default: { edits: [{ path: "src/a.ts", content: "export const a = 'default';\n" }] }, alt: { edits: [{ path: "src/a.ts", content: "export const a = 'alt';\n" }] } } }));
  const choiceRuns = async () => (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.broadcast?.role === "choice");
  return { root, ws, ctx, choiceRuns };
}

describe("M4 slice (v): an orphaned broadcast is recovered on --resume", () => {
  test("the choice run never came to exist and one member was left running: one --resume settles the member, rebuilds the choice, opens it once, and the choice applies", async () => {
    const { root, ws, ctx, choiceRuns } = await project();
    try {
      const started = ResultEnvelopeSchema.parse(await executeCommand(ctx(), { taskId: "T-01", broadcast: true, members: "default,alt", sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 }));
      assert.equal(started.status, "awaiting_decision", JSON.stringify(started.diagnostics));
      // The crash: the choice run is gone; the member runs and their withheld proposals remain.
      const [lost] = await choiceRuns();
      await rm(join(ws.paths.runsDir, lost!.run.id), { recursive: true, force: true });
      assert.equal((await choiceRuns()).length, 0);
      const status = await statusCommand(ctx(), {});
      assert.match(status.diagnostics.find((d) => d.code === "broadcast_orphaned")?.message ?? JSON.stringify(status.diagnostics), /has 2 finished member run\(s\) and no choice run/);
      // As a crash would leave it: one member still marked running. The same resume settles it and then recovers the broadcast.
      const oneMember = (await ws.runs.list()).find((r) => r.run.kind === "workflow" && r.run.broadcast?.role === "member")!;
      const rec = JSON.parse(await readFile(join(oneMember.dir, "run.json"), "utf8"));
      rec.status = "running";
      await writeFile(join(oneMember.dir, "run.json"), JSON.stringify(rec, null, 2));

      // Settling the running member is an ordinary resume and prepares its tier; the broadcast is recovered in the same call.
      const recovered = ResultEnvelopeSchema.parse(await executeCommand(ctx(), { resume: true, sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false }));
      assert.equal(recovered.status, "awaiting_decision", JSON.stringify(recovered.diagnostics));
      assert.match(recovered.diagnostics.find((d) => d.code === "broadcast_recovered")!.message, /had no choice run .* recovered from 2 member run\(s\)/);
      assert.equal(recovered.diagnostics.filter((d) => d.code === "broadcast_member").length, 2);
      assert.equal((await choiceRuns()).length, 1);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
      assert.equal(events.filter((e) => e.type === "broadcast_recovered").length, 1);

      // Control: with the choice run present, a resume opens no second one.
      await executeCommand(ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false });
      assert.equal((await choiceRuns()).length, 1, "a choice run that exists is never recovered again");

      const interruptId = (recovered.nextAction as { interruptId: string }).interruptId;
      assert.equal((await decideCommand(ctx(), { interruptId, edit: JSON.stringify({ member: "alt" }), approver: "lead" })).status, "ok");
      const applied = ResultEnvelopeSchema.parse(await executeCommand(ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false }));
      assert.equal(applied.status, "ok", JSON.stringify(applied.diagnostics));
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 'alt';\n");

      // A broadcast whose task is already applied is not recovered: re-label one member under a fresh broadcast id.
      const member = (await ws.runs.list()).find((r) => r.run.kind === "workflow" && r.run.broadcast?.role === "member")!;
      const record = JSON.parse(await readFile(join(member.dir, "run.json"), "utf8"));
      record.broadcast.id = "bcs_orphanx";
      await writeFile(join(member.dir, "run.json"), JSON.stringify(record, null, 2));
      const after = await executeCommand(ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false });
      assert.match(after.diagnostics.find((d) => d.code === "broadcast_not_recovered")?.message ?? JSON.stringify(after.diagnostics), /already applied/);
      assert.equal((await choiceRuns()).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (v): recovering a pure orphan prepares nothing", () => {
  test("with only an orphaned broadcast open, --resume opens its choice with no terminal and no consent", async () => {
    const { root, ws, ctx, choiceRuns } = await project();
    try {
      const started = ResultEnvelopeSchema.parse(await executeCommand(ctx(), { taskId: "T-01", broadcast: true, members: "default,alt", sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 }));
      assert.equal(started.status, "awaiting_decision");
      const [lost] = await choiceRuns();
      await rm(join(ws.paths.runsDir, lost!.run.id), { recursive: true, force: true });
      const recovered = ResultEnvelopeSchema.parse(await executeCommand(ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false }));
      assert.equal(recovered.status, "awaiting_decision", JSON.stringify(recovered.diagnostics));
      assert.ok(recovered.diagnostics.some((d) => d.code === "broadcast_recovered"));
      assert.equal((await choiceRuns()).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
