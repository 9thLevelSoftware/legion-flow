import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  RunSchema,
  GateVerdictSchema,
  EvidenceIndexEntrySchema,
  StepSnapshotSchema,
  InvalidationSchema,
  SCHEMA_VERSIONS,
  type Run,
  type ShipRun,
  type WorkflowRun,
  type GateVerdict,
  type EvidenceIndexEntry,
  type StepSnapshot,
  type Invalidation,
} from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { sha256Hex } from "./fingerprint.js";
import { newId } from "./ids.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

type Engineered = "schema" | "id" | "status" | "startedAt" | "endedAt";
export type CreateRunInput =
  | Omit<ShipRun, Engineered | "ready">
  | Omit<WorkflowRun, Engineered | "reason">;

export interface WrittenEvidence {
  /** Path relative to the project directory, as verdicts and the index record it. */
  path: string;
  sha256: string;
  absolutePath: string;
}

export interface LoadedRun {
  run: Run;
  dir: string;
  verdicts: GateVerdict[];
  evidenceIndex: EvidenceIndexEntry[];
}

export interface EvidenceVerification {
  ok: boolean;
  checked: number;
  drifted: string[];
  missing: string[];
}

/** One node's committed output inside a step, written before the step's snapshot folds it. */
export interface JournalEntry {
  node: string;
  writes: Record<string, unknown>;
  next: string[];
  /** An interrupt the node requested, with its id already minted so replay never mints twice. */
  interrupt?: Record<string, unknown>;
}

export function runDir(paths: LegionFlowPaths, id: string): string {
  return join(paths.runsDir, id);
}

/** Paths inside verdicts and the index are relative to project/, with forward slashes. */
export function projectRelative(paths: LegionFlowPaths, absolutePath: string): string {
  return relative(paths.project, absolutePath).split(sep).join("/");
}

function assertHeld(lock: HeldLock, what: string): void {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError(`${what} requires a HeldLock obtained from ProcessLock.acquire()`);
  }
}

async function readRun(dir: string): Promise<Run> {
  return RunSchema.parse(JSON.parse(await readFile(join(dir, "run.json"), "utf8")));
}

async function writeRun(dir: string, run: Run): Promise<void> {
  await atomicWriteFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
}

export async function createRun(paths: LegionFlowPaths, input: CreateRunInput, lock: HeldLock): Promise<{ run: Run; dir: string }> {
  assertHeld(lock, "createRun");
  const run = RunSchema.parse({
    ...input,
    schema: SCHEMA_VERSIONS.RUN,
    id: newId("run"),
    status: "running",
    startedAt: new Date().toISOString(),
  });
  const dir = runDir(paths, run.id);
  await mkdir(join(dir, "evidence"), { recursive: true });
  await mkdir(join(dir, "verdicts"), { recursive: true });
  await writeRun(dir, run);
  return { run, dir };
}

/** Ship runs: complete with the readiness verdict. */
export async function completeRun(paths: LegionFlowPaths, runId: string, ready: boolean, lock: HeldLock): Promise<ShipRun> {
  assertHeld(lock, "completeRun");
  const dir = runDir(paths, runId);
  const current = await readRun(dir);
  if (current.kind !== "ship") throw new TypeError(`completeRun: ${runId} is a ${current.kind} run`);
  const complete: ShipRun = { ...current, status: "complete", endedAt: new Date().toISOString(), ready };
  await writeRun(dir, RunSchema.parse(complete));
  return complete;
}

/** Workflow runs: record that the task's proposal was applied. Status is untouched; the engine finishes the run afterwards. */
export async function recordApplied(paths: LegionFlowPaths, runId: string, applied: NonNullable<WorkflowRun["applied"]>, lock: HeldLock): Promise<WorkflowRun> {
  assertHeld(lock, "recordApplied");
  const dir = runDir(paths, runId);
  const current = await readRun(dir);
  if (current.kind !== "workflow") throw new TypeError(`recordApplied: ${runId} is a ${current.kind} run`);
  const next: WorkflowRun = { ...current, applied };
  await writeRun(dir, RunSchema.parse(next));
  return next;
}

/** Review runs: record the verdict on the run. Status is untouched; the engine finishes the run afterwards. */
export async function recordReviewResult(paths: LegionFlowPaths, runId: string, review: NonNullable<WorkflowRun["review"]>, lock: HeldLock): Promise<WorkflowRun> {
  assertHeld(lock, "recordReviewResult");
  const dir = runDir(paths, runId);
  const current = await readRun(dir);
  if (current.kind !== "workflow") throw new TypeError(`recordReviewResult: ${runId} is a ${current.kind} run`);
  const next: WorkflowRun = { ...current, review };
  await writeRun(dir, RunSchema.parse(next));
  return next;
}

/** Eval runs: record the result on the run. Status is untouched; the engine finishes the run afterwards. */
export async function recordEvalResult(paths: LegionFlowPaths, runId: string, result: NonNullable<WorkflowRun["eval"]>, lock: HeldLock): Promise<WorkflowRun> {
  assertHeld(lock, "recordEvalResult");
  const dir = runDir(paths, runId);
  const current = await readRun(dir);
  if (current.kind !== "workflow") throw new TypeError(`recordEvalResult: ${runId} is a ${current.kind} run`);
  const next: WorkflowRun = { ...current, eval: result };
  await writeRun(dir, RunSchema.parse(next));
  return next;
}

/** Workflow runs: finish with a terminal status, or move to awaiting_decision. */
export async function finishRun(
  paths: LegionFlowPaths,
  runId: string,
  patch: { status: WorkflowRun["status"]; reason?: string },
  lock: HeldLock
): Promise<WorkflowRun> {
  assertHeld(lock, "finishRun");
  const dir = runDir(paths, runId);
  const current = await readRun(dir);
  if (current.kind !== "workflow") throw new TypeError(`finishRun: ${runId} is a ${current.kind} run`);
  const terminal = patch.status === "complete" || patch.status === "cancelled" || patch.status === "failed";
  const next: WorkflowRun = {
    ...current,
    status: patch.status,
    ...(patch.reason ? { reason: patch.reason } : {}),
    ...(terminal ? { endedAt: new Date().toISOString() } : {}),
  };
  await writeRun(dir, RunSchema.parse(next));
  return next;
}

/**
 * Evidence files are named by the SHA-256 of their bytes, so a changed file no
 * longer matches its name. When `producedBy` is given the entry joins the run's
 * evidence index at once (deduplicated by hash), so a workflow run has an index
 * without a separate pass; a ship evaluation still writes its own index last.
 */
/**
 * One run's evidence index is read, extended, and rewritten. The engine's span
 * exporter and a node can do that concurrently inside the same locked process,
 * so every update to one index file is chained here; without it the later
 * rename wins and the other entry is lost.
 */
const indexQueues = new Map<string, Promise<unknown>>();
function serializeIndex<T>(indexPath: string, work: () => Promise<T>): Promise<T> {
  const previous = indexQueues.get(indexPath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  indexQueues.set(indexPath, tail);
  void tail.then(() => {
    if (indexQueues.get(indexPath) === tail) indexQueues.delete(indexPath);
  });
  return next;
}

export async function writeEvidence(paths: LegionFlowPaths, runId: string, record: unknown, lock: HeldLock, producedBy?: string): Promise<WrittenEvidence> {
  assertHeld(lock, "writeEvidence");
  const bytes = JSON.stringify(record, null, 2) + "\n";
  const hex = sha256Hex(bytes);
  const absolutePath = join(runDir(paths, runId), "evidence", `${hex}.json`);
  await mkdir(join(runDir(paths, runId), "evidence"), { recursive: true });
  await atomicWriteFile(absolutePath, bytes);
  const written = { path: projectRelative(paths, absolutePath), sha256: hex, absolutePath };
  if (producedBy) {
    const indexPath = join(runDir(paths, runId), "evidence-index.json");
    await serializeIndex(indexPath, async () => {
      let entries: EvidenceIndexEntry[] = [];
      try {
        entries = (JSON.parse(await readFile(indexPath, "utf8")) as unknown[]).map((e) => EvidenceIndexEntrySchema.parse(e));
      } catch {
        // no index yet
      }
      if (!entries.some((e) => e.sha256 === hex)) {
        entries.push({ path: written.path, sha256: hex, producedBy });
        await atomicWriteFile(indexPath, JSON.stringify(entries, null, 2) + "\n");
      }
    });
  }
  return written;
}

export async function writeVerdict(paths: LegionFlowPaths, runId: string, verdict: GateVerdict, lock: HeldLock): Promise<string> {
  assertHeld(lock, "writeVerdict");
  const valid = GateVerdictSchema.parse(verdict);
  const absolutePath = join(runDir(paths, runId), "verdicts", `${valid.gateId}.json`);
  await atomicWriteFile(absolutePath, JSON.stringify(valid, null, 2) + "\n");
  return projectRelative(paths, absolutePath);
}

export async function writeEvidenceIndex(paths: LegionFlowPaths, runId: string, entries: EvidenceIndexEntry[], lock: HeldLock): Promise<void> {
  assertHeld(lock, "writeEvidenceIndex");
  const valid = entries.map((e) => EvidenceIndexEntrySchema.parse(e));
  const indexPath = join(runDir(paths, runId), "evidence-index.json");
  await serializeIndex(indexPath, () => atomicWriteFile(indexPath, JSON.stringify(valid, null, 2) + "\n"));
}

// ---- steps: snapshots and the pending-writes journal ----

const stepDir = (paths: LegionFlowPaths, runId: string, seq: number) => join(runDir(paths, runId), "steps", String(seq));

export async function writeSnapshot(paths: LegionFlowPaths, snapshot: StepSnapshot, lock: HeldLock): Promise<string> {
  assertHeld(lock, "writeSnapshot");
  const valid = StepSnapshotSchema.parse(snapshot);
  const dir = stepDir(paths, valid.runId, valid.seq);
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, "snapshot.json");
  await atomicWriteFile(absolutePath, JSON.stringify(valid, null, 2) + "\n");
  return projectRelative(paths, absolutePath);
}

export async function loadSnapshot(paths: LegionFlowPaths, runId: string, seq: number): Promise<StepSnapshot | null> {
  try {
    return StepSnapshotSchema.parse(JSON.parse(await readFile(join(stepDir(paths, runId, seq), "snapshot.json"), "utf8")));
  } catch {
    return null;
  }
}

/** The highest-numbered snapshot, or null when the run has none. */
export async function loadLatestSnapshot(paths: LegionFlowPaths, runId: string): Promise<StepSnapshot | null> {
  let names: string[];
  try {
    names = await readdir(join(runDir(paths, runId), "steps"));
  } catch {
    return null;
  }
  const seqs = names.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isInteger(n)).sort((a, b) => b - a);
  for (const seq of seqs) {
    const snapshot = await loadSnapshot(paths, runId, seq);
    if (snapshot) return snapshot;
  }
  return null;
}

export async function writeJournalEntry(paths: LegionFlowPaths, runId: string, seq: number, entry: JournalEntry, lock: HeldLock): Promise<void> {
  assertHeld(lock, "writeJournalEntry");
  const dir = join(stepDir(paths, runId, seq), "writes");
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, `${entry.node}.json`), JSON.stringify(entry, null, 2) + "\n");
}

/** Journal entries of one step, keyed by node. Empty when the step never started. */
export async function readJournal(paths: LegionFlowPaths, runId: string, seq: number): Promise<Map<string, JournalEntry>> {
  const dir = join(stepDir(paths, runId, seq), "writes");
  const entries = new Map<string, JournalEntry>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return entries;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as JournalEntry;
      entries.set(entry.node, entry);
    } catch {
      // a torn journal file is treated as not written; the node re-runs
    }
  }
  return entries;
}

// ---- reading runs ----

export async function loadRun(paths: LegionFlowPaths, id: string): Promise<LoadedRun | null> {
  const dir = runDir(paths, id);
  let run: Run;
  try {
    run = await readRun(dir);
  } catch {
    return null;
  }
  const verdicts: GateVerdict[] = [];
  try {
    for (const name of (await readdir(join(dir, "verdicts"))).filter((n) => n.endsWith(".json")).sort()) {
      const parsed = GateVerdictSchema.safeParse(JSON.parse(await readFile(join(dir, "verdicts", name), "utf8")));
      if (parsed.success) verdicts.push(parsed.data);
    }
  } catch {
    // no verdicts directory yet
  }
  let evidenceIndex: EvidenceIndexEntry[] = [];
  try {
    const raw = JSON.parse(await readFile(join(dir, "evidence-index.json"), "utf8")) as unknown[];
    evidenceIndex = raw.map((e) => EvidenceIndexEntrySchema.parse(e));
  } catch {
    // no index yet
  }
  return { run, dir, verdicts, evidenceIndex };
}

/** All loadable runs, oldest first. */
export async function listRuns(paths: LegionFlowPaths): Promise<LoadedRun[]> {
  let names: string[];
  try {
    names = await readdir(paths.runsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const runs: LoadedRun[] = [];
  for (const name of names.filter((n) => n.startsWith("run_"))) {
    const loaded = await loadRun(paths, name);
    if (loaded) runs.push(loaded);
  }
  runs.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
  return runs;
}

/** Re-hash every evidence file the index names. The family rule: evidence is re-verified at read time, never trusted. */
export async function verifyRunEvidence(paths: LegionFlowPaths, loaded: LoadedRun): Promise<EvidenceVerification> {
  const result: EvidenceVerification = { ok: true, checked: 0, drifted: [], missing: [] };
  for (const entry of loaded.evidenceIndex) {
    const absolutePath = join(paths.project, ...entry.path.split("/"));
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch {
      result.missing.push(entry.path);
      result.ok = false;
      continue;
    }
    result.checked += 1;
    if (sha256Hex(bytes) !== entry.sha256) {
      result.drifted.push(entry.path);
      result.ok = false;
    }
  }
  return result;
}

// ---- effects ledger and fork invalidations ----

export interface EffectLine {
  seq: number;
  node: string;
  effect: string;
  status: "started" | "done" | "failed" | "unknown_after_crash";
  at: string;
}

/** Append one line to runs/run_<id>/effects.jsonl. Append-only; never rewritten. */
export async function appendEffect(paths: LegionFlowPaths, runId: string, line: EffectLine, lock: HeldLock): Promise<void> {
  assertHeld(lock, "appendEffect");
  const dir = runDir(paths, runId);
  await mkdir(dir, { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(dir, "effects.jsonl"), JSON.stringify(line) + "\n", "utf8");
}

export async function readEffects(paths: LegionFlowPaths, runId: string): Promise<EffectLine[]> {
  try {
    const text = await readFile(join(runDir(paths, runId), "effects.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as EffectLine];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function writeInvalidation(paths: LegionFlowPaths, record: Invalidation, lock: HeldLock): Promise<string> {
  assertHeld(lock, "writeInvalidation");
  const valid = InvalidationSchema.parse(record);
  const path = join(runDir(paths, valid.parentRunId), "invalidations.json");
  let existing: Invalidation[] = [];
  try {
    existing = (JSON.parse(await readFile(path, "utf8")) as unknown[]).map((r) => InvalidationSchema.parse(r));
  } catch {
    // none yet
  }
  await atomicWriteFile(path, JSON.stringify([...existing, valid], null, 2) + "\n");
  return projectRelative(paths, path);
}

export async function readInvalidations(paths: LegionFlowPaths, runId: string): Promise<Invalidation[]> {
  try {
    return (JSON.parse(await readFile(join(runDir(paths, runId), "invalidations.json"), "utf8")) as unknown[]).map((r) => InvalidationSchema.parse(r));
  } catch {
    return [];
  }
}
