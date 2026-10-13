import { z } from "zod";
import { AcceptanceCriterionSchema } from "./contracts.js";

/**
 * Drafting (after M4 slice aa): `spec --draft` and `plan --draft` ask the project's default adapter, in the sandbox,
 * to answer one JSON document; Legion validates it and writes the files. These workflows never set the lifecycle phase.
 */
export const SPEC_DRAFT_WORKFLOW_ID = "draft_spec";
export const PLAN_DRAFT_WORKFLOW_ID = "draft_plan";
export const DRAFT_OUTPUT_FILE = "draft.json";
export const DRAFT_MAX_CRITERIA = 20;
export const DRAFT_MAX_TASKS = 30;

export const SpecDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  intent: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(DRAFT_MAX_CRITERIA),
  outOfScope: z.string().trim().max(2000).optional(),
});
export type SpecDraft = z.infer<typeof SpecDraftSchema>;

/** A drafted task carries only the file contract; tools, browser, web, members, and coordinate steps stay human-added. */
export const DraftTaskSchema = z.object({
  id: z.string().regex(/^T-[0-9]+$/),
  title: z.string().trim().min(1).max(300),
  acceptanceIds: z.array(z.string().regex(/^AC-[0-9]+$/)).default([]),
  dependsOn: z.array(z.string().regex(/^T-[0-9]+$/)).default([]),
  contract: z.object({
    filesAllowed: z.array(z.string().min(1)).min(1),
    verificationCommands: z.array(z.string().min(1)).default([]),
  }),
});
export type DraftTask = z.infer<typeof DraftTaskSchema>;

export const PlanDraftSchema = z.object({
  tasks: z.array(DraftTaskSchema).min(1).max(DRAFT_MAX_TASKS),
  /** Checks the drafter suggests freezing at approval; only ever printed, never applied. */
  checks: z.array(z.string().min(1).max(500)).max(10).optional(),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

/** Task fields a drafter may not set; they are removed from its answer with a named warning. */
export const DRAFT_STRIPPED_TASK_FIELDS = ["member", "tools", "browser", "web", "coordinate"] as const;
