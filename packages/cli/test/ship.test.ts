import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand, shipCommand } from "../dist/index.js";
import { ResultEnvelopeSchema, ReleaseSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

describe("ship (M1 slice c)", () => {
  let root: string;
  let ws: Workspace;
  let planDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-ship-cli-"));
    ws = Workspace.at(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  const codes = (env: { diagnostics: { code: string }[] }) => env.diagnostics.map((d) => d.code);
  const node = `"${process.execPath}"`;

  test("ship before a plan exists is refused with nothing_to_ship", async () => {
    await initCommand(ctx(), { adapter: "fake", name: "App", owner: "lead" });
    const early = await shipCommand(ctx(), {});
    assert.equal(early.status, "refused");
    assert.equal(early.diagnostics[0]?.code, "no_current_spec");
  });

  test("full M1 lifecycle: spec, approve, plan, approve --check, ship blocked by a failing check, then ready", async () => {
    const created = await specCommand(ctx(), { new: "Flow" });
    const specDir = created.diagnostics.find((d) => d.code === "spec_created")!.path!;
    const specJson = join(specDir, "spec.json");
    const spec = JSON.parse(await readFile(specJson, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "it works", kind: "behavior" }];
    await writeFile(specJson, JSON.stringify(spec, null, 2) + "\n", "utf8");
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });

    const plan = await planCommand(ctx(), { new: true });
    planDir = plan.diagnostics.find((d) => d.code === "plan_created")!.path!;
    const planJson = join(planDir, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks = [{ id: "T-01", title: "do it", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [`${node} -e "process.exit(1)"`] } }];
    await writeFile(planJson, JSON.stringify(p, null, 2) + "\n", "utf8");
    const approved = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e "process.exit(0)"`] });
    assert.equal(approved.phase, "plan_ready");
    assert.match((approved.nextAction as { run: string }).run, /legion-flow execute/);

    const blocked = await shipCommand(ctx(), {});
    ResultEnvelopeSchema.parse(blocked);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.phase, "plan_ready");
    assert.equal(blocked.gates.length, 5);
    assert.equal(blocked.gates.find((g) => g.gateId === "deterministic_verification")?.status, "unsatisfied");
    assert.ok(codes(blocked).includes("ship_blocked"));

    const commitBlocked = await shipCommand(ctx(), { commit: true, approver: "lead" });
    assert.equal(commitBlocked.status, "blocked");
    assert.equal((await readdir(ws.paths.releasesDir)).length, 0, "no release while blocked");

    // Fix the task check (plan changes, so re-approve), then ship is ready.
    p.tasks[0].contract.verificationCommands = [`${node} -e "process.exit(0)"`];
    await writeFile(planJson, JSON.stringify(p, null, 2) + "\n", "utf8");
    assert.equal((await statusCommand(ctx(), {})).phase, "planning");
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e "process.exit(0)"`] });

    const ready = await shipCommand(ctx(), {});
    assert.equal(ready.status, "ready");
    assert.equal(ready.phase, "ready_to_ship");
    assert.ok(ready.gates.every((g) => g.status === "satisfied"));
    assert.match((ready.nextAction as { run: string }).run, /ship --commit/);
    assert.equal((await statusCommand(ctx(), {})).phase, "ready_to_ship");
  });

  test("ship --commit needs an approver who is an owner; then records a release, phase shipped, idempotent", async () => {
    const noApprover = await shipCommand(ctx(), { commit: true });
    assert.equal(noApprover.status, "usage_error");
    assert.equal(noApprover.diagnostics[0]?.code, "approver_required");

    const stranger = await shipCommand(ctx(), { commit: true, approver: "nobody" });
    assert.equal(stranger.status, "refused");
    assert.equal(stranger.diagnostics[0]?.code, "approver_not_decision_owner");

    const shipped = await shipCommand(ctx(true), { commit: true, approver: "lead" });
    ResultEnvelopeSchema.parse(shipped);
    assert.equal(shipped.status, "ok");
    assert.equal(shipped.phase, "shipped");
    assert.equal(shipped.nextAction.type, "none");
    const releasePath = shipped.diagnostics.find((d) => d.code === "shipped")!.path!;
    const release = ReleaseSchema.parse(JSON.parse(await readFile(releasePath, "utf8")));
    assert.equal(release.decidedBy.id, "lead");
    assert.equal(release.source, "tty");

    const again = await shipCommand(ctx(), { commit: true, approver: "lead" });
    assert.ok(codes(again).includes("release_unchanged"));
    assert.equal((await readdir(ws.paths.releasesDir)).length, 1);
    assert.equal((await statusCommand(ctx(), {})).phase, "shipped");
  });

  test("waivers: malformed or short reasons are usage errors; a valid waiver on an unevaluable gate is recorded on the verdict", async () => {
    const malformed = await shipCommand(ctx(), { approver: "lead", waive: ["no colon here"] });
    assert.equal(malformed.status, "usage_error");
    assert.equal(malformed.diagnostics[0]?.code, "waiver_malformed");

    const short = await shipCommand(ctx(), { approver: "lead", waive: ["audit_chain_intact: short"] });
    assert.equal(short.diagnostics[0]?.code, "waiver_reason_too_short");

    const noOwner = await shipCommand(ctx(), { waive: ["audit_chain_intact: a reason that is long enough here"] });
    assert.equal(noOwner.diagnostics[0]?.code, "approver_required");

    // Raise the tier to R2 so independent_review is required and unevaluable at M1.
    const config = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
    config.defaultRiskTier = "R2";
    await writeFile(ws.paths.projectConfig, JSON.stringify(config, null, 2) + "\n", "utf8");
    // The config change invalidates approvals (config fingerprint); re-approve both.
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e "process.exit(0)"`] });

    const blocked = await shipCommand(ctx(), {});
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.gates.find((g) => g.gateId === "independent_review")?.status, "unevaluable");

    const waived = await shipCommand(ctx(), { approver: "lead", waive: ["independent_review: no reviewer exists before M3; release owner accepts"] });
    assert.equal(waived.status, "ready");
    const review = waived.gates.find((g) => g.gateId === "independent_review")!;
    assert.equal(review.status, "unevaluable");
    assert.equal(review.waiver?.waivedBy, "lead");
  });
});
