import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RunSchema, CheckEvidenceSchema, ReleaseSchema, GateVerdictSchema, SCHEMA_VERSIONS } from "../dist/index.js";

const fp = "sha256:" + "c".repeat(64);
const now = new Date().toISOString();

describe("run, evidence, release, and verdict schemas", () => {
  test("a run starts running and completes with ready; status is a closed enum", () => {
    const run = RunSchema.parse({
      schema: SCHEMA_VERSIONS.RUN,
      id: "run_abc",
      kind: "ship",
      status: "running",
      riskTier: "R1",
      fingerprints: { spec: fp, plan: fp, config: fp },
      requiredGates: ["approved_spec"],
      startedAt: now,
    });
    assert.equal(run.ready, undefined);
    assert.throws(() => RunSchema.parse({ ...run, status: "crashed" }));
    assert.throws(() => RunSchema.parse({ ...run, kind: "execute" }), "execute arrives in M2");
  });

  test("check evidence is strict and records the shim path and truncation", () => {
    const ev = CheckEvidenceSchema.parse({
      schema: SCHEMA_VERSIONS.CHECK_EVIDENCE,
      check: "node --test",
      argv: ["node", "--test"],
      cwd: "/w",
      source: "receipt",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      signal: null,
      timedOut: false,
      viaCmdShim: false,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    assert.equal(ev.exitCode, 0);
    assert.throws(() => CheckEvidenceSchema.parse({ ...ev, secret: "x" }));
  });

  test("a release binds fingerprints to a human and a run", () => {
    const rel = ReleaseSchema.parse({
      schema: SCHEMA_VERSIONS.RELEASE,
      id: "rel_abc",
      runId: "run_abc",
      fingerprints: { spec: fp, plan: fp, config: fp },
      decidedBy: { id: "lead", displayName: "Lead", kind: "human" },
      decidedAt: now,
      source: "tty",
      idempotencyKey: "k",
    });
    assert.equal(rel.runId, "run_abc");
    assert.throws(() => ReleaseSchema.parse({ ...rel, decidedBy: { ...rel.decidedBy, kind: "agent" } }));
  });

  test("a verdict no longer requires a source fingerprint, keeps waiver nullable and reason >= 24", () => {
    const verdict = GateVerdictSchema.parse({
      schema: SCHEMA_VERSIONS.GATE_VERDICT,
      gateId: "approved_spec",
      riskTier: "R1",
      acceptanceIds: ["AC-01"],
      status: "unevaluable",
      reason: "no receipt",
      evidence: [],
      judge: null,
      inputs: { specFingerprint: fp, planFingerprint: fp },
      evaluatedAt: now,
      waiver: { reason: "Accepted by the release owner after review", waivedBy: "lead", waivedAt: now },
    });
    assert.equal(verdict.inputs.sourceFingerprint, undefined);
    assert.throws(() => GateVerdictSchema.parse({ ...verdict, waiver: { reason: "too short", waivedBy: "lead", waivedAt: now } }));
  });
});
