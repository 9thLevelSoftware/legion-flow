import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand } from "../dist/index.js";
import { ResultEnvelopeSchema, ApprovalSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

describe("plan and approve plan --check (M1 slice b)", () => {
  let root: string;
  let ws: Workspace;
  let specDir: string;
  let planDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-plan-cli-"));
    ws = Workspace.at(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  const codes = (env: { diagnostics: { code: string }[] }) => env.diagnostics.map((d) => d.code);
  const run = (env: { nextAction: unknown }) => (env.nextAction as { run: string }).run;

  test("plan --new is refused until the spec is frozen", async () => {
    await initCommand(ctx(), { adapter: "fake", name: "App", owner: "lead" });
    const created = await specCommand(ctx(), { new: "Flow" });
    specDir = created.diagnostics.find((d) => d.code === "spec_created")!.path!;

    const tooEarly = await planCommand(ctx(), { new: true });
    assert.equal(tooEarly.status, "refused");
    assert.equal(tooEarly.diagnostics[0]?.code, "spec_not_frozen");

    const bare = await planCommand(ctx(), {});
    assert.equal(bare.status, "blocked");
    assert.equal(bare.diagnostics[0]?.code, "no_current_plan");
  });

  test("after approve spec: plan --new drafts, sets the pointer, phase planning; a second --new is refused", async () => {
    const jsonPath = join(specDir, "spec.json");
    const spec = JSON.parse(await readFile(jsonPath, "utf8"));
    spec.acceptanceCriteria = [
      { id: "AC-01", statement: "login works", kind: "behavior" },
      { id: "AC-02", statement: "tests pass", kind: "test" },
    ];
    await writeFile(jsonPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
    assert.equal((await approveCommand(ctx(), { subject: "spec", approver: "lead" })).phase, "spec_frozen");

    const env = await planCommand(ctx(), { new: true });
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "ok");
    assert.equal(env.phase, "planning");
    planDir = env.diagnostics.find((d) => d.code === "plan_created")!.path!;
    assert.match(run(env), /approve plan .*--check/);

    const again = await planCommand(ctx(), { new: true });
    assert.equal(again.status, "refused");
    assert.equal(again.diagnostics[0]?.code, "plan_exists");

    const status = await statusCommand(ctx(), {});
    assert.equal(status.phase, "planning");
  });

  test("approve plan: --check is required and must be argv; an empty plan and unknown criteria are refused; nothing is written", async () => {
    const noCheck = await approveCommand(ctx(), { subject: "plan", approver: "lead" });
    assert.equal(noCheck.status, "usage_error");
    assert.equal(noCheck.diagnostics[0]?.code, "check_required");

    const shelly = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["pnpm test && echo ok"] });
    assert.equal(shelly.status, "usage_error");
    assert.equal(shelly.diagnostics[0]?.code, "check_not_argv");

    const onSpec = await approveCommand(ctx(), { subject: "spec", approver: "lead", check: ["node --test"] });
    assert.equal(onSpec.status, "usage_error");
    assert.equal(onSpec.diagnostics[0]?.code, "check_not_applicable");

    const empty = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["node --test"] });
    assert.equal(empty.status, "refused");
    assert.ok(codes(empty).includes("plan_has_no_tasks"));

    const planPath = join(planDir, "plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.tasks = [
      { id: "T-01", title: "Route", acceptanceIds: ["AC-99"], dependsOn: ["T-02"], contract: { filesAllowed: ["src/login.ts"], verificationCommands: ["node --test"] } },
    ];
    await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    const bad = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["node --test"] });
    assert.equal(bad.status, "refused");
    assert.ok(codes(bad).includes("plan_unknown_criterion"));
    assert.ok(codes(bad).includes("plan_unknown_dependency"));

    assert.equal((await readdir(ws.paths.approvalsDir)).length, 1, "only the spec receipt exists");
  });

  test("approve plan by an owner with a partial-coverage warning: receipt with checks, phase plan_ready, idempotent", async () => {
    const planPath = join(planDir, "plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.tasks = [
      { id: "T-01", title: "Route", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/login.ts"], verificationCommands: ["node --test test/*.test.ts"] } },
    ];
    await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

    const inspect = await planCommand(ctx(), {});
    assert.equal(inspect.status, "ok");
    assert.ok(codes(inspect).includes("plan_uncovered_criteria"));

    const approved = await approveCommand(ctx(true), { subject: "plan", approver: "lead", check: ["pnpm run typecheck", "node --test test/*.test.ts"] });
    ResultEnvelopeSchema.parse(approved);
    assert.equal(approved.status, "ok");
    assert.equal(approved.phase, "plan_ready");
    assert.ok(codes(approved).includes("plan_uncovered_criteria"), "the gap is reported, the approver accepted it");
    const receipt = ApprovalSchema.parse(JSON.parse(await readFile(approved.diagnostics.find((d) => d.code === "plan_approved")!.path!, "utf8")));
    assert.equal(receipt.subject, "plan");
    assert.deepEqual(receipt.checks, ["pnpm run typecheck", "node --test test/*.test.ts"]);
    assert.ok(receipt.fingerprints.plan);

    const ready = await planCommand(ctx(), {});
    assert.equal(ready.status, "ready");
    assert.match(run(ready), /legion-flow execute/);

    const again = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["anything"] });
    assert.equal(again.diagnostics[0]?.code, "approval_unchanged");
    assert.equal((await readdir(ws.paths.approvalsDir)).length, 2);
  });

  test("drift: editing the plan returns to planning; editing the spec drops to spec_draft and approve plan then refuses", async () => {
    const planPath = join(planDir, "plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.tasks[0].title = "Route (renamed)";
    await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    const s1 = await statusCommand(ctx(), {});
    assert.equal(s1.phase, "planning");
    assert.ok(codes(s1).includes("plan_approval_invalidated"));

    const specPath = join(specDir, "spec.json");
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    spec.acceptanceCriteria.push({ id: "AC-03", statement: "new", kind: "behavior" });
    await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
    const s2 = await statusCommand(ctx(), {});
    assert.equal(s2.phase, "spec_draft");
    assert.ok(codes(s2).includes("spec_approval_invalidated"));
    assert.ok(codes(s2).includes("plan_awaits_spec"));

    const refused = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["node --test"] });
    assert.equal(refused.status, "refused");
    assert.equal(refused.diagnostics[0]?.code, "spec_not_frozen");

    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    const stale = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: ["node --test"] });
    assert.equal(stale.status, "refused");
    assert.equal(stale.diagnostics[0]?.code, "plan_spec_drift", "plan still records the old spec fingerprint");
  });
});
