import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";

/** The spec challenge workflow (M4 slice j3): it asks questions and never sets the lifecycle phase. */
export const SPEC_CHALLENGE_WORKFLOW_ID = "spec_challenge";
export const SPEC_CHALLENGE_OUTPUT_FILE = "challenge.json";
export const CHALLENGE_AGENT_MAX = 3;

const RelPath = z.string().min(1).max(500).refine((p) => !p.startsWith("/") && !p.includes("\\") && !/^[A-Za-z]:/.test(p) && !p.split("/").includes(".."), "a forward-slash path relative to the workspace");

export const ChallengeEvidenceSchema = z.union([
  z.object({ path: RelPath, quote: z.string().min(1).max(500), verified: z.boolean() }).strict(),
  z.object({ assumption: z.string().min(1).max(1000) }).strict(),
]);

export const ChallengeResolutionSchema = z.object({
  disposition: z.enum(["answered", "dismissed", "risk_accepted"]),
  response: z.string().min(1).max(2000),
  approver: z.string().min(1),
  at: z.string().datetime(),
  source: z.literal("tty"),
  /** For risk_accepted: the human fact recorded for recall. */
  factId: z.string().regex(/^fct_[0-9a-z]+$/).optional(),
}).strict();

/** One question about the spec: from a lint rule (about a criterion or the prose) or from the challenge agent (unverified). */
export const ChallengeConcernSchema = z.object({
  id: z.string().regex(/^C-[0-9]+$/),
  source: z.enum(["lint", "agent"]),
  rule: z.string().min(1).optional(),
  criterionId: z.string().regex(/^AC-[0-9]+$/).optional(),
  question: z.string().min(1).max(1000),
  why: z.string().min(1).max(1000),
  evidence: z.array(ChallengeEvidenceSchema).max(3),
  /** An agent concern whose quote did not appear at its path. */
  unverified: z.boolean().optional(),
  resolution: ChallengeResolutionSchema.optional(),
}).strict();
export type ChallengeConcern = z.infer<typeof ChallengeConcernSchema>;

export const ChallengeRoundSchema = z.object({
  round: z.number().int().min(1),
  specFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
  agent: z.object({
    ran: z.boolean(),
    runId: z.string().regex(/^run_[0-9a-z]+$/).optional(),
    /** agent_failed, agent_output_invalid, or absent when it ran and its output parsed. */
    note: z.enum(["agent_failed", "agent_output_invalid"]).optional(),
    dropped: z.number().int().min(0),
  }).strict(),
  concerns: z.array(ChallengeConcernSchema),
}).strict();
export type ChallengeRound = z.infer<typeof ChallengeRoundSchema>;

/** project/specs/<id>/challenge.json: every round kept, the last one current. Outside the spec's fingerprint. */
export const SpecChallengeSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.SPEC_CHALLENGE),
  specId: z.string().regex(/^spc_[0-9a-z]+$/),
  rounds: z.array(ChallengeRoundSchema).min(1),
}).strict();
export type SpecChallenge = z.infer<typeof SpecChallengeSchema>;

export type ChallengeStatus = "none" | "open" | "complete" | "stale";

/** The current round's status against the spec's current fingerprint. */
export function challengeStatus(record: SpecChallenge | null, specFingerprint: string): { status: ChallengeStatus; round?: ChallengeRound; unresolved: number } {
  const round = record?.rounds.at(-1);
  if (!round) return { status: "none", unresolved: 0 };
  const unresolved = round.concerns.filter((c) => !c.resolution).length;
  if (round.specFingerprint !== specFingerprint) return { status: "stale", round, unresolved };
  return { status: unresolved ? "open" : "complete", round, unresolved };
}
