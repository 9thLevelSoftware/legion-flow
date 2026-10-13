import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateVerdictSchema } from "@9thlevelsoftware/legion-flow-schema";
import { evaluateShip, parseWaiver, requiredGates, TIER_GATES, GATE_CATALOG } from "../dist/index.js";
import { projectWithApprovedPlan } from "./fixture.ts";

describe("tier policy and waivers", () => {
  test("tiers only add gates; every required gate exists in the catalog", () => {
    const ids = new Set(GATE_CATALOG.map((g) => g.id));
    let previous: readonly string[] = [];
    for (const tier of ["R0", "R1", "R2", "R3"] as const) {
      const gates = requiredGates(tier);
      for (const g of previous) assert.ok(gates.includes(g), `${tier} dropped ${g}`);
      for (const g of gates) assert.ok(ids.has(g), `${g} not in catalog`);
      previous = gates;
    }
    assert.deepEqual(TIER_GATES.R0, ["approved_spec", "approved_plan", "deterministic_verification"]);
  });

  test("parseWaiver: malformed, unknown, not required at tier, short reason, ok", () => {
    assert.equal(parseWaiver("nonsense", "R1").ok, false);
    assert.equal((parseWaiver("ghost_gate: a reason long enough to count", "R1") as { code: string }).code, "waiver_unknown_gate");
    assert.equal((parseWaiver("independent_review: a reason long enough to count", "R1") as { code: string }).code, "waiver_gate_not_required");
    assert.equal((parseWaiver("audit_chain_intact: short", "R1") as { code: string }).code, "waiver_reason_too_short");
    const ok = parseWaiver("independent_review: reviewer unavailable, accepted by the release owner", "R2");
    assert.deepEqual(ok, { ok: true, gateId: "independent_review", reason: "reviewer unavailable, accepted by the release owner" });
  });
});

describe("ship evaluation", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-gates-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const node = `"${process.execPath}"`;

  test("R1 with passing checks: every gate satisfied, run complete and ready, evidence indexed and content-addressed", async () => {
    const { ws } = await projectWithApprovedPlan(join(base, "pass"), { taskChecks: [`${node} -e "process.exit(0)"`] });
    const result = await ws.lock.withLock((held) => evaluateShip(ws, held, { timeoutMs: 30_000 }), "test");
    assert.equal(result.kind, "evaluated");
    if (result.kind !== "evaluated") return;
    const ev = result.evaluation;
    assert.equal(ev.tier, "R1");
    assert.equal(ev.ready, true);
    assert.deepEqual(ev.verdicts.map((v) => [v.gateId, v.status]), [
      ["approved_spec", "satisfied"],
      ["approved_plan", "satisfied"],
      ["deterministic_verification", "satisfied"],
      ["acceptance_coverage", "satisfied"],
      ["audit_chain_intact", "satisfied"],
    ]);
    for (const v of ev.verdicts) GateVerdictSchema.parse(v);
    const verification = ev.verdicts.find((v) => v.gateId === "deterministic_verification")!;
    assert.equal(verification.evidence.length, 2, "one task check + one receipt check");
    assert.deepEqual(verification.acceptanceIds, ["AC-01", "AC-02"]);

    const loaded = await ws.runs.load(ev.runId);
    assert.equal(loaded?.run.status, "complete");
    assert.equal(loaded?.run.ready, true);
    assert.equal(loaded?.verdicts.length, 5);
    assert.equal((await ws.runs.verifyEvidence(loaded!)).ok, true);
    assert.equal((await readdir(join(ev.runDir, "evidence"))).length, 2);

    const project = await ws.project.load();
    assert.equal(project.kind === "valid" && project.phase, "ready_to_ship");
  });

  test("a failing check is unsatisfied and blocks; a missing binary is unevaluable", async () => {
    const { ws } = await projectWithApprovedPlan(join(base, "fail"), { taskChecks: [`${node} -e "process.exit(2)"`] });
    const r1 = await ws.lock.withLock((held) => evaluateShip(ws, held, { timeoutMs: 30_000 }), "test");
    if (r1.kind !== "evaluated") assert.fail();
    const v1 = r1.evaluation.verdicts.find((v) => v.gateId === "deterministic_verification")!;
    assert.equal(v1.status, "unsatisfied");
    assert.match(v1.reason, /exit 2/);
    assert.equal(r1.evaluation.ready, false);
    const p1 = await ws.project.load();
    assert.equal(p1.kind === "valid" && p1.phase, "plan_ready");
    assert.equal(p1.kind === "valid" && p1.phaseReasons[0]?.code, "ship_blocked");

    const { ws: ws2 } = await projectWithApprovedPlan(join(base, "missing"), { receiptChecks: ["no-such-binary-abc --run"] });
    const r2 = await ws2.lock.withLock((held) => evaluateShip(ws2, held, { timeoutMs: 30_000 }), "test");
    if (r2.kind !== "evaluated") assert.fail();
    assert.equal(r2.evaluation.verdicts.find((v) => v.gateId === "deterministic_verification")?.status, "unevaluable");
  });

  test("R2 requires independent_review, which is unevaluable with no review run; a waiver keeps the status and makes it ready", async () => {
    const { ws } = await projectWithApprovedPlan(join(base, "r2"), { tier: "R2" });
    const blocked = await ws.lock.withLock((held) => evaluateShip(ws, held, { timeoutMs: 30_000 }), "test");
    if (blocked.kind !== "evaluated") assert.fail();
    const review = blocked.evaluation.verdicts.find((v) => v.gateId === "independent_review")!;
    assert.equal(review.status, "unevaluable");
    assert.match(review.reason, /no review run exists/);
    assert.equal(blocked.evaluation.ready, false);

    const waived = await ws.lock.withLock(
      (held) =>
        evaluateShip(ws, held, {
          timeoutMs: 30_000,
          waivers: [
            { gateId: "independent_review", reason: "no reviewer exists yet; release owner accepts", waivedBy: "lead" },
            { gateId: "approved_spec", reason: "unused because the gate is satisfied anyway", waivedBy: "lead" },
          ],
        }),
      "test"
    );
    if (waived.kind !== "evaluated") assert.fail();
    const w = waived.evaluation.verdicts.find((v) => v.gateId === "independent_review")!;
    assert.equal(w.status, "unevaluable", "a waiver never flips the status");
    assert.equal(w.waiver?.waivedBy, "lead");
    assert.equal(waived.evaluation.ready, true);
    assert.deepEqual(waived.evaluation.unusedWaivers.map((u) => u.gateId), ["approved_spec"]);
  });

  test("uncovered criteria: R1 blocks on acceptance_coverage, R0 does not require it", async () => {
    const { ws } = await projectWithApprovedPlan(join(base, "cover"), { coverAll: false });
    const r1 = await ws.lock.withLock((held) => evaluateShip(ws, held, { timeoutMs: 30_000 }), "test");
    if (r1.kind !== "evaluated") assert.fail();
    const cov = r1.evaluation.verdicts.find((v) => v.gateId === "acceptance_coverage")!;
    assert.equal(cov.status, "unsatisfied");
    assert.deepEqual(cov.acceptanceIds, ["AC-02"]);
    assert.equal(r1.evaluation.ready, false);

    const r0 = await ws.lock.withLock((held) => evaluateShip(ws, held, { tier: "R0", timeoutMs: 30_000 }), "test");
    if (r0.kind !== "evaluated") assert.fail();
    assert.equal(r0.evaluation.ready, true);
    assert.equal(r0.evaluation.verdicts.length, 3);
  });

  test("plan not approved: approved_plan unsatisfied and verification unevaluable; evidence drift after a ready run drops readiness", async () => {
    const { ws, plan } = await projectWithApprovedPlan(join(base, "drift"));
    const planJson = join(plan.dir, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks[0].title = "edited after approval";
    await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");

    const r = await ws.lock.withLock((held) => evaluateShip(ws, held, { timeoutMs: 30_000 }), "test");
    if (r.kind !== "evaluated") assert.fail();
    const byId = Object.fromEntries(r.evaluation.verdicts.map((v) => [v.gateId, v.status]));
    assert.equal(byId["approved_spec"], "satisfied");
    assert.equal(byId["approved_plan"], "unsatisfied");
    assert.equal(byId["deterministic_verification"], "unevaluable");

    const { ws: ws2 } = await projectWithApprovedPlan(join(base, "drift2"));
    const ok = await ws2.lock.withLock((held) => evaluateShip(ws2, held, { timeoutMs: 30_000 }), "test");
    if (ok.kind !== "evaluated") assert.fail();
    assert.equal((await ws2.project.load() as { phase: string }).phase, "ready_to_ship");
    const index = JSON.parse(await readFile(join(ok.evaluation.runDir, "evidence-index.json"), "utf8")) as { path: string }[];
    const target = index.find((e) => e.path.includes("/evidence/"))!;
    await writeFile(join(ws2.paths.project, ...target.path.split("/")), "{}\n", "utf8");
    const after = await ws2.project.load();
    assert.equal(after.kind === "valid" && after.phase, "plan_ready");
    assert.equal(after.kind === "valid" && after.phaseReasons[0]?.code, "ship_evidence_drift");
  });

  test("nothing to ship without a current plan", async () => {
    const root = join(base, "noplan");
    const { Workspace } = await import("@9thlevelsoftware/legion-flow-persist");
    const ws = Workspace.at(root);
    await ws.lock.withLock((held) => ws.project.create({ name: "N", adapterId: "fake", ownerId: "lead" }, held), "test");
    const r = await ws.lock.withLock((held) => evaluateShip(ws, held), "test");
    assert.equal(r.kind, "nothing_to_ship");
    assert.equal((r as { code: string }).code, "no_current_spec");
  });
});
