import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { GateStatusSchema } from "./contracts.js";
import { ProposalArchitectureSchema, ProposalImpactSchema } from "./map.js";

const TreeFingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Hex = z.string().regex(/^[0-9a-f]{64}$/);

const EvidenceRefSchema = z.object({ path: z.string().min(1), sha256: Hex }).strict();

/** One changed path. `after` is the hash of the file bytes the real tree must end up with; `contentRef` names the evidence file that holds them. */
export const ProposalFileSchema = z.object({
  path: z.string().min(1),
  before: Hex.nullable(),
  after: Hex.nullable(),
  contentRef: EvidenceRefSchema.nullable(),
}).strict();

export type ProposalFile = z.infer<typeof ProposalFileSchema>;

/**
 * What an execution proposes to apply to the real checkout. Three fingerprints,
 * each named for what it is: the source tree at materialization (the apply
 * guard), the corrected tree after out-of-contract edits were restored (what
 * the real tree must equal after apply), and the tree the checks ran in.
 */
export const ProposalSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.PROPOSAL),
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  planId: z.string().regex(/^pln_[0-9a-z]+$/),
  taskId: z.string().regex(/^T-[0-9]+$/),
  adapterId: z.string().min(1),
  /** How the checkout was listed when `treeFingerprint` was taken; apply re-lists the same way. */
  treeMode: z.enum(["fs", "git"]),
  treeFingerprint: TreeFingerprint,
  appliedTreeFingerprint: TreeFingerprint,
  files: z.array(ProposalFileSchema),
  contractCheck: z.object({
    touched: z.number().int().nonnegative(),
    maxFilesTouched: z.number().int().positive(),
    reverted: z.array(z.object({ path: z.string().min(1), reason: z.string().min(1) }).strict()),
  }).strict(),
  verification: z.object({
    treeFingerprint: TreeFingerprint,
    results: z.array(z.object({
      check: z.string().min(1),
      source: z.enum(["task", "receipt"]),
      status: GateStatusSchema,
      reason: z.string().min(1),
      evidence: EvidenceRefSchema,
    }).strict()),
  }).strict(),
  summary: z.string(),
  /** Rule violations the proposal introduces or resolves (M4 slice a2); absent when the project has no rules. */
  architecture: ProposalArchitectureSchema.optional(),
  /** The proposal's blast radius in the candidate tree (M4 slice a2). */
  impact: ProposalImpactSchema.optional(),
  createdAt: z.string().datetime(),
}).strict();

export type Proposal = z.infer<typeof ProposalSchema>;

/** The evidence record that carries one proposed file's bytes. */
export const FileContentEvidenceSchema = z.object({
  kind: z.literal("file_content"),
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  sha256: Hex,
}).strict();

export type FileContentEvidence = z.infer<typeof FileContentEvidenceSchema>;
