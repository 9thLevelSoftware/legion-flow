import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";

export const RiskClassSchema = z.enum([
  "read",
  "edit",
  "create_delete",
  "terminal",
  "network",
  "retention",
  "extension",
  "remote",
]);

export type RiskClass = z.infer<typeof RiskClassSchema>;

export const InterruptKindSchema = z.enum([
  "approve_action",
  "credential_required",
  "review_finding",
  "human_input",
]);

export type InterruptKind = z.infer<typeof InterruptKindSchema>;

export const InterruptSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.INTERRUPT),
  id: z.string().regex(/^int_[0-9A-Za-z]+$/),
  runId: z.string().min(1),
  stepSeq: z.number().int().nonnegative(),
  kind: InterruptKindSchema,
  action: z.object({
    name: z.string().min(1),
    riskClass: RiskClassSchema,
    argsFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    policyVersion: z.string().default("risk-policy/v1"),
  }).strict(),
  payloadRef: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  responseSchema: z.literal(SCHEMA_VERSIONS.DECISION),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  onTimeout: z.enum(["cancel", "skip", "reject"]).default("cancel"),
  status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]).default("pending"),
  /** Which node the workflow resumes at for each outcome. The interrupting node is never re-run. */
  resume: z.object({
    onApprove: z.string().min(1),
    onReject: z.string().min(1).optional(),
    onSkip: z.string().min(1).optional(),
  }).strict().optional(),
  /** Set when the engine resumes through this interrupt; a consumed interrupt cannot resume twice. */
  consumedAt: z.string().datetime().optional(),
}).strict();

export type Interrupt = z.infer<typeof InterruptSchema>;

export const DecisionSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.DECISION),
  interruptId: z.string().regex(/^int_[0-9A-Za-z]+$/),
  expectedStatus: z.literal("pending"), // Compare-and-set safeguard against races
  decision: z.enum(["approve", "reject", "edit"]),
  editedArgs: z.record(z.string(), z.unknown()).nullable(),
  note: z.string().min(1),
  decidedBy: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    kind: z.literal("human"),
  }).strict(),
  decidedAt: z.string().datetime(),
  source: z.enum(["tty", "piped"]),
  idempotencyKey: z.string().min(1),
}).strict();

export type Decision = z.infer<typeof DecisionSchema>;
