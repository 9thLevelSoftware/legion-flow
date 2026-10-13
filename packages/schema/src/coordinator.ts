import { z } from "zod";
import { matchesAnyPathPattern } from "./paths.js";

/** The implicit member: the project's default adapter and model. Always present; a declared member may not take its id. */
export const DEFAULT_MEMBER_ID = "default";
const MemberId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "a member id is a lowercase slug");

/** One coordinator member (M4 slice j1): who does a task. A member that requires a sandbox is never run on the host tier. */
export const CoordinatorMemberSchema = z.object({
  id: MemberId,
  adapter: z.string().min(1),
  model: z.string().min(1).optional(),
  description: z.string().min(1).max(500).optional(),
  sandbox: z.literal("require").optional(),
}).strict();
export type CoordinatorMember = z.infer<typeof CoordinatorMemberSchema>;

/** A declared route: a task whose every filesAllowed entry matches one of these patterns goes to this member. */
export const CoordinatorRouteSchema = z.object({ match: z.array(z.string().min(1)).min(1), member: MemberId }).strict();

/** project.json `coordinator`: fan-out as declared policy, never emergent behavior. Optional with no defaults, so it never shifts a fingerprint. */
export const CoordinatorConfigSchema = z.object({
  members: z.array(CoordinatorMemberSchema).optional(),
  route: z.array(CoordinatorRouteSchema).optional(),
  /** How many members one broadcast may run (M4 slice j2); 3 when unset, never more than 4. */
  maxBroadcast: z.number().int().min(2).max(4).optional(),
}).strict()
  .refine((c) => !(c.members ?? []).some((m) => m.id === DEFAULT_MEMBER_ID), { message: `no declared member may be named '${DEFAULT_MEMBER_ID}'; that id is the project's default adapter` })
  .refine((c) => new Set((c.members ?? []).map((m) => m.id)).size === (c.members ?? []).length, { message: "member ids must be unique" })
  .refine((c) => (c.route ?? []).every((r) => r.member === DEFAULT_MEMBER_ID || (c.members ?? []).some((m) => m.id === r.member)), { message: "every route names a declared member or 'default'" });
export type CoordinatorConfig = z.infer<typeof CoordinatorConfigSchema>;

/** Who ran a task and why: recorded on the run and in its brief. */
export const RunMemberSchema = z.object({
  id: MemberId,
  adapter: z.string().min(1),
  model: z.string().min(1).optional(),
  sandbox: z.literal("require").optional(),
  /** `task` (the plan names it), `route <patterns>`, or `default`. */
  reason: z.string().min(1),
}).strict();
export type RunMember = z.infer<typeof RunMemberSchema>;

/**
 * The coordinate strategy (M4 slice m): declared steps, frozen with the plan, run in order in one tree, each by a
 * member with a short role. There is no model leader: the plan is the decomposition, and each step works on what the
 * earlier ones left. The whole sequence repeats until the task's checks pass, at most `maxIterations` times.
 */
export const COORDINATE_MAX_STEPS = 4;
export const COORDINATE_MAX_ITERATIONS = 3;
export const CoordinateStepSchema = z.object({ member: MemberId, role: z.string().trim().min(1).max(500) }).strict();
export const TaskCoordinateSchema = z.object({
  steps: z.array(CoordinateStepSchema).min(1).max(COORDINATE_MAX_STEPS),
  maxIterations: z.number().int().min(1).max(COORDINATE_MAX_ITERATIONS).optional(),
}).strict();
export type TaskCoordinate = z.infer<typeof TaskCoordinateSchema>;

/** A broadcast's choice interrupt (M4 slice j2): a human picks one member's proposal, never a merge. */
export const CHOOSE_PROPOSAL_ACTION = "fs.choose_proposal";
export const BROADCAST_WORKFLOW_ID = "broadcast";
export const BROADCAST_DEFAULT_MAX = 3;

/** Marks a run as part of a broadcast: a member's withheld run, or the choice run that applies one. */
export const RunBroadcastSchema = z.object({ id: z.string().regex(/^bcs_[0-9a-z]+$/), role: z.enum(["member", "choice"]) }).strict();
export type RunBroadcast = z.infer<typeof RunBroadcastSchema>;

/** Every member id a plan task may name. */
export function memberIds(coordinator: CoordinatorConfig | undefined): string[] {
  return [DEFAULT_MEMBER_ID, ...(coordinator?.members ?? []).map((m) => m.id)];
}

/**
 * Route one task (M4 slice j1): the plan's `member` wins; else the first route whose
 * patterns cover every filesAllowed entry (each tested as a literal path); else the
 * default. A task spanning two areas therefore goes to the default, never to whichever
 * specialist is listed first. An unknown member is an error, never a guess.
 */
export function routeTask(config: { adapter: { default: string; http?: { model?: string | undefined } | undefined }; coordinator?: CoordinatorConfig | undefined }, task: { member?: string | undefined; coordinate?: { steps: { member: string }[] } | undefined; contract: { filesAllowed: string[] } }): { ok: true; member: RunMember } | { ok: false; reason: string } {
  const resolve = (id: string, reason: string): { ok: true; member: RunMember } | { ok: false; reason: string } => {
    if (id === DEFAULT_MEMBER_ID) {
      const model = config.adapter.http?.model;
      return { ok: true, member: { id, adapter: config.adapter.default, ...(model ? { model } : {}), reason } };
    }
    const m = (config.coordinator?.members ?? []).find((x) => x.id === id);
    if (!m) return { ok: false, reason: `member '${id}' is not declared in project.json coordinator.members` };
    return { ok: true, member: { id, adapter: m.adapter, ...(m.model ? { model: m.model } : {}), ...(m.sandbox ? { sandbox: m.sandbox } : {}), reason } };
  };
  if (task.member) return resolve(task.member, "task");
  // A coordinate task runs as its first step's member; the other steps are recorded on the run (M4 slice m).
  if (task.coordinate?.steps.length) return resolve(task.coordinate.steps[0]!.member, "coordinate");
  const files = task.contract.filesAllowed;
  const rule = (config.coordinator?.route ?? []).find((r) => files.length > 0 && files.every((f) => matchesAnyPathPattern(f, r.match)));
  if (rule) return resolve(rule.member, `route ${rule.match.join(", ")}`);
  return resolve(DEFAULT_MEMBER_ID, "default");
}
