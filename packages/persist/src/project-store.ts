import { readFile } from "node:fs/promises";
import {
  ProjectConfigSchema,
  SCHEMA_VERSIONS,
  type Phase,
  type ProjectConfig,
} from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { ensureLegionFlowLayout, getLegionFlowPaths } from "./layout.js";
import { HeldLock } from "./lock.js";
import { derivePhase, type PhaseReason, type PhaseResult } from "./phase.js";

/**
 * The project store: the one place that answers "is there a usable project
 * here, and what phase is it in". Expected states are return values, never
 * exceptions: absent, invalid (with a cause), or valid (with the derived phase).
 */

export type ProjectInvalidCause = "unreadable" | "malformed_json" | "schema";

export type LoadProjectResult =
  | { kind: "absent"; path: string }
  | { kind: "invalid"; path: string; cause: ProjectInvalidCause; detail: string }
  | { kind: "valid"; path: string; config: ProjectConfig; phase: Phase; phaseReasons: PhaseReason[]; pendingInterrupt?: PhaseResult["pendingInterrupt"] };

export type ExistingProject = Exclude<LoadProjectResult, { kind: "absent" }>;

export interface CreateProjectInput {
  name: string;
  adapterId: string;
  ownerId: string;
  ownerDisplayName?: string;
}

export type CreateProjectResult =
  | { kind: "created"; path: string; config: ProjectConfig; phase: Phase }
  | { kind: "exists"; existing: ExistingProject };

export type CurrentPointer = NonNullable<ProjectConfig["current"]>;

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
}

export async function loadProject(workspaceRoot: string, now: Date = new Date()): Promise<LoadProjectResult> {
  const paths = getLegionFlowPaths(workspaceRoot);
  const path = paths.projectConfig;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", path };
    }
    return { kind: "invalid", path, cause: "unreadable", detail: (err as Error).message };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: unknown) {
    return { kind: "invalid", path, cause: "malformed_json", detail: (err as Error).message };
  }

  const parsed = ProjectConfigSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", path, cause: "schema", detail: formatIssues(parsed.error.issues) };
  }

  const { phase, reasons, pendingInterrupt } = await derivePhase(paths, parsed.data, now);
  return { kind: "valid", path, config: parsed.data, phase, phaseReasons: reasons, ...(pendingInterrupt ? { pendingInterrupt } : {}) };
}

/**
 * Create the project record under the engine lock. The existence check runs
 * inside the lock so two racing creates cannot both see "absent". Any existing
 * record, valid or corrupt, is reported back rather than overwritten. The
 * layout is created only once a record is about to be written, so a refused
 * create touches nothing.
 */
export async function createProject(
  workspaceRoot: string,
  input: CreateProjectInput,
  lock: HeldLock
): Promise<CreateProjectResult> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("createProject requires a HeldLock obtained from ProcessLock.acquire()");
  }

  const existing = await loadProject(workspaceRoot);
  if (existing.kind !== "absent") {
    return { kind: "exists", existing };
  }

  const paths = await ensureLegionFlowLayout(workspaceRoot);

  // Defaults (risk policy, risk tier, control mode) come from the schema, never from copied literals.
  const config = ProjectConfigSchema.parse({
    schema: SCHEMA_VERSIONS.PROJECT,
    id: `prj_${Date.now().toString(36)}`,
    name: input.name,
    decisionOwners: [
      {
        id: input.ownerId,
        displayName: input.ownerDisplayName ?? (input.ownerId === "human_operator" ? "Human Operator" : input.ownerId),
        kind: "human",
      },
    ],
    adapter: { default: input.adapterId },
    createdAt: new Date().toISOString(),
  });

  await atomicWriteFile(paths.projectConfig, JSON.stringify(config, null, 2) + "\n");
  const { phase } = await derivePhase(paths, config);
  return { kind: "created", path: paths.projectConfig, config, phase };
}

/**
 * The one mutation the record allows after creation: moving the `current`
 * pointer. Everything else is immutable; the pointer is excluded from the
 * config fingerprint so moving it never invalidates an approval. Returns the
 * reloaded record, or the non-valid result unchanged when there is nothing to update.
 */
export async function setCurrent(
  workspaceRoot: string,
  patch: Partial<CurrentPointer>,
  lock: HeldLock
): Promise<LoadProjectResult> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("setCurrent requires a HeldLock obtained from ProcessLock.acquire()");
  }
  const loaded = await loadProject(workspaceRoot);
  if (loaded.kind !== "valid") {
    return loaded;
  }
  const next = ProjectConfigSchema.parse({
    ...loaded.config,
    current: { ...(loaded.config.current ?? {}), ...patch },
  });
  await atomicWriteFile(loaded.path, JSON.stringify(next, null, 2) + "\n");
  return loadProject(workspaceRoot);
}
