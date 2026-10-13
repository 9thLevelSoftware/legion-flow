import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, learnCommand, specCommand, planCommand, approveCommand, executeCommand, shipCommand, statusCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

test("a pending memory supersession never sets the lifecycle phase: status names the decision, execute and ship proceed", async () => {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-memphase-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    await initCommand(ctx(), { adapter: "fake", name: "P", owner: "lead" });
    const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
    cfg.memory = { singleValued: ["owner"] };
    cfg.defaultRiskTier = "R0";
    await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
    const created = await specCommand(ctx(), { new: "P" });
    const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
    const spec = JSON.parse(await readFile(specJson, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "a", kind: "behavior" }];
    await writeFile(specJson, JSON.stringify(spec, null, 2));
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    const plan = await planCommand(ctx(), { new: true });
    const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks = [{ id: "T-01", title: "edit a", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
    await writeFile(planJson, JSON.stringify(p, null, 2));
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
    await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "one" });
    const pending = await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "two" });
    assert.equal(pending.status, "awaiting_decision");
    const status = await statusCommand(ctx(), {});
    assert.equal(status.phase, "plan_ready", "the lifecycle phase is unchanged");
    assert.equal(status.status, "awaiting_decision", "but the pending human decision is what status names");
    assert.equal(status.nextAction.type, "human_decision");
    await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }] }));
    const exec = await executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
    assert.equal(exec.status, "ok", JSON.stringify(exec.diagnostics));
    const ship = await shipCommand(ctx(), {});
    assert.equal(ship.status, "ready");
    assert.equal(ship.phase, "ready_to_ship");
    const interruptId = pending.nextAction.type === "human_decision" ? pending.nextAction.interruptId : "";
    const { decideCommand } = await import("../dist/index.js");
    const edited = await decideCommand(ctx(true), { interruptId, edit: "{}", approver: "lead" });
    assert.equal(edited.diagnostics[0]?.code, "edit_not_supported", "a fact is not an argument to edit");
    assert.equal((await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "one" })).diagnostics[0]?.code, "fact_exists", "the same fact twice is one fact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
