import { SCHEMA_VERSIONS, SPAN_ATTRIBUTES, SPAN_NAMES, type Interrupt, type StepSnapshot } from "@9thlevelsoftware/legion-flow-schema";
import { context, trace, SpanStatusCode, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import {
  fingerprintRecord,
  newId,
  type HeldLock,
  type JournalEntry,
  type LoadedInterrupt,
  type Workspace,
} from "@9thlevelsoftware/legion-flow-persist";
import { applyWrites, describeSchema } from "./reducers.js";
import { withRetry } from "./retry.js";
import type { EngineResult, NodeContext, NodeDefinition, NodeFn, ResumeDecision, RunOptions, RunTracing, State, Workflow } from "./types.js";

const NODE_NAME = /^[a-z][a-z0-9_]*$/;
const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000;

export function workflowFingerprint(workflow: Workflow): string {
  return fingerprintRecord({
    id: workflow.id,
    version: workflow.version,
    entry: workflow.entry,
    nodes: Object.keys(workflow.nodes).sort(),
    state: describeSchema(workflow.state),
  });
}

function nodeDefinition(workflow: Workflow, name: string): NodeDefinition {
  const def = workflow.nodes[name];
  if (!def) throw new TypeError(`workflow ${workflow.id} has no node '${name}'`);
  return typeof def === "function" ? { run: def as NodeFn } : def;
}

interface Hooks {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  signal: AbortSignal;
}

function hooksFrom(options: RunOptions): Hooks {
  return {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: options.random ?? Math.random,
    signal: options.signal ?? new AbortController().signal,
  };
}

function effectiveDurability(options: RunOptions): "exit" | "async" | "sync" {
  // async is accepted and treated as sync at M1: there is no background writer yet.
  const requested = options.durability ?? "sync";
  if (options.riskTier === "R2" || options.riskTier === "R3") return "sync";
  return requested === "async" ? "sync" : requested;
}

interface Position {
  seq: number;
  values: State;
  next: string[];
}

interface DriveContext {
  ws: Workspace;
  workflow: Workflow;
  held: HeldLock;
  runId: string;
  graphFingerprint: string;
  durability: "exit" | "async" | "sync";
  hooks: Hooks;
  tracer: Tracer;
  /** The run span every node and step span parents to; sdk-trace-base has no context manager, so the parent is passed explicitly. */
  runSpan: Span;
  baseAttributes: Attributes;
}

const NO_TRACING: RunTracing = { tracer: trace.getTracer("legion-flow"), flush: async () => {} };

/** Open the run span and build the drive context; the caller owns the final flush. */
function openRun(ws: Workspace, workflow: Workflow, held: HeldLock, runId: string, graphFingerprint: string, durability: DriveContext["durability"], hooks: Hooks, options: RunOptions, phase: string): { d: DriveContext; tracing: RunTracing } {
  const tracing = options.tracing ? options.tracing(runId) : NO_TRACING;
  const baseAttributes: Attributes = {
    [SPAN_ATTRIBUTES.RUN_ID]: runId,
    [SPAN_ATTRIBUTES.WORKFLOW_ID]: workflow.id,
    ...(options.spanAttributes ?? {}),
  };
  const runSpan = tracing.tracer.startSpan(SPAN_NAMES.RUN, { startTime: hooks.now(), attributes: { ...baseAttributes, [SPAN_ATTRIBUTES.OBSERVATION_TYPE]: "run", [SPAN_ATTRIBUTES.OUTCOME]: phase } });
  return { d: { ws, workflow, held, runId, graphFingerprint, durability, hooks, tracer: tracing.tracer, runSpan, baseAttributes }, tracing };
}

/** Finish the run span with the outcome and flush every pending record. Never throws: spans are a copy of what the journal already proves. */
async function closeRun(d: DriveContext, tracing: RunTracing, outcome: string, error?: string): Promise<void> {
  try {
    d.runSpan.setAttribute(SPAN_ATTRIBUTES.OUTCOME, outcome);
    if (error) d.runSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.slice(0, 200) });
    d.runSpan.end(d.hooks.now());
    await tracing.flush(true);
  } catch {
    // evidence copies never fail a run
  }
}

function childContext(d: DriveContext) {
  return trace.setSpan(context.active(), d.runSpan);
}

function snapshotFor(d: DriveContext, pos: Position, source: StepSnapshot["source"], parentSeq: number | null): StepSnapshot {
  return {
    schema: SCHEMA_VERSIONS.STEP_SNAPSHOT,
    runId: d.runId,
    seq: pos.seq,
    parentSeq,
    namespace: "",
    source,
    values: pos.values,
    next: pos.next,
    // Only an interrupting node is recorded as a task at M1; the caller sets it.
    tasks: [],
    graphFingerprint: d.graphFingerprint,
    durability: d.durability,
    createdAt: d.hooks.now().toISOString(),
  };
}

/** Write the position's snapshot unless one already exists there (sync durability or a resume snapshot). */
async function snapshotIfMissing(d: DriveContext, pos: Position, source: StepSnapshot["source"]): Promise<void> {
  if (await d.ws.runs.loadSnapshot(d.runId, pos.seq)) return;
  await d.ws.runs.writeSnapshot(snapshotFor(d, pos, source, pos.seq === 0 ? null : pos.seq - 1), d.held);
}

/** The decision a consumed interrupt delivers, rebuilt from its record so a crash after resume loses nothing. */
function decisionFromInterrupt(li: LoadedInterrupt): { decision: ResumeDecision; routeKey: "onApprove" | "onReject" | "onSkip" | null } | null {
  const interruptId = li.interrupt.id;
  switch (li.effectiveStatus) {
    case "approved":
      return {
        decision: { interruptId, decision: li.decision?.decision === "edit" ? "edit" : "approve", editedArgs: li.decision?.editedArgs ?? null, note: li.decision?.note ?? "" },
        routeKey: "onApprove",
      };
    case "rejected":
      return { decision: { interruptId, decision: "reject", editedArgs: null, note: li.decision?.note ?? "" }, routeKey: "onReject" };
    case "expired": {
      const onTimeout = li.interrupt.onTimeout;
      if (onTimeout === "cancel") return { decision: { interruptId, decision: "reject", editedArgs: null, note: "expired; onTimeout cancel" }, routeKey: null };
      return {
        decision: { interruptId, decision: onTimeout === "skip" ? "skip" : "reject", editedArgs: null, note: `expired; onTimeout ${onTimeout}` },
        routeKey: onTimeout === "skip" ? "onSkip" : "onReject",
      };
    }
    default:
      return null;
  }
}

/**
 * Drive super-steps from a position until the run finishes, pauses on an
 * interrupt, is aborted, or a node fails after its retries. Each node's output
 * is journaled before the step folds, so a crash mid-step never re-runs a node
 * that already succeeded: on re-entry, journaled nodes are replayed, not run.
 */
async function drive(d: DriveContext, start: Position, source: StepSnapshot["source"], decision?: ResumeDecision): Promise<EngineResult> {
  let pos = start;
  let stepSource = source;
  let pendingDecision = decision;

  while (pos.next.length > 0) {
    const seq = pos.seq + 1;
    const journal = await d.ws.runs.readJournal(d.runId, seq);
    const entries: JournalEntry[] = [];

    for (const name of pos.next) {
      const replayed = journal.get(name);
      if (replayed) {
        // A node that journaled and then crashed before its `done` line is accounted for by the journal; close the ledger at replay.
        const def = nodeDefinition(d.workflow, name);
        if (def.effect) {
          const ledger = (await d.ws.runs.readEffects(d.runId)).filter((l) => l.seq === seq && l.node === name);
          const last = ledger[ledger.length - 1];
          if (last && last.status === "started") await d.ws.runs.appendEffect(d.runId, { seq, node: name, effect: def.effect, status: "done", at: d.hooks.now().toISOString() }, d.held);
        }
        entries.push(replayed);
        continue;
      }
      if (d.hooks.signal.aborted) {
        await snapshotIfMissing(d, pos, stepSource);
        await d.ws.runs.finish(d.runId, { status: "cancelled", reason: "aborted" }, d.held);
        return { kind: "cancelled", runId: d.runId, seq: pos.seq, reason: "aborted" };
      }

      const def = nodeDefinition(d.workflow, name);
      const ctx: NodeContext = { runId: d.runId, seq, signal: d.hooks.signal, held: d.held, ...(pendingDecision ? { decision: pendingDecision } : {}) };
      if (def.effect) {
        // An effect node that was started and never journaled, and whose ledger does not say failed, is a crash the
        // engine cannot account for: the side effect may or may not have happened. It is never re-run.
        const ledger = (await d.ws.runs.readEffects(d.runId)).filter((l) => l.seq === seq && l.node === name);
        const last = ledger[ledger.length - 1];
        if (last && last.status !== "failed") {
          const at = d.hooks.now().toISOString();
          await d.ws.runs.appendEffect(d.runId, { seq, node: name, effect: def.effect, status: "unknown_after_crash", at }, d.held);
          const message = `effect_unknown_after_crash: ${def.effect} by node '${name}' was started at ${last.at} and never accounted for; it is not re-run. Start a fresh run.`;
          await snapshotIfMissing(d, pos, stepSource);
          await d.ws.runs.finish(d.runId, { status: "failed", reason: `${name}: ${message}` }, d.held);
          return { kind: "failed", runId: d.runId, seq: pos.seq, node: name, error: message };
        }
        await d.ws.runs.appendEffect(d.runId, { seq, node: name, effect: def.effect, status: "started", at: d.hooks.now().toISOString() }, d.held);
      }
      const nodeSpan = d.tracer.startSpan(
        `${SPAN_NAMES.NODE_PREFIX}${name}`,
        { startTime: d.hooks.now(), attributes: { ...d.baseAttributes, [SPAN_ATTRIBUTES.OBSERVATION_TYPE]: "node", [SPAN_ATTRIBUTES.SEQ]: seq, [SPAN_ATTRIBUTES.NODE]: name, ...(def.effect ? { [SPAN_ATTRIBUTES.EFFECT]: def.effect } : {}) } },
        childContext(d)
      );
      let result;
      try {
        result = await withRetry(() => Promise.resolve(def.run(pos.values, ctx)), def.retry, d.hooks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        nodeSpan.setAttribute(SPAN_ATTRIBUTES.OUTCOME, "failed");
        nodeSpan.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 200) });
        nodeSpan.end(d.hooks.now());
        if (def.effect) await d.ws.runs.appendEffect(d.runId, { seq, node: name, effect: def.effect, status: "failed", at: d.hooks.now().toISOString() }, d.held);
        await snapshotIfMissing(d, pos, stepSource);
        await d.ws.runs.finish(d.runId, { status: "failed", reason: `${name}: ${message}` }, d.held);
        return { kind: "failed", runId: d.runId, seq: pos.seq, node: name, error: message };
      }

      const entry: JournalEntry = { node: name, writes: result.writes ?? {}, next: result.next ?? [] };
      if (result.interrupt) {
        const req = result.interrupt;
        const requestedAt = d.hooks.now();
        const interrupt: Interrupt = {
          schema: SCHEMA_VERSIONS.INTERRUPT,
          id: newId("int"),
          runId: d.runId,
          stepSeq: seq,
          kind: req.kind,
          action: { name: req.action.name, riskClass: req.action.riskClass, argsFingerprint: fingerprintRecord(req.action.args), policyVersion: "risk-policy/v1" },
          payloadRef: { path: "", sha256: "0".repeat(64) }, // filled below once the payload is written
          responseSchema: SCHEMA_VERSIONS.DECISION,
          requestedAt: requestedAt.toISOString(),
          expiresAt: new Date(requestedAt.getTime() + (req.expiresInMs ?? DEFAULT_EXPIRES_MS)).toISOString(),
          onTimeout: req.onTimeout ?? "cancel",
          status: "pending",
          resume: req.resume,
        };
        entry.interrupt = { ...interrupt, payload: req.payload } as unknown as Record<string, unknown>;
      }
      await d.ws.runs.writeJournalEntry(d.runId, seq, entry, d.held);
      // The journal entry is the account of the effect: written before "done", so a crash between the two is safe to replay.
      if (def.effect) await d.ws.runs.appendEffect(d.runId, { seq, node: name, effect: def.effect, status: "done", at: d.hooks.now().toISOString() }, d.held);
      nodeSpan.setAttribute(SPAN_ATTRIBUTES.OUTCOME, result.interrupt ? "interrupt" : "done");
      nodeSpan.end(d.hooks.now());
      entries.push(entry);
    }
    pendingDecision = undefined;
    // The step span is the evidence processor's flush signal: its end means this step's spans may be written.
    const stepSpan = d.tracer.startSpan(SPAN_NAMES.STEP, { startTime: d.hooks.now(), attributes: { ...d.baseAttributes, [SPAN_ATTRIBUTES.OBSERVATION_TYPE]: "step", [SPAN_ATTRIBUTES.SEQ]: seq } }, childContext(d));
    stepSpan.end(d.hooks.now());

    // Fold in node order, then compute the next frontier (deduplicated, order preserved).
    let values = pos.values;
    const nextSet: string[] = [];
    for (const e of entries) {
      values = applyWrites(d.workflow.state, values, e.writes);
      for (const n of e.next) if (!nextSet.includes(n)) nextSet.push(n);
    }
    const interrupting = entries.filter((e) => e.interrupt);
    if (interrupting.length > 1) {
      // Two pauses in one step would leave one of them unrecorded; refuse loudly instead of dropping it.
      const names = interrupting.map((e) => e.node).join(", ");
      const reason = `multiple_interrupts_in_step: ${names} each requested an interrupt in step ${seq}; split them into separate steps`;
      await d.ws.runs.writeSnapshot(snapshotFor(d, pos, stepSource, pos.seq === 0 ? null : pos.seq - 1), d.held);
      await d.ws.runs.finish(d.runId, { status: "failed", reason }, d.held);
      return { kind: "failed", runId: d.runId, seq: pos.seq, node: interrupting[0]!.node, error: reason };
    }
    const withInterrupt = interrupting[0];

    if (withInterrupt) {
      const { payload, ...rest } = withInterrupt.interrupt as unknown as Interrupt & { payload: unknown };
      let interrupt = rest as Interrupt;
      const existing = await d.ws.interrupts.load(d.runId, interrupt.id, d.hooks.now());
      if (existing) {
        interrupt = existing.interrupt;
      } else {
        const evidence = await d.ws.runs.writeEvidence(d.runId, { interruptId: interrupt.id, payload }, d.held, withInterrupt.node);
        interrupt = { ...interrupt, payloadRef: { path: evidence.path, sha256: evidence.sha256 } };
        await d.ws.interrupts.write(d.runId, interrupt, d.held);
      }
      const paused: Position = { seq, values, next: nextSet };
      const snapshot = snapshotFor(d, paused, stepSource, pos.seq);
      snapshot.tasks = [{ id: `t-${withInterrupt.node}`, name: withInterrupt.node, interrupts: [interrupt.id], error: null }];
      await d.ws.runs.writeSnapshot(snapshot, d.held);
      await d.ws.runs.finish(d.runId, { status: "awaiting_decision" }, d.held);
      return { kind: "awaiting_decision", runId: d.runId, seq, interrupt };
    }

    const advanced: Position = { seq, values, next: nextSet };
    if (d.durability === "sync" || nextSet.length === 0) {
      await d.ws.runs.writeSnapshot(snapshotFor(d, advanced, stepSource, pos.seq), d.held);
    }
    pos = advanced;
    stepSource = "loop";
  }

  await d.ws.runs.finish(d.runId, { status: "complete" }, d.held);
  return { kind: "complete", runId: d.runId, seq: pos.seq, values: pos.values };
}

function validateWorkflow(workflow: Workflow): string | null {
  for (const name of Object.keys(workflow.nodes)) {
    if (!NODE_NAME.test(name)) return `node name '${name}' must match ${NODE_NAME} (it becomes a file name)`;
  }
  if (!workflow.nodes[workflow.entry]) return `entry node '${workflow.entry}' is not defined`;
  return null;
}

/** Start a workflow run under the held lock. Returns when it completes, pauses, is aborted, or fails. */
export async function runWorkflow(ws: Workspace, workflow: Workflow, held: HeldLock, options: RunOptions = {}): Promise<EngineResult> {
  const problem = validateWorkflow(workflow);
  if (problem) return { kind: "refused", code: "workflow_invalid", message: problem };

  const hooks = hooksFrom(options);
  const durability = effectiveDurability(options);
  const graphFingerprint = workflowFingerprint(workflow);
  const { run } = await ws.runs.create({ kind: "workflow", workflowId: workflow.id, graphFingerprint, durability, ...(options.task ? { task: options.task } : {}), ...(options.member ? { member: options.member } : {}), ...(options.coordinate ? { coordinate: options.coordinate } : {}), ...(options.broadcast ? { broadcast: options.broadcast } : {}) }, held);
  const { d, tracing } = openRun(ws, workflow, held, run.id, graphFingerprint, durability, hooks, options, "start");

  const values = applyWrites(workflow.state, {}, { ...(workflow.initial ?? {}), ...(options.input ?? {}) });
  const start: Position = { seq: 0, values, next: [workflow.entry] };
  // Seq 0 is always written, whatever the durability, so resume has a base.
  await ws.runs.writeSnapshot(snapshotFor(d, start, "input", null), held);
  return driveAndClose(d, tracing, start, "input");
}

/** drive() with the run span closed and the records flushed on every exit, thrown errors included. */
async function driveAndClose(d: DriveContext, tracing: RunTracing, start: Position, source: StepSnapshot["source"], decision?: ResumeDecision): Promise<EngineResult> {
  let result: EngineResult | undefined;
  try {
    result = await drive(d, start, source, decision);
    return result;
  } finally {
    await closeRun(d, tracing, result ? result.kind : "thrown", result && result.kind === "failed" ? result.error : result && result.kind === "cancelled" ? result.reason : undefined);
  }
}

async function loadWorkflowRun(ws: Workspace, workflow: Workflow, runId: string): Promise<{ ok: true; durability: "exit" | "async" | "sync"; graphFingerprint: string } | { ok: false; result: EngineResult }> {
  const loaded = await ws.runs.load(runId);
  if (!loaded || loaded.run.kind !== "workflow") {
    return { ok: false, result: { kind: "refused", runId, code: "run_not_found", message: `${runId} is not a workflow run` } };
  }
  const current = workflowFingerprint(workflow);
  if (loaded.run.graphFingerprint !== current) {
    return {
      ok: false,
      result: { kind: "refused", runId, code: "graph_changed", message: `run ${runId} was recorded against graph ${loaded.run.graphFingerprint}; the workflow now fingerprints as ${current}. Bump nothing silently: fork or start a new run.` },
    };
  }
  if (loaded.run.workflowId !== workflow.id) {
    return { ok: false, result: { kind: "refused", runId, code: "workflow_mismatch", message: `run ${runId} belongs to workflow ${loaded.run.workflowId}` } };
  }
  return { ok: true, durability: loaded.run.durability, graphFingerprint: loaded.run.graphFingerprint };
}

/**
 * Resume a paused run through one of its interrupts. The decision (or the
 * interrupt's onTimeout, once expired) selects the node to run next; the
 * interrupting node is never re-run, and a consumed interrupt cannot resume twice.
 */
export async function resumeWorkflow(ws: Workspace, workflow: Workflow, runId: string, interruptId: string, held: HeldLock, options: RunOptions = {}): Promise<EngineResult> {
  const check = await loadWorkflowRun(ws, workflow, runId);
  if (!check.ok) return check.result;
  const hooks = hooksFrom(options);
  const now = hooks.now();

  // Refusals write nothing: a refused resume attempt must not grow the run's evidence or the audit chain.
  const li: LoadedInterrupt | null = await ws.interrupts.load(runId, interruptId, now);
  if (!li) return { kind: "refused", runId, code: "interrupt_not_found", message: `${interruptId} is not an interrupt of ${runId}` };
  if (li.interrupt.consumedAt) return { kind: "refused", runId, code: "interrupt_consumed", message: `${interruptId} already resumed the run at ${li.interrupt.consumedAt}` };
  if (!li.interrupt.resume) return { kind: "refused", runId, code: "interrupt_unroutable", message: `${interruptId} names no resume routes` };
  if (li.effectiveStatus === "pending") {
    return { kind: "refused", runId, code: "interrupt_pending", message: `${interruptId} has no decision yet; run 'legion-flow decide ${interruptId} ...'` };
  }
  if (li.effectiveStatus === "cancelled") {
    return { kind: "refused", runId, code: "interrupt_cancelled", message: `${interruptId} was cancelled` };
  }
  const { d, tracing } = openRun(ws, workflow, held, runId, check.graphFingerprint, check.durability, hooks, options, "resume");
  const closed = async <T extends EngineResult>(r: T): Promise<T> => {
    await closeRun(d, tracing, r.kind, r.kind === "refused" ? r.message : r.kind === "cancelled" ? r.reason : undefined);
    return r;
  };

  const routes = li.interrupt.resume;
  const built = decisionFromInterrupt(li)!;
  const decision = built.decision;
  await ws.interrupts.update(runId, interruptId, { status: li.effectiveStatus, consumedAt: now.toISOString() }, held);
  if (li.effectiveStatus === "expired" && built.routeKey === null) {
    const reason = `interrupt ${interruptId} expired; onTimeout cancel`;
    await ws.runs.finish(runId, { status: "cancelled", reason }, held);
    return closed({ kind: "cancelled", runId, seq: li.interrupt.stepSeq, reason });
  }
  const target: string | undefined = built.routeKey === "onSkip" ? routes.onSkip ?? routes.onReject : built.routeKey ? routes[built.routeKey] : undefined;

  const snapshot = await ws.runs.loadLatestSnapshot(runId);
  if (!snapshot) return closed({ kind: "refused", runId, code: "no_snapshot", message: `${runId} has no snapshot to resume from` });

  if (!target) {
    const reason = `interrupt ${interruptId} ${decision.decision}; the workflow names no node for that outcome`;
    await ws.runs.finish(runId, { status: "cancelled", reason }, held);
    return closed({ kind: "cancelled", runId, seq: snapshot.seq, reason });
  }

  await ws.runs.finish(runId, { status: "running" }, held);
  // The paused snapshot's frontier (successors named by the other nodes of the pausing step) still runs, after the resume target.
  // A resume snapshot makes the target durable before anything runs: a crash before the first node's journal
  // entry leaves a position continueRun can re-enter, with the interrupt id recorded so the decision is rebuilt.
  const frontier = [target, ...snapshot.next.filter((n) => n !== target)];
  const resumed: Position = { seq: snapshot.seq + 1, values: snapshot.values as State, next: frontier };
  const resumeSnapshot = snapshotFor(d, resumed, "resume", snapshot.seq);
  resumeSnapshot.tasks = [{ id: `resume-${target}`, name: target, interrupts: [interruptId], error: null }];
  await ws.runs.writeSnapshot(resumeSnapshot, held);
  return driveAndClose(d, tracing, resumed, "loop", decision);
}

/**
 * Re-enter a run that stopped without finishing (a crash, an abort, or a node
 * that failed and has since been fixed). The latest snapshot is the base; a
 * partially journaled step replays its finished nodes and runs only the rest.
 */
export async function continueRun(ws: Workspace, workflow: Workflow, runId: string, held: HeldLock, options: RunOptions = {}): Promise<EngineResult> {
  const check = await loadWorkflowRun(ws, workflow, runId);
  if (!check.ok) return check.result;
  const loaded = (await ws.runs.load(runId))!;
  const aborted = loaded.run.kind === "workflow" && loaded.run.status === "cancelled" && loaded.run.reason === "aborted";
  if (loaded.run.kind === "workflow" && loaded.run.status !== "running" && loaded.run.status !== "failed" && !aborted) {
    return { kind: "refused", runId, code: "run_not_continuable", message: `${runId} is ${loaded.run.status}; only running, failed, or aborted runs continue` };
  }
  const snapshot = await ws.runs.loadLatestSnapshot(runId);
  if (!snapshot) return { kind: "refused", runId, code: "no_snapshot", message: `${runId} has no snapshot to continue from` };
  const hooks = hooksFrom(options);
  const { d, tracing } = openRun(ws, workflow, held, runId, check.graphFingerprint, check.durability, hooks, options, "continue");
  if (snapshot.next.length === 0) {
    await ws.runs.finish(runId, { status: "complete" }, held);
    const r: EngineResult = { kind: "complete", runId, seq: snapshot.seq, values: snapshot.values as State };
    await closeRun(d, tracing, "complete");
    return r;
  }
  let decision: ResumeDecision | undefined;
  const resumedFrom = snapshot.source === "resume" ? snapshot.tasks[0]?.interrupts[0] : undefined;
  if (resumedFrom) {
    const li = await ws.interrupts.load(runId, resumedFrom, hooks.now());
    decision = li ? decisionFromInterrupt(li)?.decision : undefined;
  }
  await ws.runs.finish(runId, { status: "running" }, held);
  return driveAndClose(d, tracing, { seq: snapshot.seq, values: snapshot.values as State, next: snapshot.next }, "loop", decision);
}

/**
 * Fork: a new run that starts from a parent's snapshot, optionally with edited
 * values folded through the reducers. The parent is untouched. The new run is
 * left `running` at its seq 0 (source: update) for continueRun to drive.
 */
export async function forkRun(ws: Workspace, workflow: Workflow, parentRunId: string, seq: number, edits: State | undefined, held: HeldLock, options: RunOptions = {}): Promise<EngineResult> {
  const check = await loadWorkflowRun(ws, workflow, parentRunId);
  if (!check.ok) return check.result;
  const parent = await ws.runs.loadSnapshot(parentRunId, seq);
  if (!parent) return { kind: "refused", runId: parentRunId, code: "snapshot_not_found", message: `${parentRunId} has no snapshot ${seq}` };

  const hooks = hooksFrom(options);
  // A fork is outside task accounting by design (M4 slice r tried otherwise and reverted): it starts `running` and
  // undriven, so carrying the parent's task would make every fork read as open work to phase derivation and
  // run_in_progress. The parent's invalidations.json is the fork's record; a fork verb would decide anything more.
  const { run } = await ws.runs.create(
    { kind: "workflow", workflowId: workflow.id, graphFingerprint: check.graphFingerprint, durability: check.durability, forkedFrom: { runId: parentRunId, seq } },
    held
  );
  const { d, tracing } = openRun(ws, workflow, held, run.id, check.graphFingerprint, check.durability, hooks, options, "fork");
  const edited = edits !== undefined && Object.keys(edits).length > 0;
  const values = edited ? applyWrites(workflow.state, parent.values as State, edits) : (parent.values as State);
  const start: Position = { seq: 0, values, next: parent.next };
  await ws.runs.writeSnapshot(snapshotFor(d, start, "update", null), held);
  // The parent records the fork. An edited fork invalidates ship evaluations made between the parent's apply and now.
  await ws.runs.writeInvalidation({ schema: SCHEMA_VERSIONS.INVALIDATION, parentRunId, forkedTo: run.id, fromSeq: seq, edited, at: hooks.now().toISOString() }, held);
  await closeRun(d, tracing, "forked");
  return { kind: "complete", runId: run.id, seq: 0, values };
}
