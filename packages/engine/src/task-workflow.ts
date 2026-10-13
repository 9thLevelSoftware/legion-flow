import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SCHEMA_VERSIONS,
  ProposalSchema,
  matchesAnyPathPattern,
  FileContentEvidenceSchema,
  type AcceptanceCriterion,
  type Plan,
  type PlanTask,
  type Proposal,
  type RiskTier,
  type WorkflowRun,
  type BriefMapContext,
  type BriefMemoryContext,
  type ProposalArchitecture,
  type ProposalImpact,
} from "@9thlevelsoftware/legion-flow-schema";
import { copyTree, fingerprintTree, detectTreeMode, diffTrees, sha256Hex, type LoadedRun, type TreeMode, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import type { Adapter, AdapterOutcome, CheckRunner, Materializer, SandboxExec } from "./ports.js";
import { briefFor, renderPrompt, type PreviousAttempt, type SessionBrief } from "./prompt.js";
import type { NodeContext, State, Workflow } from "./types.js";

export const TASK_WORKFLOW_ID = "task";
export const APPLY_ACTION = "fs.apply_proposal";
const APPLY_EXPIRES_MS = 24 * 60 * 60 * 1000;

export interface TaskPorts {
  ws: Workspace;
  materializer: Materializer;
  adapter: Adapter;
  runCheck: CheckRunner;
  adapterTimeoutMs?: number;
  checkTimeoutMs?: number;
  now?: () => Date;
  /** Whether the adapter runs in a container (image env) or on the host (allowlist env). */
  envMode?: "host" | "container";
  /** Recorded as evidence on the run by the materialize node: the tier's preflight and enforcement report. */
  tierEvidence?: Record<string, unknown>;
  /**
   * Maps the corrected candidate tree (M4 slice a2): rule violations it
   * introduces or resolves against the checkout, and its blast radius. The
   * engine imports neither map nor gates; cli supplies this.
   */
  architecture?: (input: { checkoutRoot: string; treeDir: string; changedPaths: string[] }) => Promise<{ architecture?: ProposalArchitecture; impact?: ProposalImpact }>;
  /** The map's view of the task's files, for the brief. */
  briefContext?: (task: PlanTask) => Promise<BriefMapContext>;
  /** Memory facts about the task's files, for the brief (M4 slice c). */
  briefMemory?: (task: PlanTask) => Promise<BriefMemoryContext>;
  /**
   * Secret values to blank out of the agent's summary before it becomes evidence (M4 slice g):
   * the adapter credential's value, held in memory only and never recorded.
   */
  redactValues?: string[];
  /**
   * Start the run's tool gateway (M4 slice k) for a task that names tools; null when it names none.
   * Called by the spawn node, which stops it after the adapter, whatever happened.
   */
  tools?: (input: { runId: string; task: PlanTask; held: NodeContext["held"]; treeDir: string }) => Promise<ToolSession | null>;
  /**
   * The coordinate strategy (M4 slice m): one runner per step member, prepared before the run moves. `execFor` takes the
   * run id because a step's exec names its container and egress network after the run.
   */
  steps?: Record<string, StepRunner>;
}

/** What a coordinate step needs: its member's adapter, model, tier exec, and the values to blank from its evidence. */
export interface StepRunner {
  adapter: Adapter;
  model?: string;
  envMode: "host" | "container";
  execFor: (runId: string) => SandboxExec;
  redactValues?: string[];
}

/** A running tool gateway for one run. Its token never enters the brief, the prompt, or a record. */
export interface ToolSession {
  /** What the agent passes to its MCP client: the URL (host tier) and token (host tier), or neither under Docker. */
  agent: { url?: string; token?: string };
  /** The exposed tools, `<server>__<tool>`, with their risk class and description, for the brief. */
  exposed: { name: string; riskClass: string; description?: string }[];
  /** Values to blank from evidence: the token. */
  secrets: string[];
  /** `usedBefore` (M4 slice w): calls earlier attempts of the same `execute --retry` spent from this budget. */
  stop(): Promise<{ calls: number; refused: number; budget: number; failedServers: string[]; usedBefore?: number }>;
}

/** The input state `execute` hands the workflow. */
export interface TaskInput {
  workspaceRoot: string;
  planId: string;
  task: PlanTask;
  acceptanceCriteria: AcceptanceCriterion[];
  receiptChecks: string[];
  riskTier: RiskTier;
  model?: string;
  limits?: { maxTurns?: number; costLimitUsd?: number };
  /** Paths no run may write: the browser scripts the plan approved (M4 slice e). */
  protectedPaths?: string[];
  /**
   * Set by `execute --retry` on every attempt but the last (M4 slice g): at R0 a proposal
   * whose checks do not all pass is withheld (nothing applied) so a new attempt can start.
   */
  withholdFailedChecks?: boolean;
  /** A broadcast member (M4 slice j2): the proposal is recorded and never applied, at any tier; the human chooses among members. */
  withholdAlways?: boolean;
  /** The coordinator member doing the task (M4 slice j1), for the brief. */
  member?: { id: string; adapter: string; model?: string; reason: string };
}

/** `withheld` (M4 slice g): an R0 proposal whose checks failed under `execute --retry`, kept as evidence and never applied. */
export type TaskOutcome = "auto_applied" | "applied" | "no_changes" | "rejected" | "withheld";

/** Thrown by a node for a typed, non-retried failure; the message starts with the code. */
export class TaskExecutionError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TaskExecutionError";
  }
}

const NO_RETRY = { maxAttempts: 1 };

/** The shared matcher from schema: exact path, directory prefix ending in /, or a glob. */
const matchesContractPath = matchesAnyPathPattern;

const COORDINATE_EARLIER_MAX = 6;
const COORDINATE_SUMMARY_MAX = 2000;

/** Running usage across every step and round: a limit applies to the total, and any unknown step makes the total unknown. */
export function addStepUsage(total: { turns: number | null; costUsd: number | null; unknown: string | null }, usage: AdapterOutcome["usage"]): void {
  if (!usage || !usage.known) {
    total.unknown ??= usage && !usage.known ? usage.reason : "the adapter reported no usage";
    return;
  }
  total.turns = total.turns === null || usage.turns === null ? null : total.turns + usage.turns;
  total.costUsd = total.costUsd === null || usage.costUsd === null ? null : total.costUsd + usage.costUsd;
}

/**
 * The coordinate strategy (M4 slice m): every declared step in order, in this run's one tree, then (when another round
 * is allowed) the tree is reconciled to the contract and the proposal's own checks run; all passing ends the loop.
 * A step that fails fails the run, naming the step. Usage limits apply to the running total, checked after each step.
 */
async function runCoordinate(ports: TaskPorts, state: State, ctx: NodeContext, input: TaskInput, brief: SessionBrief, promptDir: string, toolSession: ToolSession | null) {
  const plan = input.task.coordinate!;
  if (!ports.steps) throw new TaskExecutionError("coordinate_unavailable", `task ${input.task.id} declares coordinate steps and this run has no step adapters`);
  const treeDir = state.treeDir as string;
  const sourceFiles = state.sourceFiles as Record<string, string>;
  const rounds = plan.maxIterations ?? 1;
  const total = { turns: 0 as number | null, costUsd: 0 as number | null, unknown: null as string | null };
  const earlier: NonNullable<SessionBrief["coordinate"]>["earlier"] = [];
  const outcomes: string[] = [];
  let failing: { check: string; status: string; reason: string }[] = [];
  let roundsRun = 0;
  let stoppedBy: "checks_passed" | "max_iterations" | "single_round" = rounds === 1 ? "single_round" : "max_iterations";
  let toolSummary: Awaited<ReturnType<ToolSession["stop"]>> | null = null;
  const tail = (s: string) => (s.length > 2000 ? s.slice(-2000) : s);
  try {
    for (let round = 1; round <= rounds; round++) {
      roundsRun = round;
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]!;
        const runner = ports.steps[step.member];
        if (!runner) throw new TaskExecutionError("coordinate_unavailable", `no adapter was prepared for step ${i + 1}'s member ${step.member}`);
        const label = `step ${i + 1} of ${plan.steps.length} (${step.member}, ${runner.adapter.id}), round ${round} of ${rounds}`;
        const stepDir = join(promptDir, "steps", `r${round}-s${i + 1}`);
        await mkdir(stepDir, { recursive: true });
        const now = await fingerprintTree(treeDir, { mode: "fs" });
        const stepBrief: SessionBrief = {
          ...brief,
          member: { id: step.member, adapter: runner.adapter.id, ...(runner.model ? { model: runner.model } : {}), reason: `coordinate step ${i + 1} of ${plan.steps.length}` },
          coordinate: { round, rounds, step: i + 1, of: plan.steps.length, role: step.role, earlier: earlier.slice(-COORDINATE_EARLIER_MAX), failingChecks: failing, touchedSoFar: diffTrees(sourceFiles, now.files).map((t) => t.path).slice(0, 50) },
        };
        const promptPath = join(stepDir, "prompt.md");
        await writeFile(promptPath, renderPrompt(stepBrief), "utf8");
        await writeFile(join(stepDir, "brief.json"), JSON.stringify(stepBrief, null, 2) + "\n", "utf8");
        const outcome = await runner.adapter.run({
          runId: ctx.runId,
          workspaceRoot: input.workspaceRoot,
          treeDir,
          promptPath,
          signal: ctx.signal,
          timeoutMs: ports.adapterTimeoutMs ?? 30 * 60 * 1000,
          exec: runner.execFor(ctx.runId),
          envMode: runner.envMode,
          ...(runner.model ? { model: runner.model } : {}),
          ...(input.limits ? { limits: input.limits } : {}),
          ...(toolSession ? { tools: { ...toolSession.agent, names: toolSession.exposed.map((t) => t.name) } } : {}),
        });
        const secretsHere = [...(runner.redactValues ?? []), ...(toolSession?.secrets ?? [])];
        // The next step's exec clears the egress directory, so this step's log is read now.
        let egressLog: { path: string; sha256: string } | null = null;
        if (outcome.egress?.shape === "proxy" && outcome.egress.logPath) {
          const lines = (await readFile(outcome.egress.logPath, "utf8")).split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as unknown);
          const ev = await ports.ws.runs.writeEvidence(ctx.runId, { kind: "egress_log", round, step: i + 1, member: step.member, lines }, ctx.held, "spawn");
          egressLog = { path: ev.path, sha256: ev.sha256 };
        }
        const evidence = await ports.ws.runs.writeEvidence(ctx.runId, { kind: "adapter_outcome", adapter: runner.adapter.id, round, step: i + 1, member: step.member, ...outcome, stdoutTail: redact(tail(outcome.stdoutTail), secretsHere).text, stderrTail: redact(tail(outcome.stderrTail), secretsHere).text, ...(egressLog ? { egressLog } : {}) }, ctx.held, "spawn");
        outcomes.push(evidence.path);
        const summaryBytes = await readFile(join(stepDir, stepBrief.outputFile)).catch(() => null);
        if (summaryBytes) {
          const clean = redact(summaryBytes.subarray(0, AGENT_SUMMARY_MAX_BYTES).toString("utf8"), secretsHere);
          await ports.ws.runs.writeEvidence(ctx.runId, { kind: "agent_summary", adapter: runner.adapter.id, taskId: input.task.id, round, step: i + 1, member: step.member, text: clean.text, bytes: summaryBytes.length, truncated: summaryBytes.length > AGENT_SUMMARY_MAX_BYTES, redactions: clean.count }, ctx.held, "spawn");
          earlier.push({ round, step: i + 1, member: step.member, role: step.role, summary: clean.text.slice(0, COORDINATE_SUMMARY_MAX) });
        }
        if (outcome.timedOut) throw new TaskExecutionError("adapter_timeout", `${label} exceeded its time limit (evidence ${evidence.path})`);
        if (ctx.signal.aborted) throw new TaskExecutionError("adapter_aborted", `${label} was stopped by a signal (evidence ${evidence.path})`);
        if (outcome.spawnError) throw new TaskExecutionError("adapter_failed", `${label} could not be spawned: ${outcome.spawnError}`);
        if (outcome.exitCode !== 0) throw new TaskExecutionError("adapter_failed", `${label} exited ${outcome.exitCode ?? outcome.signal} (evidence ${evidence.path})`);
        addStepUsage(total, outcome.usage);
        const over = usageOverLimit(total.unknown ? { known: false, reason: total.unknown } : { known: true, turns: total.turns, costUsd: total.costUsd }, input.limits);
        if (over) throw new TaskExecutionError("usage_limit_exceeded", `after ${label}, across every step so far: ${over}; nothing is proposed`);
      }
      if (round === rounds) break;
      // Between rounds: the same reconciliation and the same checks the proposal will run; all passing ends the loop.
      const edited = await fingerprintTree(treeDir, { mode: "fs" });
      await restoreOutOfContract(input, treeDir, diffTrees(sourceFiles, edited.files));
      failing = [];
      for (const c of checksFor(input)) {
        const out = await ports.runCheck(c.check, { cwd: treeDir, source: c.source, taskId: input.task.id, timeoutMs: ports.checkTimeoutMs });
        await ports.ws.runs.writeEvidence(ctx.runId, { ...out.evidence, round }, ctx.held, "spawn");
        if (out.status !== "satisfied") failing.push({ check: c.check, status: out.status, reason: tail(out.reason).slice(0, 1000) });
      }
      if (failing.length === 0) {
        stoppedBy = "checks_passed";
        break;
      }
    }
  } finally {
    // Recorded even when a step failed: the calls happened either way.
    if (toolSession) {
      toolSummary = await toolSession.stop();
      await ports.ws.audit.append({ type: "tool_calls", runId: ctx.runId, taskId: input.task.id, ...toolSummary }, ctx.held);
    }
  }
  await ports.ws.audit.append({ type: "coordinate_finished", runId: ctx.runId, taskId: input.task.id, steps: plan.steps.length, rounds: roundsRun, maxIterations: rounds, stoppedBy }, ctx.held);
  return { writes: { adapterEvidence: outcomes.at(-1)!, coordinate: { rounds: roundsRun, stoppedBy, outcomes }, log: `coordinate: ${plan.steps.length} step(s) x ${roundsRun} round(s)` }, next: ["propose"] };
}

/** Every check a proposal runs: the task's, then the plan receipt's. The coordinate rounds use the same list. */
export function checksFor(input: Pick<TaskInput, "task" | "receiptChecks">): { check: string; source: "task" | "receipt" }[] {
  return [...input.task.contract.verificationCommands.map((check) => ({ check, source: "task" as const })), ...input.receiptChecks.map((check) => ({ check, source: "receipt" as const }))];
}

/** Restore every touched path outside the contract to the checkout's bytes (or remove it), in place; return what was kept. */
export async function restoreOutOfContract<T extends { path: string; before: string | null }>(input: Pick<TaskInput, "task" | "protectedPaths" | "workspaceRoot">, treeDir: string, touched: readonly T[]): Promise<{ kept: T[]; reverted: { path: string; reason: string }[] }> {
  const reverted: { path: string; reason: string }[] = [];
  const kept: T[] = [];
  for (const t of touched) {
    const reason = contractViolation(t.path, input.task, input.protectedPaths ?? []);
    if (!reason) {
      kept.push(t);
      continue;
    }
    reverted.push({ path: t.path, reason });
    const inTree = join(treeDir, ...t.path.split("/"));
    if (t.before === null) {
      await rm(inTree, { force: true });
    } else {
      await mkdir(dirname(inTree), { recursive: true });
      await copyFile(join(input.workspaceRoot, ...t.path.split("/")), inTree);
    }
  }
  return { kept, reverted };
}

/** Why a touched path is outside the task's contract, or null when it is inside. */
export function contractViolation(path: string, task: PlanTask, protectedPaths: readonly string[] = []): string | null {
  if (path === ".legion-flow" || path.startsWith(".legion-flow/")) return "control artifacts under .legion-flow/ are never writable by a run";
  if (protectedPaths.includes(path)) return "an approved browser check script is frozen with the plan and never writable by a run";
  if (matchesContractPath(path, task.contract.filesForbidden)) return "matches filesForbidden";
  if (!matchesContractPath(path, task.contract.filesAllowed)) return "not in filesAllowed";
  return null;
}

/**
 * Whether two contracts could touch the same path. Conservative: each pattern's
 * literal prefix (everything before its first * or ?) is compared, and two
 * contracts conflict when one prefix starts with the other. When unsure, they
 * conflict, and the tasks run in separate batches.
 */
export function contractsMayOverlap(a: readonly string[], b: readonly string[]): string | null {
  const literal = (p: string) => {
    const at = p.search(/[*?]/);
    return at < 0 ? p : p.slice(0, at);
  };
  for (const x of a) {
    for (const y of b) {
      const lx = literal(x);
      const ly = literal(y);
      if (lx.startsWith(ly) || ly.startsWith(lx)) return `${x} and ${y}`;
    }
  }
  return null;
}

/**
 * Up to `max` tasks to run together: unapplied, every dependency already
 * applied, and contracts that cannot overlap. Plan order decides; a task whose
 * contract may overlap an earlier pick waits for a later batch.
 */
export function selectBatch(plan: Plan, runs: readonly LoadedRun[], max: number): { tasks: PlanTask[]; deferred: { taskId: string; reason: string }[] } {
  const applied = appliedTaskIds(plan.id, runs);
  const tasks: PlanTask[] = [];
  const deferred: { taskId: string; reason: string }[] = [];
  for (const t of plan.tasks) {
    if (applied.has(t.id)) continue;
    if (!(t.dependsOn ?? []).every((d) => applied.has(d))) {
      const inBatch = (t.dependsOn ?? []).filter((d) => tasks.some((p) => p.id === d));
      if (inBatch.length > 0) deferred.push({ taskId: t.id, reason: `it depends on ${inBatch.join(", ")}, in this batch` });
      continue;
    }
    if (tasks.length >= max) break;
    const clash = tasks.map((p) => ({ p, overlap: contractsMayOverlap(t.contract.filesAllowed, p.contract.filesAllowed) })).find((x) => x.overlap);
    if (clash) {
      deferred.push({ taskId: t.id, reason: `its contract may overlap ${clash.p.id} (${clash.overlap})` });
      continue;
    }
    tasks.push(t);
  }
  return { tasks, deferred };
}

export type NextTaskSelection =
  | { kind: "task"; task: PlanTask }
  | { kind: "all_applied" }
  | { kind: "blocked"; remaining: string[]; reason: string };

/** Applied task ids for a plan, read from run records. */
export function appliedTaskIds(planId: string, runs: readonly LoadedRun[]): Set<string> {
  const ids = new Set<string>();
  for (const r of runs) {
    if (r.run.kind === "workflow" && r.run.task?.planId === planId && r.run.applied) ids.add(r.run.task.taskId);
  }
  return ids;
}

/** The first task in plan order whose dependencies are applied and which is not. */
export function selectNextTask(plan: Plan, runs: readonly LoadedRun[], requested?: string): NextTaskSelection {
  const applied = appliedTaskIds(plan.id, runs);
  const remaining = plan.tasks.filter((t) => !applied.has(t.id));
  if (remaining.length === 0) return { kind: "all_applied" };
  const candidates = requested ? remaining.filter((t) => t.id === requested) : remaining;
  for (const task of candidates) {
    const missing = task.dependsOn.filter((d) => !applied.has(d));
    if (missing.length === 0) return { kind: "task", task };
    if (requested) return { kind: "blocked", remaining: remaining.map((t) => t.id), reason: `${task.id} depends on unapplied ${missing.join(", ")}` };
  }
  return { kind: "blocked", remaining: remaining.map((t) => t.id), reason: "every remaining task depends on another remaining task" };
}

const tail = (s: string, n = 2000) => (s.length > n ? s.slice(-n) : s);

/** The cap on a stored agent summary (M4 slice g). */
export const AGENT_SUMMARY_MAX_BYTES = 64 * 1024;

/** The typed code inside a failed run's reason (`<node>: <code>: <detail>`), or null. */
export function failureCode(reason: string | undefined): string | null {
  const m = /^[a-z_]+: ([a-z_]+): /.exec(reason ?? "");
  return m ? m[1]! : null;
}

/**
 * Up to three earlier runs of a task that did not land, newest first (M4 slice g): failed,
 * cancelled, rejected, or withheld. Read from our own run records and snapshots only.
 */
export async function previousAttemptsFor(ws: Workspace, planId: string, taskId: string, excludeRunId?: string, max = 3): Promise<PreviousAttempt[]> {
  const out: PreviousAttempt[] = [];
  const runs = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.workflowId === TASK_WORKFLOW_ID && r.run.task?.planId === planId && r.run.task.taskId === taskId && r.run.id !== excludeRunId);
  for (const r of runs.reverse()) {
    if (out.length >= max) break;
    const run = r.run as WorkflowRun;
    if (run.status === "running" || run.status === "awaiting_decision" || run.broadcast?.role === "member") continue;
    const values = (await ws.runs.loadLatestSnapshot(run.id))?.values as Record<string, unknown> | undefined;
    const proposal = values?.proposal as Proposal | undefined;
    const outcome = run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : values?.outcome === "rejected" ? "rejected" : values?.outcome === "withheld" ? "withheld" : null;
    if (!outcome) continue;
    out.push({
      runId: run.id,
      startedAt: run.startedAt,
      outcome,
      code: (outcome === "failed" ? failureCode(run.reason) : null) ?? (outcome === "cancelled" ? run.reason ?? "cancelled" : outcome),
      checks: (proposal?.verification.results ?? []).map((c) => ({ check: c.check.slice(0, 200), status: c.status, reason: (c.reason ?? "").slice(0, 200) })),
    });
  }
  return out;
}

/** Blank every listed secret value (eight characters or more) out of a text. */
export function redact(text: string, values: readonly string[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const v of values) {
    if (v.length < 8) continue;
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join("[redacted]");
  }
  return { text: out, count };
}

/** The first exceeded limit, as a sentence, or null. An unknown usage with a limit set is itself a violation: unbounded is never silent. */
export function usageOverLimit(usage: { known: true; turns: number | null; costUsd: number | null } | { known: false; reason: string } | undefined, limits: { maxTurns?: number; costLimitUsd?: number } | undefined): string | null {
  if (!limits || (limits.maxTurns === undefined && limits.costLimitUsd === undefined)) return null;
  if (!usage || !usage.known) return `a usage limit is set but the adapter reported no usage (${usage ? usage.reason : "nothing parsed"})`;
  if (limits.maxTurns !== undefined && usage.turns !== null && usage.turns > limits.maxTurns) return `${usage.turns} turns exceeds maxTurns ${limits.maxTurns}`;
  if (limits.costLimitUsd !== undefined && usage.costUsd !== null && usage.costUsd > limits.costLimitUsd) return `cost ${usage.costUsd} USD exceeds costLimitUsd ${limits.costLimitUsd}`;
  return null;
}

/**
 * The execute workflow. Nodes: materialize a tree, spawn the adapter against
 * it, propose (reconcile out-of-contract edits back to the source, run the
 * checks in the corrected tree, record the proposal), then apply (R0, or after
 * an approve decision) or abandon (after a reject). Every node runs once; a
 * failure is a typed reason on the run, never a retry of a side effect.
 */
export function taskWorkflow(ports: TaskPorts): Workflow {
  const now = ports.now ?? (() => new Date());
  const paths = ports.ws.paths;

  const dispose = async (state: State) => {
    const treeDir = state.treeDir as string | undefined;
    if (treeDir) await ports.materializer.dispose(treeDir);
  };

  return {
    id: TASK_WORKFLOW_ID,
    // Version 5 on purpose through slice (m): the graph is unchanged, and a task without `coordinate` takes exactly the
    // path it took before, so a pending apply decision recorded before slice m still resumes.
    version: "5",
    entry: "materialize",
    state: { log: { kind: "append" } },
    nodes: {
      materialize: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as TaskInput;
          const sourceMode: TreeMode = await detectTreeMode(input.workspaceRoot);
          const source = await fingerprintTree(input.workspaceRoot, { mode: sourceMode });
          const { treeDir } = await ports.materializer.materialize({ runId: ctx.runId, sourceRoot: input.workspaceRoot, sourceMode });
          const copy = await fingerprintTree(treeDir, { mode: "fs" });
          if (copy.fingerprint !== source.fingerprint) {
            await ports.materializer.dispose(treeDir);
            throw new TaskExecutionError("materialize_mismatch", `the materialized tree (${copy.fingerprint}) does not match the checkout listed in ${sourceMode} mode (${source.fingerprint})`);
          }
          const writes: State = { treeDir, treeMode: sourceMode, treeFingerprint: source.fingerprint, sourceFiles: source.files, materializedAt: now().toISOString(), log: `materialized (${sourceMode} listing, ${Object.keys(source.files).length} files)` };
          if (ports.tierEvidence) {
            const ev = await ports.ws.runs.writeEvidence(ctx.runId, { kind: "sandbox_tier", tier: ports.materializer.tier, ...ports.tierEvidence }, ctx.held, "materialize");
            writes.tierEvidence = ev.path;
          }
          await ports.ws.audit.append(
            { type: "execution_started", runId: ctx.runId, taskId: input.task.id, planId: input.planId, tier: ports.materializer.tier, adapter: ports.adapter.id, treeMode: sourceMode, treeFingerprint: source.fingerprint },
            ctx.held
          );
          return { writes, next: ["spawn"] };
        },
      },

      spawn: {
        retry: NO_RETRY,
        effect: "adapter_spawn",
        run: async (state, ctx) => {
          const input = state as unknown as TaskInput;
          const treeDir = state.treeDir as string;
          const promptDir = join(paths.cacheRunsDir, ctx.runId);
          await mkdir(promptDir, { recursive: true });
          const brief = briefFor(ctx.runId, input.task, input.acceptanceCriteria);
          if (ports.briefContext) brief.mapContext = await ports.briefContext(input.task);
          if (ports.briefMemory) brief.memoryContext = await ports.briefMemory(input.task);
          const toolSession = ports.tools ? await ports.tools({ runId: ctx.runId, task: input.task, held: ctx.held, treeDir }).catch((err: unknown) => {
            throw new TaskExecutionError("tool_gateway_failed", (err as Error).message);
          }) : null;
          if (toolSession) brief.tools = toolSession.exposed;
          if (input.member) brief.member = { id: input.member.id, adapter: input.member.adapter, ...(input.member.model ? { model: input.member.model } : {}), reason: input.member.reason };
          const attempts = await previousAttemptsFor(ports.ws, input.planId, input.task.id, ctx.runId);
          if (attempts.length) brief.previousAttempts = attempts;
          if (input.task.coordinate) return runCoordinate(ports, state, ctx, input, brief, promptDir, toolSession);
          const promptPath = join(promptDir, "prompt.md");
          await writeFile(promptPath, renderPrompt(brief), "utf8");
          await writeFile(join(promptDir, "brief.json"), JSON.stringify(brief, null, 2) + "\n", "utf8");

          let outcome: Awaited<ReturnType<typeof ports.adapter.run>>;
          let toolSummary: Awaited<ReturnType<ToolSession["stop"]>> | null = null;
          try {
            outcome = await ports.adapter.run({
              runId: ctx.runId,
              workspaceRoot: input.workspaceRoot,
              treeDir,
              promptPath,
              signal: ctx.signal,
              timeoutMs: ports.adapterTimeoutMs ?? 30 * 60 * 1000,
              exec: ports.materializer.exec,
              envMode: ports.envMode ?? "host",
              ...(input.model ? { model: input.model } : {}),
              ...(input.limits ? { limits: input.limits } : {}),
              ...(toolSession ? { tools: { ...toolSession.agent, names: toolSession.exposed.map((t) => t.name) } } : {}),
            });
          } finally {
            if (toolSession) toolSummary = await toolSession.stop();
          }
          if (toolSession && toolSummary) await ports.ws.audit.append({ type: "tool_calls", runId: ctx.runId, taskId: input.task.id, ...toolSummary }, ctx.held);
          const secretsHere = [...(ports.redactValues ?? []), ...(toolSession?.secrets ?? [])];
          let egressLog: { path: string; sha256: string } | null = null;
          if (outcome.egress?.shape === "proxy" && outcome.egress.logPath) {
            const lines = (await readFile(outcome.egress.logPath, "utf8")).split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as unknown);
            const ev = await ports.ws.runs.writeEvidence(ctx.runId, { kind: "egress_log", lines }, ctx.held, "spawn");
            egressLog = { path: ev.path, sha256: ev.sha256 };
          }
          const evidence = await ports.ws.runs.writeEvidence(
            ctx.runId,
            { kind: "adapter_outcome", adapter: ports.adapter.id, ...outcome, stdoutTail: redact(tail(outcome.stdoutTail), secretsHere).text, stderrTail: redact(tail(outcome.stderrTail), secretsHere).text, ...(toolSummary ? { tools: toolSummary } : {}), ...(egressLog ? { egressLog } : {}) },
            ctx.held,
            "spawn"
          );
          // The agent's own summary, as unverified evidence (M4 slice g): capped, with the credential's value blanked.
          let summaryRef: { path: string; sha256: string } | null = null;
          const summaryBytes = await readFile(join(promptDir, brief.outputFile)).catch(() => null);
          if (summaryBytes) {
            const truncated = summaryBytes.length > AGENT_SUMMARY_MAX_BYTES;
            const clean = redact(summaryBytes.subarray(0, AGENT_SUMMARY_MAX_BYTES).toString("utf8"), secretsHere);
            const ev = await ports.ws.runs.writeEvidence(ctx.runId, { kind: "agent_summary", adapter: ports.adapter.id, taskId: input.task.id, text: clean.text, bytes: summaryBytes.length, truncated, redactions: clean.count }, ctx.held, "spawn");
            summaryRef = { path: ev.path, sha256: ev.sha256 };
          }
          if (outcome.timedOut) throw new TaskExecutionError("adapter_timeout", `${ports.adapter.id} exceeded its time limit (evidence ${evidence.path})`);
          if (ctx.signal.aborted) throw new TaskExecutionError("adapter_aborted", `${ports.adapter.id} was stopped by a signal (evidence ${evidence.path})`);
          if (outcome.spawnError) throw new TaskExecutionError("adapter_failed", `${ports.adapter.id} could not be spawned: ${outcome.spawnError}`);
          if (outcome.exitCode !== 0) throw new TaskExecutionError("adapter_failed", `${ports.adapter.id} exited ${outcome.exitCode ?? outcome.signal} (evidence ${evidence.path})`);
          const over = usageOverLimit(outcome.usage, input.limits);
          if (over) throw new TaskExecutionError("usage_limit_exceeded", `${over} (evidence ${evidence.path}); nothing is proposed`);
          return { writes: { adapterEvidence: evidence.path, ...(summaryRef ? { summaryEvidence: summaryRef.path } : {}), log: "adapter finished" }, next: ["propose"] };
        },
      },

      propose: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as TaskInput;
          const treeDir = state.treeDir as string;
          const sourceFiles = state.sourceFiles as Record<string, string>;
          const edited = await fingerprintTree(treeDir, { mode: "fs" });
          const touched = diffTrees(sourceFiles, edited.files);

          if (touched.length === 0) {
            await dispose(state);
            return { writes: { outcome: "no_changes" satisfies TaskOutcome, log: "adapter changed nothing" } };
          }
          const max = input.task.contract.maxFilesTouched;
          if (touched.length > max) {
            throw new TaskExecutionError("contract_violation", `${touched.length} files touched, more than maxFilesTouched ${max}: ${touched.slice(0, 5).map((t) => t.path).join(", ")}${touched.length > 5 ? ", ..." : ""}`);
          }

          // Reconcile first: restore every out-of-contract path in the tree, so the checks run on exactly what apply would produce.
          const { kept, reverted } = await restoreOutOfContract(input, treeDir, touched);
          const corrected = await fingerprintTree(treeDir, { mode: "fs" });

          const checks = checksFor(input);
          const results: Proposal["verification"]["results"] = [];
          for (const c of checks) {
            const outcome = await ports.runCheck(c.check, { cwd: treeDir, source: c.source, taskId: input.task.id, timeoutMs: ports.checkTimeoutMs });
            const ev = await ports.ws.runs.writeEvidence(ctx.runId, outcome.evidence, ctx.held, "propose");
            results.push({ check: c.check, source: c.source, status: outcome.status, reason: outcome.reason, evidence: { path: ev.path, sha256: ev.sha256 } });
          }

          const files: Proposal["files"] = [];
          for (const t of kept) {
            let contentRef: Proposal["files"][number]["contentRef"] = null;
            if (t.after !== null) {
              const bytes = await readFile(join(treeDir, ...t.path.split("/")));
              const utf8 = bytes.toString("utf8");
              const isUtf8 = Buffer.from(utf8, "utf8").equals(bytes);
              const record = FileContentEvidenceSchema.parse({
                kind: "file_content",
                path: t.path,
                encoding: isUtf8 ? "utf8" : "base64",
                content: isUtf8 ? utf8 : bytes.toString("base64"),
                sha256: sha256Hex(bytes),
              });
              const ev = await ports.ws.runs.writeEvidence(ctx.runId, record, ctx.held, "propose");
              contentRef = { path: ev.path, sha256: ev.sha256 };
            }
            files.push({ path: t.path, before: t.before, after: t.after, contentRef });
          }

          // The map's verdict on the candidate. A failed analysis is not a pass: it only means R0 must ask.
          let mapped: { architecture?: ProposalArchitecture; impact?: ProposalImpact } = {};
          let architectureUnknown: string | null = null;
          if (ports.architecture && files.length > 0) {
            try {
              mapped = await ports.architecture({ checkoutRoot: input.workspaceRoot, treeDir, changedPaths: files.map((f) => f.path) });
            } catch (err: unknown) {
              architectureUnknown = (err as Error).message;
            }
          }

          const proposal = ProposalSchema.parse({
            schema: SCHEMA_VERSIONS.PROPOSAL,
            runId: ctx.runId,
            planId: input.planId,
            taskId: input.task.id,
            adapterId: ports.adapter.id,
            treeMode: state.treeMode as TreeMode,
            treeFingerprint: state.treeFingerprint as string,
            appliedTreeFingerprint: corrected.fingerprint,
            files,
            contractCheck: { touched: touched.length, maxFilesTouched: max, reverted },
            verification: { treeFingerprint: corrected.fingerprint, results },
            summary: `${files.length} file(s) proposed, ${reverted.length} reverted, ${results.filter((r) => r.status === "satisfied").length}/${results.length} check(s) passed${mapped.architecture ? `, ${mapped.architecture.introduced.length} rule violation(s) introduced, ${mapped.architecture.resolved.length} resolved` : ""}`,
            ...(mapped.architecture ? { architecture: mapped.architecture } : {}),
            ...(mapped.impact ? { impact: mapped.impact } : {}),
            createdAt: now().toISOString(),
          } satisfies Proposal);
          const proposalRef = await ports.ws.runs.writeEvidence(ctx.runId, proposal, ctx.held, "propose");
          await ports.ws.audit.append(
            { type: "proposal_recorded", runId: ctx.runId, taskId: input.task.id, proposalSha256: proposalRef.sha256, filesTouched: touched.length, kept: files.length, reverted: reverted.length, checksPassed: results.filter((r) => r.status === "satisfied").length, checks: results.length },
            ctx.held
          );

          const writes = { proposal, proposalRef: { path: proposalRef.path, sha256: proposalRef.sha256 }, log: "proposal recorded" };
          if (files.length === 0) {
            await dispose(state);
            return { writes: { ...writes, outcome: "no_changes" satisfies TaskOutcome, log: "every touched path was out of contract" } };
          }
          // A broadcast member stops here at every tier: the choice among members is a human's (M4 slice j2).
          if (input.withholdAlways) {
            await dispose(state);
            await ports.ws.audit.append({ type: "proposal_withheld", runId: ctx.runId, taskId: input.task.id, proposalSha256: proposalRef.sha256, checksPassed: results.filter((r) => r.status === "satisfied").length, checks: results.length, reason: "broadcast" }, ctx.held);
            return { writes: { ...writes, outcome: "withheld" satisfies TaskOutcome, ...(mapped.architecture ? {} : architectureUnknown ? { architectureUnknown } : {}), log: "proposal withheld for the broadcast choice" } };
          }
          // Under execute --retry (not the last attempt), an R0 proposal with a failing check is withheld so the next attempt can start.
          if (input.withholdFailedChecks && input.riskTier === "R0" && results.some((r) => r.status !== "satisfied")) {
            await dispose(state);
            await ports.ws.audit.append({ type: "proposal_withheld", runId: ctx.runId, taskId: input.task.id, proposalSha256: proposalRef.sha256, checksPassed: results.filter((r) => r.status === "satisfied").length, checks: results.length }, ctx.held);
            return { writes: { ...writes, outcome: "withheld" satisfies TaskOutcome, log: "proposal withheld: a check did not pass, and execute --retry has attempts left" } };
          }
          // R0 applies on its own, except when the proposal breaks an architecture rule (or the check could not run): then a human looks first.
          const introduces = (mapped.architecture?.introduced.length ?? 0) > 0;
          if (input.riskTier === "R0" && !introduces && !architectureUnknown) {
            return { writes, next: ["apply"] };
          }
          if (architectureUnknown) (writes as Record<string, unknown>).log = `proposal recorded; the architecture check could not run (${architectureUnknown}), so it awaits a decision`;
          const createsOrDeletes = files.some((f) => f.before === null || f.after === null);
          return {
            writes,
            interrupt: {
              kind: "approve_action",
              action: { name: APPLY_ACTION, riskClass: createsOrDeletes ? "create_delete" : "edit", args: { taskId: input.task.id, proposalSha256: proposalRef.sha256, files: files.map((f) => f.path) } },
              payload: proposal,
              expiresInMs: APPLY_EXPIRES_MS,
              onTimeout: "cancel",
              resume: { onApprove: "apply", onReject: "abandon" },
            },
          };
        },
      },

      apply: {
        retry: NO_RETRY,
        effect: "apply_proposal",
        run: async (state, ctx) => applyProposal(state, ctx),
      },

      abandon: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as TaskInput;
          const ref = state.proposalRef as { sha256: string };
          await dispose(state);
          await ports.ws.audit.append({ type: "proposal_rejected", runId: ctx.runId, taskId: input.task.id, proposalSha256: ref.sha256, interruptId: ctx.decision?.interruptId ?? null }, ctx.held);
          return { writes: { outcome: "rejected" satisfies TaskOutcome, log: "proposal rejected" } };
        },
      },
    },
  };

  async function applyProposal(state: State, ctx: NodeContext) {
    // One apply at a time per checkout, in the order runs reach this node (parallel runs serialize here).
    return serializeApply(state.workspaceRoot as string, () => applyProposalNow(state, ctx));
  }

  /**
   * Paths changed in the checkout since this run started that other runs applied
   * after it started. A rebase may absorb exactly these, and nothing else.
   */
  async function peerApplied(runId: string, materializedAt: string | undefined): Promise<{ paths: Set<string>; runIds: string[] }> {
    // The same clock as appliedAt (the workflow's), so the comparison holds under an injected clock too.
    const since = materializedAt ?? (await ports.ws.runs.load(runId))?.run.startedAt ?? "";
    const paths = new Set<string>();
    const runIds: string[] = [];
    for (const r of await ports.ws.runs.list()) {
      if (r.run.id === runId || r.run.kind !== "workflow" || !r.run.applied || r.run.applied.appliedAt < since) continue;
      try {
        const p = ProposalSchema.parse(JSON.parse(await readFile(join(r.dir, "evidence", `${r.run.applied.proposalSha256}.json`), "utf8")));
        for (const f of p.files) paths.add(f.path);
        runIds.push(r.run.id);
      } catch {
        // an unreadable peer proposal cannot vouch for any change
      }
    }
    return { paths, runIds: runIds.sort() };
  }

  async function applyProposalNow(state: State, ctx: NodeContext) {
    const input = state as unknown as TaskInput;
    const proposal = ProposalSchema.parse(state.proposal);
    const ref = state.proposalRef as { path: string; sha256: string };

    const treeMode = await detectTreeMode(input.workspaceRoot);
    if (treeMode !== proposal.treeMode) {
      throw new TaskExecutionError("tree_mode_changed", `the checkout is now listed in ${treeMode} mode but the proposal was made in ${proposal.treeMode} mode (a repository was initialized or removed); re-run the task`);
    }
    const current = await fingerprintTree(input.workspaceRoot, { mode: treeMode });
    let expectedAfter = proposal.appliedTreeFingerprint;
    let rebased: { path: string; sha256: string } | null = null;
    if (current.fingerprint !== proposal.treeFingerprint) {
      // The checkout moved. Absorb it only if every change is a peer run's apply (execute --jobs), none touches
      // this proposal's files, and the task's checks pass again in the checkout plus this proposal.
      const sourceFiles = state.sourceFiles as Record<string, string> | undefined;
      if (!sourceFiles) throw new TaskExecutionError("source_changed", `the checkout changed since the tree was materialized (now ${current.fingerprint}, proposed against ${proposal.treeFingerprint}); re-run the task`);
      const moved = diffTrees(sourceFiles, current.files).map((d) => d.path);
      const peers = await peerApplied(ctx.runId, state.materializedAt as string | undefined);
      const foreign = moved.filter((p) => !peers.paths.has(p));
      if (foreign.length > 0) {
        throw new TaskExecutionError("source_changed", `the checkout changed since the tree was materialized, and not only by other runs' applies (${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", ..." : ""}); re-run the task`);
      }
      const mine = new Set(proposal.files.map((f) => f.path));
      const clash = moved.filter((p) => mine.has(p));
      if (clash.length > 0) throw new TaskExecutionError("rebase_conflict", `another run applied ${clash.join(", ")}, which this proposal also changes; re-run the task`);
      const rebaseDir = join(paths.sandboxDir, ctx.runId, "rebase");
      await rm(rebaseDir, { recursive: true, force: true });
      await copyTree(input.workspaceRoot, rebaseDir, { mode: treeMode });
      for (const f of proposal.files) {
        const target = join(rebaseDir, ...f.path.split("/"));
        if (f.after === null) {
          await rm(target, { force: true });
          continue;
        }
        const record = FileContentEvidenceSchema.parse(JSON.parse(await readFile(join(paths.project, ...f.contentRef!.path.split("/")), "utf8")));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(record.content, record.encoding));
      }
      const checks = [...input.task.contract.verificationCommands.map((c) => ({ check: c, source: "task" as const })), ...input.receiptChecks.map((c) => ({ check: c, source: "receipt" as const }))];
      const results: { check: string; status: string; reason: string; evidence: { path: string; sha256: string } }[] = [];
      for (const c of checks) {
        const outcome = await ports.runCheck(c.check, { cwd: rebaseDir, source: c.source, taskId: input.task.id, timeoutMs: ports.checkTimeoutMs });
        const ev = await ports.ws.runs.writeEvidence(ctx.runId, outcome.evidence, ctx.held, "apply");
        results.push({ check: c.check, status: outcome.status, reason: outcome.reason, evidence: { path: ev.path, sha256: ev.sha256 } });
      }
      let introduced: unknown[] = [];
      if (ports.architecture) {
        const mapped = await ports.architecture({ checkoutRoot: input.workspaceRoot, treeDir: rebaseDir, changedPaths: proposal.files.map((f) => f.path) });
        introduced = mapped.architecture?.introduced ?? [];
      }
      const rebasedTree = await fingerprintTree(rebaseDir, { mode: "fs" });
      const record = { kind: "rebase", basedOn: current.fingerprint, proposedAgainst: proposal.treeFingerprint, peers: peers.runIds, absorbed: moved, results, introduced, appliedTreeFingerprint: rebasedTree.fingerprint };
      const ev = await ports.ws.runs.writeEvidence(ctx.runId, record, ctx.held, "apply");
      rebased = { path: ev.path, sha256: ev.sha256 };
      await rm(rebaseDir, { recursive: true, force: true });
      const failed = results.filter((r) => r.status !== "satisfied");
      if (failed.length > 0) throw new TaskExecutionError("rebase_failed", `${failed.length} check(s) failed in the checkout plus this proposal after ${peers.runIds.length} other run(s) applied (${failed[0]!.check}: ${failed[0]!.reason}); nothing was applied (evidence ${ev.path})`);
      if (introduced.length > 0) throw new TaskExecutionError("rebase_failed", `after other runs applied, this proposal would introduce ${introduced.length} architecture rule violation(s); nothing was applied (evidence ${ev.path})`);
      expectedAfter = rebasedTree.fingerprint;
    }
    for (const f of proposal.files) {
      const target = join(input.workspaceRoot, ...f.path.split("/"));
      if (f.after === null) {
        await rm(target, { force: true });
        continue;
      }
      const evidenceBytes = await readFile(join(paths.project, ...f.contentRef!.path.split("/")));
      if (sha256Hex(evidenceBytes) !== f.contentRef!.sha256) {
        throw new TaskExecutionError("evidence_drift", `${f.contentRef!.path} no longer matches its hash; the proposal cannot be trusted`);
      }
      const record = FileContentEvidenceSchema.parse(JSON.parse(evidenceBytes.toString("utf8")));
      const bytes = Buffer.from(record.content, record.encoding);
      if (sha256Hex(bytes) !== f.after) {
        throw new TaskExecutionError("evidence_drift", `content for ${f.path} does not hash to the proposed ${f.after}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const after = await fingerprintTree(input.workspaceRoot, { mode: treeMode });
    if (after.fingerprint !== expectedAfter) {
      throw new TaskExecutionError("apply_mismatch", `the checkout after apply is ${after.fingerprint}, not the expected ${expectedAfter}`);
    }
    const mode: NonNullable<WorkflowRun["applied"]>["mode"] = ctx.decision ? "decided" : "auto";
    await ports.ws.runs.recordApplied(ctx.runId, { proposalSha256: ref.sha256, sourceFingerprint: after.fingerprint, appliedAt: now().toISOString(), mode }, ctx.held);
    await ports.ws.audit.append(
      {
        type: mode === "auto" ? "proposal_auto_applied" : "proposal_applied",
        runId: ctx.runId,
        taskId: input.task.id,
        proposalSha256: ref.sha256,
        sourceFingerprint: after.fingerprint,
        files: proposal.files.length,
        interruptId: ctx.decision?.interruptId ?? null,
        rebase: rebased ? rebased.sha256 : null,
      },
      ctx.held
    );
    await dispose(state);
    return { writes: { outcome: (mode === "auto" ? "auto_applied" : "applied") satisfies TaskOutcome, sourceFingerprint: after.fingerprint, log: "applied" } };
  }
}

const applyQueues = new Map<string, Promise<unknown>>();
/** Applies to one checkout run one at a time, in the order runs reach the apply node. */
function serializeApply<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = applyQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  applyQueues.set(key, tail);
  void tail.then(() => {
    if (applyQueues.get(key) === tail) applyQueues.delete(key);
  });
  return next;
}
