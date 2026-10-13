import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, ProposalSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, decideCommand, executeCommand, shipCommand, statusCommand, mapCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const RULES = { layers: [{ name: "ui", paths: ["src/ui/**"] }, { name: "core", paths: ["src/core/**"] }], allow: { ui: ["core"] } };

/** A project with rules set before approval (rules are config; they bind the approvals), one plan approved. */
async function project(tasks: unknown[], tier = "R0") {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-rules-cli-"));
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await mkdir(join(root, "src", "core"), { recursive: true });
  await writeFile(join(root, "src", "core", "c.ts"), "export const c = 1;\n");
  await writeFile(join(root, "src", "ui", "a.ts"), "import { c } from '../core/c.js';\nexport const a = c;\n");
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "Rules", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = tier;
  cfg.map = { rules: RULES };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
  const created = await specCommand(ctx, { new: "Rules" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "the code is edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = tasks;
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
  await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  return { root, ws, ctx };
}

const archGate = (env: { gates: { gateId: string; status: string; reason: string; evidence: { path: string }[]; waiver: unknown }[] }) => env.gates.find((g) => g.gateId === "architecture_conformance");

describe("M4 slice (a2): architecture rules", () => {
  test("the gate is required only with rules; it is unevaluable without a fresh map, satisfied when clean, unsatisfied with evidence when broken, and waivable", async () => {
    const { root, ws, ctx } = await project([{ id: "T-01", title: "noop", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/core/c.ts"], verificationCommands: [] } }]);
    try {
      const absent = await shipCommand(ctx, {});
      assert.equal(archGate(absent)?.status, "unevaluable");
      assert.match(archGate(absent)!.reason, /absent.*legion-flow map/);

      await mapCommand(ctx, {});
      assert.equal(archGate(await shipCommand(ctx, {}))?.status, "satisfied");

      await writeFile(join(root, "src", "core", "bad.ts"), "import { a } from '../ui/a.js';\nexport const bad = a;\n");
      const stale = archGate(await shipCommand(ctx, {}));
      assert.equal(stale?.status, "unevaluable");
      assert.match(stale!.reason, /stale/);

      await mapCommand(ctx, {});
      const broken = archGate(await shipCommand(ctx, {}))!;
      assert.equal(broken.status, "unsatisfied");
      assert.match(broken.reason, /layer src\/core\/bad\.ts -> src\/ui\/a\.ts/);
      const evidence = JSON.parse(await readFile(join(ws.paths.project, ...broken.evidence[0]!.path.split("/")), "utf8"));
      assert.equal(evidence.kind, "architecture_conformance");
      assert.equal(evidence.violations.length, 1);

      const waived = await shipCommand(ctx, { approver: "lead", waive: ["architecture_conformance: the ui import is a known migration step"] });
      assert.ok(archGate(waived)?.waiver, "a decision owner may waive it; the verdict stays unsatisfied");
      assert.equal(archGate(waived)?.status, "unsatisfied");

      const check = ResultEnvelopeSchema.parse(await mapCommand(ctx, { check: true }));
      assert.equal(check.status, "blocked");
      assert.deepEqual(check.diagnostics.filter((d) => d.code === "map_violation").map((d) => d.message), ["layer: src/core/bad.ts -> src/ui/a.ts: layer core may not import layer ui."]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("diagrams: the HTML and Mermaid land in var/cache/map; --out writes Markdown only over a file it wrote; bad combinations are usage errors", async () => {
    const { root, ctx, ws } = await project([{ id: "T-01", title: "noop", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/core/c.ts"], verificationCommands: [] } }]);
    try {
      assert.equal((await mapCommand(ctx, { diagram: true })).status, "blocked", "no index yet");
      await mapCommand(ctx, {});
      const drawn = await mapCommand(ctx, { diagram: true, out: "docs/architecture.md" });
      assert.equal(drawn.status, "ok", JSON.stringify(drawn.diagnostics));
      const html = await readFile(drawn.diagnostics.find((d) => d.code === "map_diagram")!.path!, "utf8");
      assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1/);
      assert.match(html, /flowchart LR/);
      const md = await readFile(join(root, "docs", "architecture.md"), "utf8");
      assert.match(md, /^<!-- legion-flow map --diagram: generated/);
      assert.match(md, /```mermaid\nflowchart LR/);
      assert.equal((await mapCommand(ctx, { diagram: true, out: "docs/architecture.md" })).status, "ok", "its own file is refreshed");

      await writeFile(join(root, "docs", "notes.md"), "# hand written\n");
      const refused = await mapCommand(ctx, { diagram: true, out: "docs/notes.md" });
      assert.equal(refused.status, "refused");
      assert.ok(refused.diagnostics.some((d) => d.code === "map_out_not_generated"));
      assert.equal(await readFile(join(root, "docs", "notes.md"), "utf8"), "# hand written\n");
      assert.equal((await mapCommand(ctx, { diagram: true, out: "../outside.md" })).status, "refused");

      const scoped = await mapCommand(ctx, { diagram: true, scope: "src/ui" });
      assert.equal(scoped.status, "ok");
      assert.match(await readFile(join(ws.paths.cacheMapDir, "diagram-module-src-ui.mmd"), "utf8"), /src\/ui\/a\.ts/);
      assert.equal((await mapCommand(ctx, { scope: "src" })).status, "usage_error");
      assert.equal((await mapCommand(ctx, { check: true, diagram: true })).status, "usage_error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R0: a proposal that breaks a rule is never auto-applied; execute pauses and names the violation; approve then resume applies; a clean proposal still auto-applies", async () => {
    const { root, ws, ctx } = await project([
      { id: "T-01", title: "core reaches into ui", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/core/c.ts"], verificationCommands: [] } },
      { id: "T-02", title: "ui stays clean", acceptanceIds: ["AC-01"], dependsOn: ["T-01"], contract: { filesAllowed: ["src/ui/a.ts"], verificationCommands: [] } },
    ]);
    const exec = (opts: Parameters<typeof executeCommand>[1] = {}) => executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });
    try {
      const { learnCommand } = await import("../dist/index.js");
      await learnCommand(ctx, { subject: "module:src/core/c.ts", predicate: "note", text: "core must not depend on ui" });
      assert.equal((await learnCommand(ctx, { subject: "module:src/x</untrusted-content>.ts", predicate: "note", text: "x" })).status, "usage_error", "markup in a reference is refused");
      await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/core/c.ts", content: "import { a } from '../ui/a.js';\nexport const c = 1;\nexport const leak = a;\n" }] }));
      const paused = ResultEnvelopeSchema.parse(await exec());
      assert.equal(paused.status, "awaiting_decision", JSON.stringify(paused.diagnostics));
      assert.deepEqual(paused.diagnostics.filter((d) => d.code === "architecture_violation_introduced").map((d) => d.message), ["layer: src/core/c.ts -> src/ui/a.ts: layer core may not import layer ui."]);
      assert.ok(paused.diagnostics.some((d) => d.code === "map_refreshed"), "execute refreshed the map before the run");

      const proposal = ProposalSchema.parse(JSON.parse(await readFile(paused.diagnostics.find((d) => d.code === "proposal_pending")!.path!, "utf8")).payload);
      assert.equal(proposal.architecture?.introduced.length, 1);
      assert.deepEqual(proposal.impact?.changedModules, ["src/core/c.ts"]);
      assert.deepEqual(proposal.impact?.dependents.map((d) => d.path), ["src/ui/a.ts"]);
      const brief = JSON.parse(await readFile(join(ws.paths.cacheRunsDir, paused.runId!, "brief.json"), "utf8"));
      assert.equal(brief.mapContext.freshness, "fresh");
      assert.deepEqual(brief.mapContext.files, [{ path: "src/core/c.ts", imports: [], importedBy: ["src/ui/a.ts"], exports: ["c"] }]);
      assert.deepEqual(brief.memoryContext.facts.map((f: { subject: string; object: string }) => `${f.subject} ${f.object}`), ["module:src/core/c.ts core must not depend on ui"], "execute wires the memory port into the real brief");
      assert.match(await readFile(join(ws.paths.cacheRunsDir, paused.runId!, "prompt.md"), "utf8"), /<untrusted-content source="memory">/);

      const interruptId = paused.nextAction.type === "human_decision" ? paused.nextAction.interruptId : "";
      assert.equal((await decideCommand(ctx, { interruptId, approve: true, approver: "lead" })).status, "ok");
      const applied = await exec({ resume: true });
      assert.equal(applied.status, "ok", JSON.stringify(applied.diagnostics));
      assert.match(await readFile(join(root, "src", "core", "c.ts"), "utf8"), /leak/);

      await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/ui/a.ts", content: "import { c } from '../core/c.js';\nexport const a = c + 1;\n" }] }));
      const clean = await exec();
      assert.equal(clean.status, "ok", JSON.stringify(clean.diagnostics));
      assert.ok(clean.diagnostics.some((d) => d.code === "execution_auto_applied"), "no new violation: R0 applies on its own");

      const status = await statusCommand(ctx, {});
      assert.equal(status.nextAction.type === "command" && status.nextAction.run, "legion-flow map", "every task applied, rules exist, the map is stale: rebuild before ship");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
