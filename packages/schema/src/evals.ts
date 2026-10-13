import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { ReviewFingerprintsSchema } from "./review.js";

const Fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const SCORERS = ["exact", "contains", "regex", "exit_code", "judge"] as const;
export type ScorerKind = (typeof SCORERS)[number];

/** Rubrics are data: steps the judge follows and optional score buckets with the outcome each means. */
export const RubricSchema = z.object({
  steps: z.array(z.string().min(1)).min(1),
  buckets: z.array(z.object({ range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]), expectedOutcome: z.string().min(1) }).strict()).default([]),
}).strict();

export const EvalMetricSchema = z.object({
  metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
  scorer: z.enum(SCORERS),
  threshold: z.number().min(0).max(1),
  rubric: RubricSchema.optional(),
}).strict();
export type EvalMetric = z.infer<typeof EvalMetricSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  acceptanceIds: z.array(z.string().regex(/^AC-[0-9]+$/)).default([]),
  /** The task function: a frozen argv, run without a shell in a disposable copy of the checkout. */
  argv: z.string().min(1),
  /** Context for a judge (what the case asks); never executed. */
  input: z.string().optional(),
  repeat: z.number().int().min(1).max(20).default(1),
  expected: z.object({
    stdout: z.string().optional(),
    contains: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    exitCode: z.number().int().optional(),
  }).strict().default({}),
  metrics: z.array(EvalMetricSchema).min(1),
}).strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** One version of a golden dataset. Every change is a new version; archiving replaces deletion. */
export const GoldenDatasetSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.GOLDEN_DATASET),
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  version: z.number().int().min(1),
  archived: z.boolean().default(false),
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema),
}).strict();
export type GoldenDataset = z.infer<typeof GoldenDatasetSchema>;

export const MetricResultSchema = z.object({
  metric: z.string().min(1),
  scorer: z.enum(SCORERS),
  threshold: z.number(),
  scores: z.array(z.number().min(0).max(1).nullable()),
  reasons: z.array(z.string()),
  /** SHA-256 of each judge prompt, null for deterministic scorers. */
  promptHashes: z.array(z.string().nullable()),
  mean: z.number().nullable(),
  status: z.enum(["pass", "fail", "unevaluable"]),
}).strict();
export type MetricResult = z.infer<typeof MetricResultSchema>;

/** What an eval run concluded; written on the run by its last node. */
export const EvalResultSchema = z.object({
  datasetId: z.string().min(1),
  version: z.number().int().min(1),
  datasetFingerprint: Fingerprint,
  fingerprints: ReviewFingerprintsSchema,
  sourceFingerprint: Fingerprint,
  acceptanceIds: z.array(z.string()),
  /** `judge:<model>` when any metric used the judge scorer. */
  judge: z.string().optional(),
  distinctFromExecutor: z.boolean(),
  waiver: z.object({ reason: z.string().min(24), waivedBy: z.string().min(1) }).strict().optional(),
  passed: z.boolean(),
  unevaluable: z.boolean(),
  reason: z.string().min(1),
  cases: z.array(z.object({ id: z.string(), metrics: z.array(MetricResultSchema) }).strict()),
}).strict();
export type EvalResult = z.infer<typeof EvalResultSchema>;
