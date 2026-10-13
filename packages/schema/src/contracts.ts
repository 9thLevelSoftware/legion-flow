import { z } from "zod";
import { SCHEMA_VERSIONS, RISK_TIERS } from "./versions.js";

export const FileContractSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.FILE_CONTRACT).default(SCHEMA_VERSIONS.FILE_CONTRACT),
  filesAllowed: z.array(z.string().min(1)),
  filesForbidden: z.array(z.string().min(1)).default([]),
  expectedArtifacts: z.array(z.string().min(1)).default([]),
  verificationCommands: z.array(z.string().min(1)), // Frozen argv checks
  maxFilesTouched: z.number().int().positive().default(20),
}).strict();

export type FileContract = z.infer<typeof FileContractSchema>;

export const VerificationSurfaceSchema = z.enum([
  "unit",
  "integration",
  "real_interface",
  "end_to_end",
]);

export type VerificationSurface = z.infer<typeof VerificationSurfaceSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-[0-9]+$/),
  statement: z.string().min(1),
  kind: z.enum(["behavior", "test", "rubric"]),
  surface: VerificationSurfaceSchema.default("unit"),
  priority: z.enum(["P0", "P1", "P2"]).default("P1"),
}).strict();

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const GateStatusSchema = z.enum(["satisfied", "unsatisfied", "unevaluable"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateVerdictSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.GATE_VERDICT),
  gateId: z.string().min(1),
  riskTier: z.enum(RISK_TIERS),
  acceptanceIds: z.array(z.string().regex(/^AC-[0-9]+$/)),
  status: GateStatusSchema,
  reason: z.string().min(1),
  evidence: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()),
  judge: z.object({
    model: z.string().min(1),
    role: z.literal("judge"),
    distinctFromExecutor: z.boolean(),
  }).strict().nullable(),
  inputs: z.object({
    specFingerprint: z.string().min(1),
    planFingerprint: z.string().min(1),
    /** The whole-repository fingerprint. Absent until M2's execute computes it; never fabricated. */
    sourceFingerprint: z.string().min(1).optional(),
    goldenDatasetVersion: z.string().optional(),
  }).strict(),
  evaluatedAt: z.string().datetime(),
  waiver: z.object({
    reason: z.string().min(24), // Must be a substantive justification (at least 24 chars)
    waivedBy: z.string().min(1),
    waivedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict();

export type GateVerdict = z.infer<typeof GateVerdictSchema>;
