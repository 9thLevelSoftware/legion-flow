import { z } from "zod";
import { SCHEMA_VERSIONS, type RiskTier } from "./versions.js";
import { DecisionOwnerSchema } from "./project.js";

const Fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Gates required at each tier. Data, so phase derivation (persist) and evaluation (gates) read one table. */
export const TIER_GATES: Record<RiskTier, readonly string[]> = {
  R0: ["approved_spec", "approved_plan", "deterministic_verification"],
  R1: ["approved_spec", "approved_plan", "deterministic_verification", "acceptance_coverage", "audit_chain_intact"],
  R2: ["approved_spec", "approved_plan", "deterministic_verification", "acceptance_coverage", "audit_chain_intact", "independent_review"],
  R3: ["approved_spec", "approved_plan", "deterministic_verification", "acceptance_coverage", "audit_chain_intact", "independent_review", "eval_goldens"],
};

/** The gate that exists only when the project declares architecture rules: then it is required at every tier. */
export const ARCHITECTURE_GATE = "architecture_conformance";

export function requiredGates(tier: RiskTier, options: { architectureRules?: boolean } = {}): readonly string[] {
  return options.architectureRules ? [...TIER_GATES[tier], ARCHITECTURE_GATE] : TIER_GATES[tier];
}

/** Who produced a judgement: an adapter id and a model, where an unset model is `vendor-default:<adapter>`. */
export const AgentIdentitySchema = z.object({ adapter: z.string().min(1), model: z.string().min(1) }).strict();
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const ReviewFingerprintsSchema = z.object({ spec: Fingerprint, plan: Fingerprint, config: Fingerprint }).strict();

/** What a review run concluded; written on the run by its last node. */
export const ReviewResultSchema = z.object({
  fingerprints: ReviewFingerprintsSchema,
  /** The checkout the reviewer saw, listed in its own tree mode. */
  sourceFingerprint: Fingerprint,
  treeMode: z.enum(["fs", "git"]),
  reviewer: AgentIdentitySchema,
  executor: AgentIdentitySchema,
  /** False only when the reviewer equals the executor and a decision owner waived that at review time. */
  independent: z.boolean(),
  verdict: z.enum(["PASS", "FAIL"]),
  reason: z.string().min(1),
  notesSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  waiver: z.object({ reason: z.string().min(24), waivedBy: z.string().min(1) }).strict().optional(),
}).strict();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** A decision owner's content-bound acceptance of a PASS review. A later change to any fingerprint stops it matching. */
export const ReviewReceiptSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.REVIEW_RECEIPT),
  id: z.string().regex(/^rvw_[0-9a-z]+$/),
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  fingerprints: ReviewFingerprintsSchema,
  sourceFingerprint: Fingerprint,
  treeMode: z.enum(["fs", "git"]),
  reviewer: AgentIdentitySchema,
  independent: z.boolean(),
  decidedBy: DecisionOwnerSchema,
  decidedAt: z.string().datetime(),
  source: z.enum(["tty", "piped"]),
  idempotencyKey: z.string().min(1),
}).strict();
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
