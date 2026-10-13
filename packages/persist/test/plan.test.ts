import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Approval, type Plan, type Spec } from "@9thlevelsoftware/legion-flow-schema";
import {
  Workspace,
  configFingerprint,
  validatePlanAgainstSpec,
  argvCheckProblem,
  newId,
} from "../dist/index.js";

const spec: Spec = {
  schema: SCHEMA_VERSIONS.SPEC,
  id: "spc_test",
  title: "T",
  acceptanceCriteria: [
    { id: "AC-01", statement: "a", kind: "behavior", surface: "unit", priority: "P1" },
    { id: "AC-02", statement: "b", kind: "test", surface: "unit", priority: "P1" },
  ],
  createdAt: new Date().toISOString(),
};

const planWith = (tasks: Plan["tasks"]): Plan => ({
  schema: SCHEMA_VERSIONS.PLAN,
  id: "pln_test",
  specId: spec.id,
  specFingerprint: "sha256:" + "0".repeat(64),
  tasks,
  createdAt: new Date().toISOString(),
});

const task = (id: string, extra: Partial<Plan["tasks"][number]> = {}): Plan["tasks"][number] => ({
  id,
  title: id,
  acceptanceIds: ["AC-01"],
  dependsOn: [],
  contract: {
    schema: SCHEMA_VERSIONS.FILE_CONTRACT,
    filesAllowed: ["src/a.ts"],
    filesForbidden: [],
    expectedArtifacts: [],
    verificationCommands: ["node --test test/*.test.ts"],
    maxFilesTouched: 20,
  },
  ...extra,
});

describe("plan validation (pure)", () => {
  test("argv checks: shell operators refused, globs and $VAR accepted literally", () => {
    assert.equal(argvCheckProblem("node --test test/*.test.ts"), null);
    assert.equal(argvCheckProblem("pnpm run build --filter $PKG"), null);
    for (const bad of ["a && b", "a || b", "a; b", "a | b", "a > out", "a < in", "`a`", "$(a)", "${a}", "a\nb", "  "]) {
      assert.notEqual(argvCheckProblem(bad), null, bad);
    }
  });

  test("coverage: unknown criterion is an error, uncovered criterion is a warning, zero tasks is an error", () => {
    assert.equal(validatePlanAgainstSpec(planWith([]), spec).errors[0]?.code, "plan_has_no_tasks");

    const unknown = validatePlanAgainstSpec(planWith([task("T-01", { acceptanceIds: ["AC-99"] })]), spec);
    assert.ok(unknown.errors.some((e) => e.code === "plan_unknown_criterion"));

    const partial = validatePlanAgainstSpec(planWith([task("T-01")]), spec);
    assert.deepEqual(partial.errors, []);
    assert.equal(partial.warnings[0]?.code, "plan_uncovered_criteria");
    assert.match(partial.warnings[0]?.message ?? "", /AC-02/);

    const full = validatePlanAgainstSpec(planWith([task("T-01"), task("T-02", { acceptanceIds: ["AC-02"] })]), spec);
    assert.deepEqual(full.errors, []);
    assert.deepEqual(full.warnings, []);
  });

  test("dependencies: unknown ids, cycles, empty file lists, and shell checks are errors", () => {
    const codes = (p: Plan) => validatePlanAgainstSpec(p, spec).errors.map((e) => e.code);
    assert.ok(codes(planWith([task("T-01", { dependsOn: ["T-09"] })])).includes("plan_unknown_dependency"));
    assert.ok(
      codes(planWith([task("T-01", { dependsOn: ["T-02"] }), task("T-02", { dependsOn: ["T-01"] })])).includes("plan_dependency_cycle")
    );
    assert.ok(codes(planWith([task("T-01", { dependsOn: ["T-01"] })])).includes("plan_dependency_cycle"));
    assert.ok(codes(planWith([task("T-01"), task("T-01")])).includes("plan_duplicate_task"));
    const noFiles = task("T-01");
    noFiles.contract = { ...noFiles.contract, filesAllowed: [] };
    assert.ok(codes(planWith([noFiles])).includes("plan_task_without_files"));
    const shelly = task("T-01");
    shelly.contract = { ...shelly.contract, verificationCommands: ["a && b"] };
    assert.ok(codes(planWith([shelly])).includes("check_not_argv"));
  });
});

describe("plan store and the phase ladder through plan_ready", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-plan-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function frozenSpecWorkspace(name: string) {
    const ws = Workspace.at(join(base, name));
    const created = await ws.lock.withLock(async (held) => {
      await ws.project.create({ name, adapterId: "fake", ownerId: "lead" }, held);
      const c = await ws.specs.create("Flow", held);
      await ws.project.setCurrent({ specId: c.spec.id }, held);
      return c;
    }, "test");
    const jsonPath = join(created.dir, "spec.json");
    const s = JSON.parse(await readFile(jsonPath, "utf8"));
    s.acceptanceCriteria = spec.acceptanceCriteria;
    await writeFile(jsonPath, JSON.stringify(s, null, 2), "utf8");
    const current = await ws.specs.current();
    const project = await ws.project.load();
    if (!current || current.kind !== "valid" || project.kind !== "valid") throw new Error("setup");
    const receipt: Approval = {
      schema: SCHEMA_VERSIONS.APPROVAL,
      id: newId("apv"),
      subject: "spec",
      subjectId: current.id,
      fingerprints: { spec: current.fingerprint, config: configFingerprint(project.config) },
      decidedBy: { id: "lead", displayName: "lead", kind: "human" },
      decidedAt: new Date().toISOString(),
      source: "tty",
      idempotencyKey: "k",
    };
    await ws.lock.withLock((held) => ws.approvals.record(receipt, held), "test");
    return { ws, spec: current, specDir: created.dir };
  }

  const phase = async (ws: Workspace) => {
    const p = await ws.project.load();
    if (p.kind !== "valid") throw new Error("project not valid");
    return { phase: p.phase, reasons: p.phaseReasons.map((r) => r.code), config: p.config };
  };

  test("create, load, fingerprint, and the ladder: planning -> plan_ready -> planning on plan edit", async () => {
    const { ws, spec: current } = await frozenSpecWorkspace("ladder");
    assert.equal((await phase(ws)).phase, "spec_frozen");

    const created = await ws.lock.withLock(async (held) => {
      const c = await ws.plans.create({ id: current.id, fingerprint: current.fingerprint }, held);
      await ws.project.setCurrent({ planId: c.plan.id }, held);
      return c;
    }, "test");
    assert.match(created.plan.id, /^pln_/);
    assert.equal(created.plan.specFingerprint, current.fingerprint);
    assert.equal((await phase(ws)).phase, "planning");

    const loaded = await ws.plans.load(created.plan.id);
    assert.equal(loaded.kind === "valid" && loaded.fingerprint, created.fingerprint);
    assert.equal((await ws.plans.current())?.kind, "valid");

    const p = await phase(ws);
    const planReceipt: Approval = {
      schema: SCHEMA_VERSIONS.APPROVAL,
      id: newId("apv"),
      subject: "plan",
      subjectId: created.plan.id,
      fingerprints: { spec: current.fingerprint, plan: created.fingerprint, config: configFingerprint(p.config) },
      checks: ["node --test"],
      decidedBy: { id: "lead", displayName: "lead", kind: "human" },
      decidedAt: new Date().toISOString(),
      source: "piped",
      idempotencyKey: "k2",
    };
    await ws.lock.withLock((held) => ws.approvals.record(planReceipt, held), "test");
    assert.equal((await phase(ws)).phase, "plan_ready");
    assert.equal((await ws.approvals.forSubject("plan", created.plan.id)).length, 1);
    assert.equal((await ws.approvals.forSubject("spec", current.id)).length, 1, "subjects share one directory, filtered");

    const planPath = join(created.dir, "plan.json");
    const edited = JSON.parse(await readFile(planPath, "utf8"));
    edited.tasks = [task("T-01")];
    await writeFile(planPath, JSON.stringify(edited, null, 2), "utf8");
    const after = await phase(ws);
    assert.equal(after.phase, "planning");
    assert.ok(after.reasons.includes("plan_approval_invalidated"));
  });

  test("spec edited after plan approval: the earlier gate wins, both reasons reported", async () => {
    const { ws, spec: current, specDir } = await frozenSpecWorkspace("spec-drift");
    const created = await ws.lock.withLock(async (held) => {
      const c = await ws.plans.create({ id: current.id, fingerprint: current.fingerprint }, held);
      await ws.project.setCurrent({ planId: c.plan.id }, held);
      return c;
    }, "test");
    await appendFile(join(specDir, "SPEC.md"), "\nlate edit\n");
    const p = await phase(ws);
    assert.equal(p.phase, "spec_draft");
    assert.ok(p.reasons.includes("spec_approval_invalidated"));
    assert.ok(p.reasons.includes("plan_awaits_spec"));
    assert.ok(created.plan.id);
  });

  test("plan written against an older spec fingerprint: planning with plan_spec_drift; dangling plan pointer stays spec_frozen", async () => {
    const { ws, spec: current } = await frozenSpecWorkspace("plan-drift");
    const created = await ws.lock.withLock(async (held) => {
      const c = await ws.plans.create({ id: current.id, fingerprint: "sha256:" + "f".repeat(64) }, held);
      await ws.project.setCurrent({ planId: c.plan.id }, held);
      return c;
    }, "test");
    const p = await phase(ws);
    assert.equal(p.phase, "planning");
    assert.deepEqual(p.reasons, ["plan_spec_drift"]);
    assert.ok(created.plan.id);

    await ws.lock.withLock((held) => ws.project.setCurrent({ planId: "pln_gone" }, held), "test");
    const dangling = await phase(ws);
    assert.equal(dangling.phase, "spec_frozen");
    assert.deepEqual(dangling.reasons, ["current_plan_missing"]);
  });
});
