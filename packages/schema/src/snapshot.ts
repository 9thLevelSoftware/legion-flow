import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";

export const StepTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  interrupts: z.array(z.string()),
  error: z.string().nullable(),
}).strict();

export type StepTask = z.infer<typeof StepTaskSchema>;

export const StepSnapshotSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.STEP_SNAPSHOT),
  runId: z.string().regex(/^run_[0-9A-Za-z]+$/),
  seq: z.number().int().nonnegative(),
  parentSeq: z.number().int().nonnegative().nullable(),
  namespace: z.string().default(""), // Nested subgraphs / tasks: e.g. "review:run_12|worker:run_3"
  source: z.enum(["input", "loop", "update", "resume"]),
  values: z.record(z.string(), z.unknown()), // Reducer-merged state record
  next: z.array(z.string()), // Target nodes; empty indicates step/graph completion
  tasks: z.array(StepTaskSchema),
  graphFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  durability: z.enum(["exit", "async", "sync"]),
  createdAt: z.string().datetime(),
}).strict();

export type StepSnapshot = z.infer<typeof StepSnapshotSchema>;
