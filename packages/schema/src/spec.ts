import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { AcceptanceCriterionSchema } from "./contracts.js";

/**
 * The typed half of a specification. The prose half is SPEC.md beside it.
 * There is deliberately no status field: a spec is frozen when an approval
 * receipt matches its current fingerprint, and a draft otherwise.
 */
export const SpecSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.SPEC),
  id: z.string().regex(/^spc_[0-9a-z]+$/),
  title: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  createdAt: z.string().datetime(),
}).strict();

export type Spec = z.infer<typeof SpecSchema>;
