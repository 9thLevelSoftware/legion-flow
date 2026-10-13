import type { GateStatus, CheckEvidence } from "@9thlevelsoftware/legion-flow-schema";
import type { TreeMode } from "@9thlevelsoftware/legion-flow-persist";

/**
 * The seams the task workflow runs across. The engine declares them and
 * implements none: `sandbox` provides materializers (how a tree is made and how
 * an argv runs against it), `adapters` provides adapters (which argv), `gates`
 * provides the check runner, and `cli` composes them.
 */

export interface MaterializeInput {
  runId: string;
  sourceRoot: string;
  /** How the checkout is listed; the materialized tree is always listed as `fs`. */
  sourceMode: TreeMode;
}

/** A host path made visible to the agent process, at a guest path under a container, or in place on the host. */
export interface Mount {
  host: string;
  guest: string;
  readonly?: boolean;
}

/** Translates a host path to what the agent process will see. Identity on the host; mount translation under Docker. */
export type PathMapper = (hostPath: string) => string;

export interface ExecSpec {
  /** Resolved in the guest: a path on the host tier, a name on the image's PATH under Docker. */
  command: string;
  args: (map: PathMapper) => string[];
  cwd: (map: PathMapper) => string;
  mounts: Mount[];
  /** Variables set for the agent whose values are secrets or host state. Under Docker only the names travel in the argv; the values are set in the client's environment. */
  env: Record<string, string>;
  /** Declared constants (a placeholder key, a home directory, an opt-out flag). Safe to record, so they travel inline as NAME=value. */
  constants?: Record<string, string>;
  /** The provider base URL the tier fills when a proxy exists: `http://<proxy>:<port>/<alias>` into `envName`. Nothing on the host tier. */
  baseUrl?: { envName: string; alias: string };
  /**
   * M4 slice q: the tier replaces `${NAME}` in the arguments with the value of a declared constant it set (such as
   * LF_TOOLS_URL under Docker), at the point it resolves constants. Never from `env`, which may hold secrets; an
   * unresolved `${NAME}` refuses the run rather than hand the agent a literal placeholder.
   */
  expandArgs?: boolean;
  /** Host path that receives the whole stdout, for parsers; the outcome keeps a tail. */
  stdoutPath?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AdapterOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
  stdoutTail: string;
  stderrTail: string;
  /** What actually ran, for evidence. Under Docker this is the `docker run` argv with env names only. */
  argv?: string[];
  stdoutPath?: string;
  /** Parsed by the adapter from its own output; `unknown` is reported honestly. */
  usage?: AdapterUsage;
  /** What the agent could reach, and what it reached. */
  egress?:
    | { shape: "none" }
    | { shape: "proxy"; url: string; proxyArgv: string[]; logPath: string | null; summary: { requests: number; denied: number; requestBytes: number; responseBytes: number; hosts: string[]; statuses: Record<string, number> } | null };
}

export type AdapterUsage =
  | { known: true; turns: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
  | { known: false; reason: string };

export interface UsageLimits {
  maxTurns?: number;
  costLimitUsd?: number;
}

/** What an adapter can do and report; the engine refuses a limit on a quantity the adapter cannot report. */
export interface CapabilityProfile {
  supportsTools: boolean;
  supportsJsonOutput: boolean;
  reportsUsage: { turns: boolean; tokens: boolean; cost: boolean };
  /** Image the adapter needs under vm-docker. */
  image: string;
}

export type SandboxExec = (spec: ExecSpec) => Promise<AdapterOutcome>;

export interface Materializer {
  /** The tier this materializer honestly is. */
  tier: string;
  materialize(input: MaterializeInput): Promise<{ treeDir: string }>;
  dispose(treeDir: string): Promise<void>;
  /** Run an argv against a materialized tree, the way this tier runs things. */
  exec: SandboxExec;
}

export interface AdapterRunInput {
  runId: string;
  workspaceRoot: string;
  /** The materialized tree the adapter edits. */
  treeDir: string;
  /** The pointer prompt; `brief.json` sits beside it. */
  promptPath: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** How to run the adapter's argv; the adapter never spawns on its own. */
  exec: SandboxExec;
  /** Whether the exec runs in a container (image defaults apply) or on the host (allowlist applies). */
  envMode: "host" | "container";
  /** From project.json adapter.http.model; unset means the vendor default. */
  model?: string;
  /** The file the agent writes beside the prompt when done: summary.md for a task, review.md for a review. */
  outputFile?: string;
  /**
   * The run's tool gateway (M4 slice k). On the host tier the agent gets the URL and
   * the token in its environment (LF_TOOLS_URL, LF_TOOLS_TOKEN); under Docker it
   * reaches the gateway through the egress proxy, which injects the token, so the
   * token is absent here.
   */
  tools?: { url?: string; token?: string; names: string[] };
  limits?: UsageLimits;
}

export interface Adapter {
  id: string;
  profile: CapabilityProfile;
  /** The variable the adapter authenticates with, and the proxy route that carries it when a proxy exists. */
  credential?: { env: string; baseUrlEnv: string; routeAlias: string };
  run(input: AdapterRunInput): Promise<AdapterOutcome>;
}

export interface CheckRunInput {
  cwd: string;
  source: "task" | "receipt" | "eval";
  taskId?: string;
  timeoutMs?: number;
}

export interface CheckRunOutcome {
  status: GateStatus;
  reason: string;
  evidence: CheckEvidence;
}

/** `gates.runCheck` has this shape; the engine takes it as a function so it never imports `gates`. */
export type CheckRunner = (check: string, input: CheckRunInput) => Promise<CheckRunOutcome>;
