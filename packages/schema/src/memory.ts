import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { SPEC_CHALLENGE_WORKFLOW_ID } from "./challenge.js";

/**
 * Memory facts (M4 slice b). Facts are bi-temporal: `validAt` is when the
 * statement became true in the world, `createdAt` when it was recorded; an
 * invalidated fact keeps both and gains `invalidAt` and `expiredAt`, and is never
 * deleted. Episodes in project/ are the only durable record; the index tables
 * are a replay of them.
 */

// No whitespace, no backslash, and no angle brackets: a reference is rendered into prompts and must not carry markup.
const RelPath = "[^\\s#\\\\<>]+";
/** Typed references: what a fact is about, or points at. */
export const FACT_REF_PATTERN = new RegExp(`^(module:${RelPath}|symbol:${RelPath}#[^\\s#<>]+|package:[^\\s<>]+|task:T-[0-9]+|release:rel_[0-9a-z]+|topic:[a-z0-9][a-z0-9-]*)$`);
export const FactRefSchema = z.string().regex(FACT_REF_PATTERN, "a typed reference: module:<path>, symbol:<path>#<name>, package:<name>, task:T-<n>, release:rel_<id>, or topic:<slug>").refine((r) => !r.split("/").includes(".."), "no .. segments");
export type FactRef = z.infer<typeof FactRefSchema>;

export const FACT_ORIGINS = ["deterministic", "human", "llm"] as const;

/** The supersession workflow. Its runs are memory, not lifecycle: they never set the project phase. */
export const MEMORY_SUPERSEDE_WORKFLOW_ID = "memory_supersede";
export const MEMORY_SUPERSEDE_ACTION = "memory.supersede";
/** The observation workflow (M4 slice i): a human commits a cluster the algorithm found. */
export const MEMORY_OBSERVE_WORKFLOW_ID = "memory_observe";
export const MEMORY_OBSERVE_ACTION = "memory.observe";
/** Memory workflows: their runs never set the lifecycle phase. */
export const MEMORY_WORKFLOW_IDS: readonly string[] = [MEMORY_SUPERSEDE_WORKFLOW_ID, MEMORY_OBSERVE_WORKFLOW_ID];
/**
 * Observation naming (M4 slice p): a model suggests the words for a cluster before it is proposed. A run of its own,
 * never routed as a memory decision (it raises no interrupt), and never part of the lifecycle phase.
 */
export const MEMORY_OBSERVE_NAME_WORKFLOW_ID = "memory_observe_name";
export const OBSERVATION_NAMING_FILE = "naming.json";
/** Every workflow whose runs never set the lifecycle phase: memory's, observation naming, and the spec challenge (M4 slice j3). */
export const NON_LIFECYCLE_WORKFLOW_IDS: readonly string[] = [...MEMORY_WORKFLOW_IDS, MEMORY_OBSERVE_NAME_WORKFLOW_ID, SPEC_CHALLENGE_WORKFLOW_ID];
export const OBSERVATION_NAME_MAX = 120;
export const OBSERVATION_SUMMARY_MAX = 2000;
export const PredicateSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "a predicate is a lowercase slug");

export const FactSchema = z.object({
  id: z.string().regex(/^fct_[0-9a-z]+$/),
  subject: FactRefSchema,
  predicate: PredicateSchema,
  object: z.union([z.object({ ref: FactRefSchema }).strict(), z.object({ text: z.string().min(1).max(2000) }).strict()]),
  validAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  origin: z.enum(FACT_ORIGINS),
  /** For a human fact: the decision owner who asserted it. */
  assertedBy: z.string().min(1).optional(),
  /** Facts this one replaces once a human approves the supersession. */
  supersedes: z.array(z.string().regex(/^fct_[0-9a-z]+$/)).optional(),
}).strict();
export type Fact = z.infer<typeof FactSchema>;

const EpisodeBase = { schema: z.literal(SCHEMA_VERSIONS.EPISODE), id: z.string().regex(/^ep_[0-9a-z]+$/), createdAt: z.string().datetime() };

/** One asserted fact. `proposed` while a supersession awaits a decision; recall never returns a proposed fact. */
export const LearnEpisodeSchema = z.object({
  ...EpisodeBase,
  kind: z.literal("learn"),
  fact: FactSchema,
  status: z.enum(["active", "proposed"]),
  /** Whether a module or symbol subject was checked against a fresh map. */
  subjectVerified: z.boolean(),
  /** The supersession workflow run, when the fact is proposed. */
  runId: z.string().regex(/^run_[0-9a-z]+$/).optional(),
}).strict();
export type LearnEpisode = z.infer<typeof LearnEpisodeSchema>;

/** A human decision on a proposed supersession, or its expiry. */
export const SupersessionEpisodeSchema = z.object({
  ...EpisodeBase,
  kind: z.literal("supersession"),
  newFactId: z.string().regex(/^fct_[0-9a-z]+$/),
  oldFactIds: z.array(z.string().regex(/^fct_[0-9a-z]+$/)).min(1),
  outcome: z.enum(["approved", "rejected", "expired"]),
  interruptId: z.string().regex(/^int_[0-9A-Za-z]+$/),
  decidedBy: z.string().min(1).optional(),
}).strict();
export type SupersessionEpisode = z.infer<typeof SupersessionEpisodeSchema>;

/** A release's deterministic facts, written once per release. */
export const RetroEpisodeSchema = z.object({
  ...EpisodeBase,
  kind: z.literal("retro"),
  releaseId: z.string().regex(/^rel_[0-9a-z]+$/),
  facts: z.array(FactSchema),
}).strict();
export type RetroEpisode = z.infer<typeof RetroEpisodeSchema>;

/**
 * A repeated statement (M4 slice i): `learn` of a statement an active fact already
 * records writes no second fact, only this link from a new episode to it, so the
 * statement is known to have been made again (Zep's one edge, many episodes).
 */
export const CorroborationEpisodeSchema = z.object({
  ...EpisodeBase,
  kind: z.literal("corroboration"),
  factId: z.string().regex(/^fct_[0-9a-z]+$/),
  origin: z.enum(FACT_ORIGINS),
  assertedBy: z.string().min(1).optional(),
}).strict();
export type CorroborationEpisode = z.infer<typeof CorroborationEpisodeSchema>;

const ObservationOrigins = z.object({ deterministic: z.number().int().min(0), human: z.number().int().min(0), llm: z.number().int().min(0) }).strict();

/**
 * A cluster of facts that share statement keys across two or more episodes (M4 slice i),
 * found by a deterministic algorithm and named by a template. A key is
 * `subject\0predicate\0ref:<ref>` or `...\0text:<normalized text>`.
 */
export const ObservationCandidateSchema = z.object({
  id: z.string().regex(/^obc_[0-9a-f]{12}$/),
  name: z.string().min(1).max(OBSERVATION_NAME_MAX),
  summary: z.string().min(1).max(OBSERVATION_SUMMARY_MAX),
  keys: z.array(z.string().min(1)).min(1),
  subjects: z.array(z.string().min(1)).min(1),
  factIds: z.array(z.string().regex(/^fct_[0-9a-z]+$/)).min(1),
  episodeIds: z.array(z.string().regex(/^ep_[0-9a-z]+$/)).min(2),
  /** Per mention: one fact in one episode (its own, or a corroboration). */
  origins: ObservationOrigins,
  firstValidAt: z.string().datetime(),
  lastValidAt: z.string().datetime(),
}).strict();
export type ObservationCandidate = z.infer<typeof ObservationCandidateSchema>;

/** A human-committed observation: the candidate as decided, with the decider; never edited, only retired by a later overlapping one. */
export const ObservationEpisodeSchema = z.object({
  ...EpisodeBase,
  kind: z.literal("observation"),
  candidateId: z.string().regex(/^obc_[0-9a-f]{12}$/),
  name: z.string().min(1).max(OBSERVATION_NAME_MAX),
  summary: z.string().min(1).max(OBSERVATION_SUMMARY_MAX),
  keys: z.array(z.string().min(1)).min(1),
  factIds: z.array(z.string().regex(/^fct_[0-9a-z]+$/)).min(1),
  episodeIds: z.array(z.string().regex(/^ep_[0-9a-z]+$/)).min(2),
  origins: ObservationOrigins,
  /** True when a decision owner replaced the template's name or summary. */
  edited: z.boolean(),
  decidedBy: z.string().min(1),
  interruptId: z.string().regex(/^int_[0-9A-Za-z]+$/),
  /** Whose words were committed (M4 slice p); absent on earlier episodes, which read as the template's. */
  wording: z.object({ by: z.enum(["template", "agent", "human"]), adapter: z.string().min(1).optional(), model: z.string().min(1).optional(), runId: z.string().min(1).optional() }).strict().optional(),
}).strict();
export type ObservationEpisode = z.infer<typeof ObservationEpisodeSchema>;

/** No control characters and no untrusted-content markup: suggested words are rendered into prompts and documents. */
const cleanWords = (max: number, oneLine: boolean) =>
  z.string().trim().min(1).max(max).refine((s) => !/untrusted-content/i.test(s), "no untrusted-content markup").refine((s) => !(oneLine ? /[\u0000-\u001f\u007f]/ : /[\u0000-\u0008\u000b-\u001f\u007f]/).test(s), oneLine ? "one line, no control characters" : "no control characters");
/** A model's suggested words for a cluster (M4 slice p): the same limits as a human's, one line for the name. */
export const ObservationSuggestionSchema = z.object({ name: cleanWords(OBSERVATION_NAME_MAX, true), summary: cleanWords(OBSERVATION_SUMMARY_MAX, false) }).strict();
export type ObservationSuggestion = z.infer<typeof ObservationSuggestionSchema>;

/** What `decide --edit` may change on a memory.observe interrupt: the words, never the members. */
export const ObservationEditSchema = z.object({ name: z.string().min(1).max(OBSERVATION_NAME_MAX).optional(), summary: z.string().min(1).max(OBSERVATION_SUMMARY_MAX).optional() }).strict().refine((e) => e.name !== undefined || e.summary !== undefined, "edit name, summary, or both");

export const FACT_STATUSES = ["active", "proposed", "rejected", "superseded"] as const;
/** A fact as replay leaves it: its status and, once superseded, when it stopped being true and when it was retired. */
export const FactRowSchema = FactSchema.extend({
  status: z.enum(FACT_STATUSES),
  episodeId: z.string(),
  invalidAt: z.string().datetime().optional(),
  expiredAt: z.string().datetime().optional(),
  /** When the fact became active in memory: recorded, or approved after a supersession. */
  activatedAt: z.string().datetime().optional(),
}).strict();
export type FactRow = z.infer<typeof FactRowSchema>;

/** project.json `memory`: predicates that hold one value per subject, so a different value proposes a supersession. */
export const MemoryConfigSchema = z.object({
  singleValued: z.array(PredicateSchema).optional(),
  /** The coordinator member whose adapter and model suggest observation words under `observe --propose --agent` (M4 slice p); `default` when unset. */
  observeNamer: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
}).strict();

// ---- recall (M4 slice c) ----

/** `transcript` is agent-written run summaries (M4 slice g): unverified text, last in authority. */
export const RECALL_SOURCES = ["map", "deterministic", "human", "llm", "transcript"] as const;
export type RecallSource = (typeof RECALL_SOURCES)[number];

export const RecallCitationSchema = z.object({ label: z.string().min(1), locator: z.string().min(1) }).strict();

export const RecallItemSchema = z.object({
  /** A fact id, or a module path for a map item. */
  id: z.string().min(1),
  text: z.string(),
  /** The fused reciprocal-rank score; a position, never a confidence. */
  rank: z.number().min(0),
  citations: z.array(RecallCitationSchema),
  truncated: z.boolean(),
  fact: z.object({ subject: z.string(), predicate: z.string(), origin: z.enum(FACT_ORIGINS), status: z.enum(FACT_STATUSES), validAt: z.string(), invalidAt: z.string().optional(), createdAt: z.string(), expiredAt: z.string().optional() }).strict().optional(),
}).strict();
export type RecallItem = z.infer<typeof RecallItemSchema>;

export const RecallBlockSchema = z.object({
  source: z.enum(RECALL_SOURCES),
  status: z.enum(["OK", "INSUFFICIENT_CONTEXT", "ERROR"]),
  answer: z.string(),
  items: z.array(RecallItemSchema),
  missing: z.array(z.string()),
  budget: z.object({ limit: z.number().int().min(1), used: z.number().int().min(0), dropped: z.number().int().min(0), truncated: z.number().int().min(0) }).strict(),
}).strict();
export type RecallBlock = z.infer<typeof RecallBlockSchema>;

/** One recall: blocks in authority order (deterministic map, deterministic facts, human, llm, transcript). Tokens are estimated as characters divided by 4. */
export const RecallDocSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.RECALL),
  query: z.object({ text: z.string().optional(), subject: z.string().optional(), predicate: z.string().optional(), asOf: z.string().optional(), knownAt: z.string().optional() }).strict(),
  /** Which scorer answered the text: BM25 over the index when it matches a fresh replay, a term count over the replay otherwise. */
  factsIndexed: z.boolean(),
  mapFreshness: z.enum(["fresh", "stale", "partial", "absent"]),
  tokenEstimate: z.literal("chars/4"),
  blocks: z.array(RecallBlockSchema).length(5),
}).strict();
export type RecallDoc = z.infer<typeof RecallDocSchema>;

/** Memory facts about a task's files, for its brief. Rendered to the agent inside an untrusted-content block. */
export const BriefMemoryContextSchema = z.object({
  facts: z.array(z.object({ id: z.string(), subject: z.string(), predicate: z.string(), object: z.string(), origin: z.enum(FACT_ORIGINS), validAt: z.string() }).strict()),
  dropped: z.number().int().min(0),
  indexed: z.boolean(),
}).strict();
export type BriefMemoryContext = z.infer<typeof BriefMemoryContextSchema>;
