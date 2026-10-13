import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { DecisionOwnerSchema } from "./project.js";

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ApprovalSubjectSchema = z.enum(["spec", "plan"]);
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;

/**
 * A human approval receipt. Content-bound: it names the fingerprints it
 * approved, so any later change to the subject makes it stop matching.
 * Written once; never edited; re-approving an unchanged subject writes nothing.
 */
export const ApprovalSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.APPROVAL),
  id: z.string().regex(/^apv_[0-9a-z]+$/),
  subject: ApprovalSubjectSchema,
  subjectId: z.string().min(1),
  fingerprints: z.object({
    spec: FingerprintSchema,
    plan: FingerprintSchema.optional(),
    config: FingerprintSchema,
  }).strict(),
  /** Plan approvals only: the frozen argv checks, one string per --check. */
  checks: z.array(z.string().min(1)).optional(),
  /** sha256 of each browser:<script> named by a task check or a receipt check, frozen at approval (M4 slice e). */
  browserScripts: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  /** Spec approvals only (M4 slice j3): the current challenge round's state at approval, when a round exists. */
  challenge: z.object({ round: z.number().int().min(1), status: z.enum(["open", "complete", "stale"]), concerns: z.number().int().min(0), unresolved: z.number().int().min(0), agentRan: z.boolean() }).strict().optional(),
  decidedBy: DecisionOwnerSchema,
  decidedAt: z.string().datetime(),
  source: z.enum(["tty", "piped"]),
  idempotencyKey: z.string().min(1),
}).strict();

export type Approval = z.infer<typeof ApprovalSchema>;
