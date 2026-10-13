import { z } from "zod";

/**
 * The span attribute keys this project records. Pinned here as strings, never
 * imported from the semantic-conventions package, so a convention rename
 * cannot change a record. `gen_ai.usage.input_tokens` and `output_tokens` are
 * the current GenAI convention names; `gen_ai.usage.cost` is this project's own.
 * The exporter drops any key not listed here.
 */
export const SPAN_ATTRIBUTES = {
  RUN_ID: "legion.run.id",
  TASK_ID: "legion.task.id",
  SEQ: "legion.seq",
  NODE: "legion.node",
  EFFECT: "legion.effect",
  OUTCOME: "legion.outcome",
  OBSERVATION_TYPE: "legion.observation.type",
  AC_ID: "legion.ac.id",
  TREE_FINGERPRINT: "legion.tree.fingerprint",
  PROPOSAL_SHA256: "legion.proposal.sha256",
  ADAPTER_ID: "legion.adapter.id",
  WORKFLOW_ID: "legion.workflow.id",
  GEN_AI_MODEL: "gen_ai.request.model",
  GEN_AI_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  GEN_AI_COST: "gen_ai.usage.cost",
} as const;

export const SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(Object.values(SPAN_ATTRIBUTES));

export const OBSERVATION_TYPES = ["run", "step", "node", "adapter"] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Span names the engine emits; the step span is the processor's flush signal. */
export const SPAN_NAMES = {
  RUN: "legion.run",
  STEP: "legion.step",
  NODE_PREFIX: "legion.node.",
} as const;

/** One step's spans as an evidence record: OTLP-JSON `resourceSpans`, typed loosely so a later sink can re-read it. */
export const OtlpSpansEvidenceSchema = z.object({
  kind: z.literal("otlp_spans"),
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  /** The step this batch belongs to; `final` for the flush at run end. */
  seq: z.union([z.number().int().nonnegative(), z.literal("final")]),
  resourceSpans: z.array(z.record(z.string(), z.unknown())),
}).strict();

export type OtlpSpansEvidence = z.infer<typeof OtlpSpansEvidenceSchema>;
