import { z } from "zod";
import { BrowserCheckRecordSchema } from "./browser.js";
import { SCHEMA_VERSIONS, RISK_TIERS } from "./versions.js";
import { DecisionOwnerSchema } from "./project.js";
import { ReviewResultSchema } from "./review.js";
import { EvalResultSchema } from "./evals.js";
import { RunBroadcastSchema, RunMemberSchema } from "./coordinator.js";

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const RunFingerprintsSchema = z.object({
  spec: FingerprintSchema,
  plan: FingerprintSchema,
  config: FingerprintSchema,
}).strict();

const RunBase = {
  schema: z.literal(SCHEMA_VERSIONS.RUN),
  id: z.string().regex(/^run_[0-9a-z]+$/),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
};

/** A ship evaluation: gates against the current fingerprints. */
export const ShipRunSchema = z.object({
  ...RunBase,
  kind: z.literal("ship"),
  status: z.enum(["running", "complete"]),
  riskTier: z.enum(RISK_TIERS),
  fingerprints: RunFingerprintsSchema,
  requiredGates: z.array(z.string().min(1)),
  /** Set on completion: every required gate satisfied or waived. */
  ready: z.boolean().optional(),
}).strict();

export type ShipRun = z.infer<typeof ShipRunSchema>;

/** A workflow run driven by the engine: super-steps, snapshots, interrupts. M2's execute is a workflow run. */
export const WorkflowRunSchema = z.object({
  ...RunBase,
  kind: z.literal("workflow"),
  status: z.enum(["running", "awaiting_decision", "complete", "cancelled", "failed"]),
  workflowId: z.string().min(1),
  graphFingerprint: FingerprintSchema,
  durability: z.enum(["exit", "async", "sync"]),
  forkedFrom: z.object({ runId: z.string().regex(/^run_[0-9a-z]+$/), seq: z.number().int().nonnegative() }).strict().optional(),
  /** Why a run is cancelled or failed, or a completion that applied nothing; absent otherwise. */
  reason: z.string().min(1).optional(),
  /** The coordinator member that ran the task and why (M4 slice j1); resume reads it, never routes again. */
  member: RunMemberSchema.optional(),
  /** The step members of a coordinate task (M4 slice m), in order, so review counts every identity that wrote code. */
  coordinate: z.object({ steps: z.array(RunMemberSchema).min(1) }).strict().optional(),
  /** Set on the runs of a broadcast (M4 slice j2): its members never count as previous attempts. */
  broadcast: RunBroadcastSchema.optional(),
  /** Set when the run executes one plan task. */
  task: z.object({ planId: z.string().regex(/^pln_[0-9a-z]+$/), taskId: z.string().regex(/^T-[0-9]+$/) }).strict().optional(),
  /** Set when the task's proposal was applied to the real checkout. `sourceFingerprint` is the tree after apply. */
  applied: z.object({
    proposalSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceFingerprint: FingerprintSchema,
    appliedAt: z.string().datetime(),
    mode: z.enum(["auto", "decided"]),
  }).strict().optional(),
  /** Set on a review run (workflowId "review") by its verdict node. */
  review: ReviewResultSchema.optional(),
  /** Set on an eval run (workflowId "eval") by its last node. */
  eval: EvalResultSchema.optional(),
}).strict();

export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/**
 * A run: one evaluation or execution under `runs/run_<id>/`. Written with
 * status `running` at start and rewritten on finish, so a crash leaves an
 * honest, incomplete record that phase derivation treats as incomplete.
 */
export const RunSchema = z.discriminatedUnion("kind", [ShipRunSchema, WorkflowRunSchema]);

export type Run = z.infer<typeof RunSchema>;

/** One check execution, stored as a hashed evidence file. Metadata plus captured output; never a secret. */
export const CheckEvidenceSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.CHECK_EVIDENCE),
  check: z.string().min(1),
  argv: z.array(z.string()),
  cwd: z.string().min(1),
  source: z.enum(["task", "receipt", "eval"]),
  taskId: z.string().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  spawnError: z.string().optional(),
  /** Windows: the command resolved to a .cmd/.bat shim and ran through cmd.exe with our own quoting. */
  viaCmdShim: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  /** For a browser: check (M4 slice e): the steps, screenshots, and blocked requests. */
  browser: BrowserCheckRecordSchema.optional(),
}).strict();

export type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;

export const EvidenceIndexEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  producedBy: z.string().min(1),
}).strict();

export type EvidenceIndexEntry = z.infer<typeof EvidenceIndexEntrySchema>;

/** The human commit of a ready evaluation. Content-bound like an approval; a later edit stops it matching. */
export const ReleaseSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.RELEASE),
  id: z.string().regex(/^rel_[0-9a-z]+$/),
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  fingerprints: RunFingerprintsSchema,
  decidedBy: DecisionOwnerSchema,
  decidedAt: z.string().datetime(),
  source: z.enum(["tty", "piped"]),
  idempotencyKey: z.string().min(1),
}).strict();

export type Release = z.infer<typeof ReleaseSchema>;

/**
 * Written on a parent run when a fork starts from one of its snapshots. Only an
 * edited fork invalidates: complete ship evaluations started after the parent's
 * apply and before this record no longer rest on the world that was applied.
 */
export const InvalidationSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.INVALIDATION),
  parentRunId: z.string().regex(/^run_[0-9a-z]+$/),
  forkedTo: z.string().regex(/^run_[0-9a-z]+$/),
  fromSeq: z.number().int().nonnegative(),
  edited: z.boolean(),
  at: z.string().datetime(),
}).strict();

export type Invalidation = z.infer<typeof InvalidationSchema>;
