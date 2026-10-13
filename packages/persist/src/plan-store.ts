import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PlanSchema, SCHEMA_VERSIONS, type Plan } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { fingerprintRecord } from "./fingerprint.js";
import { newId } from "./ids.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

export type PlanInvalidCause = "unreadable" | "malformed_json" | "schema";

export type LoadPlanResult =
  | { kind: "absent"; id: string; dir: string }
  | { kind: "invalid"; id: string; dir: string; cause: PlanInvalidCause; detail: string }
  | { kind: "valid"; id: string; dir: string; plan: Plan; fingerprint: string };

export interface CreatedPlan {
  plan: Plan;
  dir: string;
  fingerprint: string;
}

export function planDir(paths: LegionFlowPaths, id: string): string {
  return join(paths.plansDir, id);
}

/** A plan is one record, so its fingerprint is the canonical JSON of the parsed record. */
export function planFingerprint(plan: Plan): string {
  return fingerprintRecord(plan);
}

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
}

export async function loadPlan(paths: LegionFlowPaths, id: string): Promise<LoadPlanResult> {
  const dir = planDir(paths, id);
  const jsonPath = join(dir, "plan.json");

  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", id, dir };
    }
    return { kind: "invalid", id, dir, cause: "unreadable", detail: (err as Error).message };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: unknown) {
    return { kind: "invalid", id, dir, cause: "malformed_json", detail: (err as Error).message };
  }

  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", id, dir, cause: "schema", detail: formatIssues(parsed.error.issues) };
  }
  if (parsed.data.id !== id) {
    return { kind: "invalid", id, dir, cause: "schema", detail: `id: record says ${parsed.data.id}, directory says ${id}` };
  }
  return { kind: "valid", id, dir, plan: parsed.data, fingerprint: planFingerprint(parsed.data) };
}

/** Create an empty draft plan against a frozen spec, under the engine lock. */
export async function createPlan(
  paths: LegionFlowPaths,
  spec: { id: string; fingerprint: string },
  lock: HeldLock
): Promise<CreatedPlan> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("createPlan requires a HeldLock obtained from ProcessLock.acquire()");
  }
  const plan = PlanSchema.parse({
    schema: SCHEMA_VERSIONS.PLAN,
    id: newId("pln"),
    specId: spec.id,
    specFingerprint: spec.fingerprint,
    createdAt: new Date().toISOString(),
  });
  const dir = planDir(paths, plan.id);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return { plan, dir, fingerprint: planFingerprint(plan) };
}
