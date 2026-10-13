import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { FileContractSchema } from "./contracts.js";
import { BrowserSessionSchema } from "./browser.js";
import { WebSessionSchema } from "./web.js";
import { TaskCoordinateSchema } from "./coordinator.js";

/** One unit of work: what it covers, what it may touch, what must run to prove it. */
export const PlanTaskSchema = z.object({
  id: z.string().regex(/^T-[0-9]+$/),
  title: z.string().min(1),
  /** Acceptance criteria this task delivers, by the spec's AC ids. */
  acceptanceIds: z.array(z.string().regex(/^AC-[0-9]+$/)).default([]),
  dependsOn: z.array(z.string().regex(/^T-[0-9]+$/)).default([]),
  contract: FileContractSchema,
  /** The coordinator member that does this task (M4 slice j1); frozen by plan approval and winning over route rules. */
  member: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
  /** MCP tools this task's agent may call through the gateway (M4 slice k): `<server>` or `<server>.<tool>`; frozen by plan approval. */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_-]*(\.[^\s]+)?$/)).optional(),
  /** The built-in browser server's session (M4 slice o1), for a task whose tools name `browser`; frozen by plan approval. */
  browser: BrowserSessionSchema.optional(),
  /** The built-in web server's session (M4 slice z), for a task whose tools name `web`; frozen by plan approval. */
  web: WebSessionSchema.optional(),
  /** The coordinate strategy (M4 slice m): member steps in order in one tree, repeated until the checks pass; not with `member`. */
  coordinate: TaskCoordinateSchema.optional(),
}).strict();

export type PlanTask = z.infer<typeof PlanTaskSchema>;

/**
 * The execution plan against one frozen spec. It records the fingerprint of the
 * spec it was planned against, so a plan written for a spec that has since
 * changed is detectable without a receipt. No status field: approved is derived.
 */
export const PlanSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.PLAN),
  id: z.string().regex(/^pln_[0-9a-z]+$/),
  specId: z.string().regex(/^spc_[0-9a-z]+$/),
  specFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  tasks: z.array(PlanTaskSchema).default([]),
  createdAt: z.string().datetime(),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;
