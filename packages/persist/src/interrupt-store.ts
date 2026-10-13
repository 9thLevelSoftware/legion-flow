import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InterruptSchema, DecisionSchema, type Interrupt, type Decision } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import { runDir } from "./run-store.js";
import type { LegionFlowPaths } from "./layout.js";

export interface LoadedInterrupt {
  runId: string;
  interrupt: Interrupt;
  /** The decision file, if one exists. It is the authority; the interrupt's status is an index of it. */
  decision: Decision | null;
  /** Status after joining the decision and applying expiry, computed without writing. */
  effectiveStatus: Interrupt["status"];
  path: string;
  decisionPath: string;
}

/**
 * The status a reader should act on. A decision file wins over the stored
 * status (a crash between writing the decision and updating the status leaves
 * the decision as authority). Expiry is derived from the clock, never written here.
 */
export function effectiveInterruptStatus(interrupt: Interrupt, decision: Decision | null, now: Date): Interrupt["status"] {
  if (decision) {
    return decision.decision === "reject" ? "rejected" : "approved";
  }
  if (interrupt.status !== "pending") {
    return interrupt.status;
  }
  return now.getTime() >= Date.parse(interrupt.expiresAt) ? "expired" : "pending";
}

function assertHeld(lock: HeldLock, what: string): void {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError(`${what} requires a HeldLock obtained from ProcessLock.acquire()`);
  }
}

const interruptPath = (paths: LegionFlowPaths, runId: string, id: string) => join(runDir(paths, runId), "interrupts", `${id}.json`);
const decisionPath = (paths: LegionFlowPaths, runId: string, id: string) => join(runDir(paths, runId), "decisions", `${id}.json`);

export async function writeInterrupt(paths: LegionFlowPaths, runId: string, interrupt: Interrupt, lock: HeldLock): Promise<string> {
  assertHeld(lock, "writeInterrupt");
  const valid = InterruptSchema.parse(interrupt);
  const path = interruptPath(paths, runId, valid.id);
  await mkdir(join(runDir(paths, runId), "interrupts"), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}

export async function updateInterrupt(
  paths: LegionFlowPaths,
  runId: string,
  id: string,
  patch: Partial<Pick<Interrupt, "status" | "consumedAt">>,
  lock: HeldLock
): Promise<Interrupt> {
  assertHeld(lock, "updateInterrupt");
  const path = interruptPath(paths, runId, id);
  const current = InterruptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const next = InterruptSchema.parse({ ...current, ...patch });
  await atomicWriteFile(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export async function writeDecision(paths: LegionFlowPaths, runId: string, decision: Decision, lock: HeldLock): Promise<string> {
  assertHeld(lock, "writeDecision");
  const valid = DecisionSchema.parse(decision);
  const path = decisionPath(paths, runId, valid.interruptId);
  await mkdir(join(runDir(paths, runId), "decisions"), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}

export async function loadInterrupt(paths: LegionFlowPaths, runId: string, id: string, now: Date): Promise<LoadedInterrupt | null> {
  const path = interruptPath(paths, runId, id);
  let interrupt: Interrupt;
  try {
    interrupt = InterruptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
  let decision: Decision | null = null;
  const dPath = decisionPath(paths, runId, id);
  try {
    const parsed = DecisionSchema.safeParse(JSON.parse(await readFile(dPath, "utf8")));
    if (parsed.success) decision = parsed.data;
  } catch {
    // no decision yet
  }
  return { runId, interrupt, decision, effectiveStatus: effectiveInterruptStatus(interrupt, decision, now), path, decisionPath: dPath };
}

/** Every interrupt of one run. */
export async function listInterrupts(paths: LegionFlowPaths, runId: string, now: Date): Promise<LoadedInterrupt[]> {
  let names: string[];
  try {
    names = await readdir(join(runDir(paths, runId), "interrupts"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const result: LoadedInterrupt[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const loaded = await loadInterrupt(paths, runId, name.slice(0, -5), now);
    if (loaded) result.push(loaded);
  }
  return result;
}

/** Find an interrupt by id across all runs; ids are unique, so the first match is the match. */
export async function findInterrupt(paths: LegionFlowPaths, id: string, now: Date): Promise<LoadedInterrupt | null> {
  let runs: string[];
  try {
    runs = (await readdir(paths.runsDir)).filter((n) => n.startsWith("run_"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const runId of runs) {
    const loaded = await loadInterrupt(paths, runId, id, now);
    if (loaded) return loaded;
  }
  return null;
}
