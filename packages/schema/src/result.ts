import { z } from "zod";
import { SCHEMA_VERSIONS, PHASE_VALUES } from "./versions.js";
import { GateVerdictSchema } from "./contracts.js";

export const DiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  path: z.string().optional(),
  hint: z.string().min(1).optional(), // Actionable fix, rendered as a FIX: line
}).strict();

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const HumanDecisionNextActionSchema = z.object({
  type: z.literal("human_decision"),
  interruptId: z.string().min(1),
  decisionKind: z.string().min(1),
  run: z.string().min(1),
  payloadRef: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().optional(),
  responseSchema: z.string().default(SCHEMA_VERSIONS.DECISION),
}).strict();

export const CommandNextActionSchema = z.object({
  type: z.literal("command"),
  run: z.string().min(1),
  hint: z.string().optional(),
}).strict();

export const WaitNextActionSchema = z.object({
  type: z.literal("wait"),
  until: z.string().datetime(),
  reason: z.string().min(1),
}).strict();

/** A missing adapter credential: a typed pause, never a blocked diagnostic (A2A AUTH_REQUIRED borrow). */
export const CredentialRequiredNextActionSchema = z.object({
  type: z.literal("credential_required"),
  /** The environment variable the operator must set; its value never enters a run record. */
  variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  adapter: z.string().min(1),
  hint: z.string().min(1),
}).strict();

export const NoneNextActionSchema = z.object({
  type: z.literal("none"),
  reason: z.string().min(1),
}).strict();

export const NextActionSchema = z.discriminatedUnion("type", [
  HumanDecisionNextActionSchema,
  CommandNextActionSchema,
  WaitNextActionSchema,
  NoneNextActionSchema,
  CredentialRequiredNextActionSchema,
]);

export type NextAction = z.infer<typeof NextActionSchema>;

export const ResultEnvelopeSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.RESULT).default(SCHEMA_VERSIONS.RESULT),
  command: z.string().min(1),
  runId: z.string().optional(),
  status: z.enum(["ok", "ready", "awaiting_decision", "blocked", "refused", "usage_error"]),
  phase: z.enum(PHASE_VALUES),
  diagnostics: z.array(DiagnosticSchema).default([]),
  gates: z.array(GateVerdictSchema).default([]),
  nextAction: NextActionSchema,
}).strict();

export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;
