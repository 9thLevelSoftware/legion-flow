import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RunSchema, InterruptSchema, SCHEMA_VERSIONS } from "../dist/index.js";

const fp = "sha256:" + "d".repeat(64);
const now = new Date().toISOString();

describe("run union and interrupt routes", () => {
  test("a workflow run carries its graph fingerprint, durability, and the terminal statuses; a ship run is unchanged", () => {
    const wf = RunSchema.parse({
      schema: SCHEMA_VERSIONS.RUN,
      id: "run_wf",
      kind: "workflow",
      status: "awaiting_decision",
      workflowId: "demo",
      graphFingerprint: fp,
      durability: "sync",
      startedAt: now,
    });
    assert.equal(wf.kind, "workflow");
    assert.throws(() => RunSchema.parse({ ...wf, status: "ready" }));
    assert.throws(() => RunSchema.parse({ ...wf, fingerprints: { spec: fp, plan: fp, config: fp } }), "ship fields are not allowed on a workflow run");

    const ship = RunSchema.parse({
      schema: SCHEMA_VERSIONS.RUN,
      id: "run_sh",
      kind: "ship",
      status: "running",
      riskTier: "R1",
      fingerprints: { spec: fp, plan: fp, config: fp },
      requiredGates: [],
      startedAt: now,
    });
    assert.equal(ship.kind, "ship");
    assert.throws(() => RunSchema.parse({ ...ship, status: "awaiting_decision" }));
  });

  test("an interrupt may name its resume routes and records consumption", () => {
    const base = {
      schema: SCHEMA_VERSIONS.INTERRUPT,
      id: "int_abc",
      runId: "run_wf",
      stepSeq: 2,
      kind: "approve_action",
      action: { name: "fs.write", riskClass: "edit", argsFingerprint: fp },
      payloadRef: { path: "runs/run_wf/evidence/" + "0".repeat(64) + ".json", sha256: "0".repeat(64) },
      responseSchema: SCHEMA_VERSIONS.DECISION,
      requestedAt: now,
      expiresAt: now,
    };
    const plain = InterruptSchema.parse(base);
    assert.equal(plain.onTimeout, "cancel");
    assert.equal(plain.status, "pending");
    const routed = InterruptSchema.parse({ ...base, resume: { onApprove: "apply", onReject: "abandon" }, consumedAt: now });
    assert.equal(routed.resume?.onApprove, "apply");
    assert.throws(() => InterruptSchema.parse({ ...base, resume: { onReject: "x" } }), "onApprove is required when routes are given");
  });
});
