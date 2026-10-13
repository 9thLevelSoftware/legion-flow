export const SCHEMA_VERSIONS = {
  PROJECT: "legion-flow-project/v1",
  STEP_SNAPSHOT: "legion-flow-step-snapshot/v1",
  INTERRUPT: "legion-flow-interrupt/v1",
  DECISION: "legion-flow-decision/v1",
  FILE_CONTRACT: "legion-flow-file-contract/v1",
  GATE_VERDICT: "legion-flow-gate-verdict/v1",
  RESULT: "legion-flow-result/v1",
  SPEC: "legion-flow-spec/v1",
  APPROVAL: "legion-flow-approval/v1",
  PLAN: "legion-flow-plan/v1",
  RUN: "legion-flow-run/v1",
  CHECK_EVIDENCE: "legion-flow-check-evidence/v1",
  RELEASE: "legion-flow-release/v1",
  PROPOSAL: "legion-flow-proposal/v1",
  INVALIDATION: "legion-flow-invalidation/v1",
  REVIEW_RECEIPT: "legion-flow-review-receipt/v1",
  GOLDEN_DATASET: "legion-flow-golden-dataset/v1",
  EPISODE: "legion-flow-episode/v1",
  MAP_QUERY: "legion-flow-map-query/v1",
  RECALL: "legion-flow-recall/v1",
  BROWSER_SCRIPT: "legion-flow-browser-script/v1",
  TOOL_PROBE: "legion-flow-tool-probe/v1",
  BUNDLE: "legion-flow-bundle/v1",
  SPEC_CHALLENGE: "legion-flow-spec-challenge/v1",
  HOOK_CONSENT: "legion-flow-hook-consent/v1",
} as const;

export type SchemaVersion = typeof SCHEMA_VERSIONS[keyof typeof SCHEMA_VERSIONS];

export const PHASE_VALUES = [
  "uninitialized",
  "initialized",
  "spec_draft",
  "spec_frozen",
  "planning",
  "plan_ready",
  "executing",
  "awaiting_decision",
  "reviewing",
  "ready_to_ship",
  "shipped",
  "abandoned",
] as const;

export type Phase = typeof PHASE_VALUES[number];

export const RISK_TIERS = ["R0", "R1", "R2", "R3"] as const;
export type RiskTier = typeof RISK_TIERS[number];

export const CONTROL_MODES = ["guarded", "advisory"] as const;
export type ControlMode = typeof CONTROL_MODES[number];
