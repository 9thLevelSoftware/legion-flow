import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ProjectConfigSchema,
  StepSnapshotSchema,
  InterruptSchema,
  DecisionSchema,
  FileContractSchema,
  GateVerdictSchema,
  ResultEnvelopeSchema,
  SCHEMA_VERSIONS,
} from "../dist/index.js";

describe("Schema Package Validation", () => {
  test("ProjectConfigSchema validates valid project and rejects invalid apiKey", () => {
    const valid = {
      schema: SCHEMA_VERSIONS.PROJECT,
      id: "prj_test",
      name: "Test Project",
      decisionOwners: [{ id: "usr_lead", displayName: "Lead Engineer", kind: "human" as const }],
      riskPolicyVersion: "risk-policy/v1",
      defaultRiskTier: "R1" as const,
      controlMode: "guarded" as const,
      adapter: {
        default: "claude",
        http: {
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
      },
      createdAt: new Date().toISOString(),
    };
    assert.doesNotThrow(() => ProjectConfigSchema.parse(valid));

    // Must refuse inline apiKey
    const invalidApiKey = {
      ...valid,
      adapter: {
        default: "claude",
        http: {
          apiKey: "sk-12345", // FORBIDDEN!
        },
      },
    };
    assert.throws(() => ProjectConfigSchema.parse(invalidApiKey));
  });

  test("StepSnapshotSchema validates super-step snapshots", () => {
    const valid = {
      schema: SCHEMA_VERSIONS.STEP_SNAPSHOT,
      runId: "run_01JXYZ",
      seq: 1,
      parentSeq: null,
      namespace: "",
      source: "loop" as const,
      values: { currentBranch: "main" },
      next: ["build"],
      tasks: [
        {
          id: "tsk_01",
          name: "compile",
          interrupts: [],
          error: null,
        },
      ],
      graphFingerprint: "sha256:" + "a".repeat(64),
      durability: "sync" as const,
      createdAt: new Date().toISOString(),
    };
    assert.doesNotThrow(() => StepSnapshotSchema.parse(valid));
  });

  test("Interrupt and Decision schemas enforce compare-and-set and human-only fields", () => {
    const interrupt = {
      schema: SCHEMA_VERSIONS.INTERRUPT,
      id: "int_01JABC",
      runId: "run_01JXYZ",
      stepSeq: 2,
      kind: "approve_action" as const,
      action: {
        name: "fs.write",
        riskClass: "edit" as const,
        argsFingerprint: "sha256:" + "b".repeat(64),
        policyVersion: "risk-policy/v1",
      },
      payloadRef: {
        path: "evidence/diff.jsonl",
        sha256: "c".repeat(64),
      },
      responseSchema: SCHEMA_VERSIONS.DECISION,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      onTimeout: "cancel" as const,
      status: "pending" as const,
    };
    assert.doesNotThrow(() => InterruptSchema.parse(interrupt));

    const decision = {
      schema: SCHEMA_VERSIONS.DECISION,
      interruptId: "int_01JABC",
      expectedStatus: "pending" as const,
      decision: "approve" as const,
      editedArgs: null,
      note: "Approved by project lead",
      decidedBy: {
        id: "usr_lead",
        displayName: "Lead Engineer",
        kind: "human" as const,
      },
      decidedAt: new Date().toISOString(),
      source: "tty" as const,
      idempotencyKey: "run_01:int_01:decide:sha256:...",
    };
    assert.doesNotThrow(() => DecisionSchema.parse(decision));

    // Refuses if decidedBy.kind is not 'human'
    const agentDecision = {
      ...decision,
      decidedBy: {
        id: "bot_1",
        displayName: "Autonomous Agent",
        kind: "agent",
      },
    };
    assert.throws(() => DecisionSchema.parse(agentDecision));
  });

  test("GateVerdictSchema enforces tri-state and minimum waiver reason length", () => {
    const verdict = {
      schema: SCHEMA_VERSIONS.GATE_VERDICT,
      gateId: "deterministic_verification",
      riskTier: "R2" as const,
      acceptanceIds: ["AC-01"],
      status: "satisfied" as const,
      reason: "All tests passed",
      evidence: [
        {
          path: "evidence/test.log",
          sha256: "d".repeat(64),
        },
      ],
      judge: null,
      inputs: {
        specFingerprint: "spec-hash",
        planFingerprint: "plan-hash",
        sourceFingerprint: "src-hash",
      },
      evaluatedAt: new Date().toISOString(),
      waiver: null,
    };
    assert.doesNotThrow(() => GateVerdictSchema.parse(verdict));

    // Refuses waiver reason shorter than 24 chars
    const shortWaiver = {
      ...verdict,
      waiver: {
        reason: "too short", // Less than 24 chars!
        waivedBy: "usr_lead",
        waivedAt: new Date().toISOString(),
      },
    };
    assert.throws(() => GateVerdictSchema.parse(shortWaiver));
  });

  test("ResultEnvelopeSchema validates JSON outputs and structured nextAction", () => {
    const result = {
      schema: SCHEMA_VERSIONS.RESULT,
      command: "execute",
      runId: "run_01JXYZ",
      status: "awaiting_decision" as const,
      phase: "executing" as const,
      diagnostics: [],
      gates: [],
      nextAction: {
        type: "human_decision" as const,
        interruptId: "int_01JABC",
        decisionKind: "approve_action",
        run: "legion-flow decide int_01JABC --approve",
        responseSchema: SCHEMA_VERSIONS.DECISION,
      },
    };
    assert.doesNotThrow(() => ResultEnvelopeSchema.parse(result));
  });
});
