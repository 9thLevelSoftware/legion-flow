import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Interrupt, type Decision } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, effectiveInterruptStatus, newId, fingerprintRecord } from "../dist/index.js";
import { projectAtPlanReady } from "./fixture.ts";

const fp = "sha256:" + "e".repeat(64);
const t0 = new Date("2026-10-08T12:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

function interruptAt(runId: string, expiresAt: Date, extra: Partial<Interrupt> = {}): Interrupt {
  return {
    schema: SCHEMA_VERSIONS.INTERRUPT,
    id: newId("int"),
    runId,
    stepSeq: 1,
    kind: "approve_action",
    action: { name: "fs.write", riskClass: "edit", argsFingerprint: fingerprintRecord({ path: "a" }), policyVersion: "risk-policy/v1" },
    payloadRef: { path: `runs/${runId}/evidence/${"0".repeat(64)}.json`, sha256: "0".repeat(64) },
    responseSchema: SCHEMA_VERSIONS.DECISION,
    requestedAt: t0.toISOString(),
    expiresAt: expiresAt.toISOString(),
    onTimeout: "cancel",
    status: "pending",
    ...extra,
  };
}

const decisionFor = (interruptId: string, decision: Decision["decision"]): Decision => ({
  schema: SCHEMA_VERSIONS.DECISION,
  interruptId,
  expectedStatus: "pending",
  decision,
  editedArgs: null,
  note: "test",
  decidedBy: { id: "lead", displayName: "lead", kind: "human" },
  decidedAt: t0.toISOString(),
  source: "tty",
  idempotencyKey: "k",
});

describe("effective interrupt status (pure)", () => {
  test("decision wins over status; pending expires by the clock; other statuses stand", () => {
    const i = interruptAt("run_x", later(1000));
    assert.equal(effectiveInterruptStatus(i, null, t0), "pending");
    assert.equal(effectiveInterruptStatus(i, null, later(1000)), "expired");
    assert.equal(effectiveInterruptStatus(i, decisionFor(i.id, "approve"), later(5000)), "approved", "a decision recorded in time stands after expiry");
    assert.equal(effectiveInterruptStatus(i, decisionFor(i.id, "edit"), t0), "approved");
    assert.equal(effectiveInterruptStatus(i, decisionFor(i.id, "reject"), t0), "rejected");
    assert.equal(effectiveInterruptStatus({ ...i, status: "cancelled" }, null, t0), "cancelled");
  });
});

describe("interrupt and decision stores, and awaiting_decision in the phase ladder", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-interrupt-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("write, load (joined with decision), list, find across runs; status update after decision", async () => {
    const ws = await projectAtPlanReady(join(base, "store"));
    assert.equal((await ws.project.load(t0)).kind === "valid" && (await ws.project.load(t0) as { phase: string }).phase, "plan_ready");

    const { run } = await ws.lock.withLock(
      (held) => ws.runs.create({ kind: "workflow", workflowId: "demo", graphFingerprint: fp, durability: "sync" }, held),
      "test"
    );
    const interrupt = interruptAt(run.id, later(60_000));
    await ws.lock.withLock(async (held) => {
      await ws.interrupts.write(run.id, interrupt, held);
      await ws.runs.finish(run.id, { status: "awaiting_decision" }, held);
    }, "test");

    const found = await ws.interrupts.find(interrupt.id, t0);
    assert.equal(found?.runId, run.id);
    assert.equal(found?.effectiveStatus, "pending");
    assert.equal(found?.decision, null);

    const project = await ws.project.load(t0);
    assert.equal(project.kind === "valid" && project.phase, "awaiting_decision");
    assert.equal(project.kind === "valid" && project.pendingInterrupt?.interrupt.id, interrupt.id);

    // Decision first, status second: the decision is authority even before the status catches up.
    await ws.lock.withLock((held) => ws.decisions.write(run.id, decisionFor(interrupt.id, "approve"), held), "test");
    const decided = await ws.interrupts.load(run.id, interrupt.id, t0);
    assert.equal(decided?.interrupt.status, "pending");
    assert.equal(decided?.effectiveStatus, "approved");
    const afterDecision = await ws.project.load(t0);
    assert.equal(afterDecision.kind === "valid" && afterDecision.phase, "plan_ready");
    assert.equal(afterDecision.kind === "valid" && afterDecision.phaseReasons[0]?.code, "run_incomplete");

    await ws.lock.withLock((held) => ws.interrupts.update(run.id, interrupt.id, { status: "approved" }, held), "test");
    assert.equal((await ws.interrupts.list(run.id, t0))[0]?.interrupt.status, "approved");
    assert.equal(await ws.interrupts.find("int_nothing", t0), null);
  });

  test("an expired pending interrupt is reported as a reason, not as awaiting_decision", async () => {
    const ws = await projectAtPlanReady(join(base, "expired"));
    const { run } = await ws.lock.withLock(
      (held) => ws.runs.create({ kind: "workflow", workflowId: "demo", graphFingerprint: fp, durability: "sync" }, held),
      "test"
    );
    await ws.lock.withLock(async (held) => {
      await ws.interrupts.write(run.id, interruptAt(run.id, later(1000)), held);
      await ws.runs.finish(run.id, { status: "awaiting_decision" }, held);
    }, "test");
    const inTime = await ws.project.load(t0);
    assert.equal(inTime.kind === "valid" && inTime.phase, "awaiting_decision");
    const late = await ws.project.load(later(2000));
    assert.equal(late.kind === "valid" && late.phase, "plan_ready");
    assert.equal(late.kind === "valid" && late.phaseReasons[0]?.code, "interrupt_expired");
  });
});
