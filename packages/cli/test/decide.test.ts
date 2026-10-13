import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Interrupt } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, newId, fingerprintRecord } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, statusCommand, specCommand, planCommand, approveCommand, decideCommand } from "../dist/index.js";
import { ResultEnvelopeSchema, DecisionSchema } from "@9thlevelsoftware/legion-flow-schema";

// Anchored to the real clock because status reads it; decide calls pass `now` explicitly.
const t0 = new Date();
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("decide (M1 slice d)", () => {
  let root: string;
  let ws: Workspace;
  let interrupt: Interrupt;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-decide-cli-"));
    ws = Workspace.at(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  const node = `"${process.execPath}"`;

  async function toPlanReady() {
    await initCommand(ctx(), { adapter: "fake", name: "D", owner: "lead" });
    const created = await specCommand(ctx(), { new: "Flow" });
    const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
    const spec = JSON.parse(await readFile(specJson, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "ok", kind: "behavior" }];
    await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    const plan = await planCommand(ctx(), { new: true });
    const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks = [{ id: "T-01", title: "t", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
    await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
    await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  }

  /** The engine is not a CLI dependency at M1, so the interrupt is written through the stores. */
  async function pendingInterrupt(expiresInMs: number): Promise<{ runId: string; interrupt: Interrupt }> {
    return ws.lock.withLock(async (held) => {
      const { run } = await ws.runs.create({ kind: "workflow", workflowId: "demo", graphFingerprint: "sha256:" + "a".repeat(64), durability: "sync" }, held);
      const ev = await ws.runs.writeEvidence(run.id, { diff: "+1" }, held);
      const i: Interrupt = {
        schema: SCHEMA_VERSIONS.INTERRUPT,
        id: newId("int"),
        runId: run.id,
        stepSeq: 1,
        kind: "approve_action",
        action: { name: "fs.write", riskClass: "edit", argsFingerprint: fingerprintRecord({ path: "src/a.ts" }), policyVersion: "risk-policy/v1" },
        payloadRef: { path: ev.path, sha256: ev.sha256 },
        responseSchema: SCHEMA_VERSIONS.DECISION,
        requestedAt: t0.toISOString(),
        expiresAt: later(expiresInMs).toISOString(),
        onTimeout: "cancel",
        status: "pending",
        resume: { onApprove: "apply", onReject: "abandon" },
      };
      await ws.interrupts.write(run.id, i, held);
      await ws.runs.finish(run.id, { status: "awaiting_decision" }, held);
      return { runId: run.id, interrupt: i };
    }, "test");
  }

  test("status reports awaiting_decision with a human_decision next action naming the interrupt", async () => {
    await toPlanReady();
    ({ interrupt } = await pendingInterrupt(60_000));
    const status = await statusCommand(ctx(), {});
    ResultEnvelopeSchema.parse(status);
    assert.equal(status.status, "awaiting_decision");
    assert.equal(status.phase, "awaiting_decision");
    assert.equal(status.nextAction.type, "human_decision");
    if (status.nextAction.type !== "human_decision") return;
    assert.equal(status.nextAction.interruptId, interrupt.id);
    assert.equal(status.nextAction.decisionKind, "approve_action");
    assert.match(status.nextAction.run, new RegExp(`decide ${interrupt.id}`));
    assert.equal(status.nextAction.payloadRef?.sha256, interrupt.payloadRef.sha256);
  });

  test("usage errors: no decision, two decisions, edit that is not an object; refusals: non-owner, unknown interrupt", async () => {
    const none = await decideCommand(ctx(), { interruptId: interrupt.id, approver: "lead", now: t0 });
    assert.equal(none.status, "usage_error");
    assert.equal(none.diagnostics[0]?.code, "decision_required");
    const two = await decideCommand(ctx(), { interruptId: interrupt.id, approve: true, reject: true, approver: "lead", now: t0 });
    assert.equal(two.diagnostics[0]?.code, "decision_ambiguous");
    const badEdit = await decideCommand(ctx(), { interruptId: interrupt.id, edit: "[1,2]", approver: "lead", now: t0 });
    assert.equal(badEdit.diagnostics[0]?.code, "edit_not_object");

    const stranger = await decideCommand(ctx(), { interruptId: interrupt.id, approve: true, approver: "nobody", now: t0 });
    assert.equal(stranger.status, "refused");
    assert.equal(stranger.diagnostics[0]?.code, "approver_not_decision_owner");
    const unknown = await decideCommand(ctx(), { interruptId: "int_nothing", approve: true, approver: "lead", now: t0 });
    assert.equal(unknown.diagnostics[0]?.code, "interrupt_not_found");
  });

  test("an owner's --edit decision is recorded (decision file, status, audit), is idempotent, and a different decision afterwards is refused", async () => {
    const chainBefore = (await ws.audit.verify()).verifiedCount;
    const decided = await decideCommand(ctx(true), { interruptId: interrupt.id, edit: '{"path":"src/b.ts"}', approver: "lead", note: "narrower path", now: t0 });
    ResultEnvelopeSchema.parse(decided);
    assert.equal(decided.status, "ok");
    assert.equal(decided.phase, "plan_ready", "no pending interrupt remains");
    const decisionPath = decided.diagnostics.find((d) => d.code === "decision_recorded")!.path!;
    const record = DecisionSchema.parse(JSON.parse(await readFile(decisionPath, "utf8")));
    assert.equal(record.decision, "edit");
    assert.deepEqual(record.editedArgs, { path: "src/b.ts" });
    assert.equal(record.note, "narrower path");
    assert.equal(record.source, "tty");
    assert.equal(record.expectedStatus, "pending");
    assert.equal((await ws.interrupts.find(interrupt.id, t0))?.interrupt.status, "approved");
    assert.equal((await ws.audit.verify()).verifiedCount, chainBefore + 1);

    const again = await decideCommand(ctx(), { interruptId: interrupt.id, edit: '{"path":"src/b.ts"}', approver: "lead", now: t0 });
    assert.equal(again.status, "ok");
    assert.equal(again.diagnostics[0]?.code, "decision_unchanged");
    const flip = await decideCommand(ctx(), { interruptId: interrupt.id, reject: true, approver: "lead", now: t0 });
    assert.equal(flip.status, "refused");
    assert.equal(flip.diagnostics[0]?.code, "interrupt_not_pending");
    assert.equal((await ws.audit.verify()).verifiedCount, chainBefore + 1, "no second audit event");
  });

  test("an expired interrupt is refused, marked expired, and audited; the run's onTimeout applies on resume", async () => {
    const { interrupt: short } = await pendingInterrupt(1000);
    const late = await decideCommand(ctx(), { interruptId: short.id, approve: true, approver: "lead", now: later(5000) });
    assert.equal(late.status, "refused");
    assert.equal(late.diagnostics[0]?.code, "interrupt_expired");
    assert.match(late.diagnostics[0]?.message ?? "", /onTimeout is 'cancel'/);
    assert.equal((await ws.interrupts.find(short.id, later(5000)))?.interrupt.status, "expired");
    const status = await statusCommand(ctx(), {});
    assert.equal(status.phase, "plan_ready");
    assert.ok(status.diagnostics.some((d) => d.code === "run_incomplete" || d.code === "interrupt_expired"));
  });
});
