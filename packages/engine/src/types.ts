import type { Interrupt, InterruptKind, RiskClass, RiskTier } from "@9thlevelsoftware/legion-flow-schema";
import type { HeldLock } from "@9thlevelsoftware/legion-flow-persist";
import type { Attributes, Tracer } from "@opentelemetry/api";

export type State = Record<string, unknown>;

/** How a field's new value combines with its old one when a step folds node writes. */
export type ReducerSpec =
  | { kind: "overwrite" }
  | { kind: "append" }
  | { kind: "upsertById"; key: string }
  | { kind: "custom"; name: string; reduce: (previous: unknown, next: unknown) => unknown };

export type StateSchema = Record<string, ReducerSpec>;

/** The decision delivered to the node a workflow resumes at. */
export interface ResumeDecision {
  interruptId: string;
  /** approve | reject | edit from a human; skip from onTimeout. */
  decision: "approve" | "reject" | "edit" | "skip";
  editedArgs: Record<string, unknown> | null;
  note: string;
}

export interface NodeContext {
  runId: string;
  seq: number;
  /** Present only on the first step after a resume. */
  decision?: ResumeDecision;
  signal: AbortSignal;
  /** The run's engine lock, for nodes that write evidence or audit events. */
  held: HeldLock;
}

export interface InterruptRequest {
  kind: InterruptKind;
  action: { name: string; riskClass: RiskClass; args: Record<string, unknown> };
  /** Stored as a hashed evidence file and referenced from the interrupt. */
  payload: unknown;
  expiresInMs?: number;
  onTimeout?: Interrupt["onTimeout"];
  resume: { onApprove: string; onReject?: string; onSkip?: string };
}

export interface NodeResult {
  writes?: State;
  /** Nodes to run in the next step; none or empty finishes the run. */
  next?: string[];
  /** Ends the step awaiting a human; the node itself is never re-run. */
  interrupt?: InterruptRequest;
}

export type NodeFn = (state: State, ctx: NodeContext) => Promise<NodeResult> | NodeResult;

export interface RetryPolicy {
  maxAttempts?: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  /** Default: retry anything that is not a deterministic error (type, range, syntax, schema). */
  retryOn?: (error: unknown) => boolean;
}

export interface NodeDefinition {
  run: NodeFn;
  retry?: RetryPolicy;
  /**
   * Names a side effect this node performs (spawning an agent, writing the
   * checkout). The engine ledgers started/done/failed around it and refuses to
   * re-run it after a crash it cannot account for.
   */
  effect?: string;
}

/**
 * A workflow is code. Its fingerprint covers names, the entry node, reducer
 * kinds, and `version`; it cannot see routing decided at runtime, so `version`
 * is the honest knob to bump when node logic changes without renaming anything.
 */
export interface Workflow {
  id: string;
  version: string;
  entry: string;
  state: StateSchema;
  initial?: State;
  nodes: Record<string, NodeDefinition | NodeFn>;
}

/** What the evidence package hands the engine for one run: a tracer and a flush the engine calls at every exit. */
export interface RunTracing {
  tracer: Tracer;
  flush(final: boolean): Promise<void>;
}

export interface RunOptions {
  /** Recorded on the run: the plan task it executes. */
  task?: { planId: string; taskId: string };
  /** Recorded on the run: the coordinator member that runs the task and why (M4 slice j1). */
  member?: import("@9thlevelsoftware/legion-flow-schema").RunMember;
  /** Recorded on the run: a coordinate task's step members, in order (M4 slice m). */
  coordinate?: { steps: import("@9thlevelsoftware/legion-flow-schema").RunMember[] };
  /** Recorded on the run: its part in a broadcast (M4 slice j2). */
  broadcast?: import("@9thlevelsoftware/legion-flow-schema").RunBroadcast;
  /** Built once the run id is known; absent means the API's no-op tracer and no records. */
  tracing?: (runId: string) => RunTracing;
  /** Attributes stamped on every span of the run (task id, acceptance ids, adapter id). Keys outside the pinned list are dropped by the exporter. */
  spanAttributes?: Attributes;
  durability?: "exit" | "async" | "sync";
  /** Forces durability sync at R2 and above. */
  riskTier?: RiskTier;
  input?: State;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type EngineResult =
  | { kind: "complete"; runId: string; seq: number; values: State }
  | { kind: "awaiting_decision"; runId: string; seq: number; interrupt: Interrupt }
  | { kind: "cancelled"; runId: string; seq: number; reason: string }
  | { kind: "failed"; runId: string; seq: number; node: string; error: string }
  | { kind: "refused"; runId?: string; code: string; message: string };
