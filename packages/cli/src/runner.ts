import {
  ResultEnvelopeSchema,
  type Diagnostic,
  type ResultEnvelope,
} from "@9thlevelsoftware/legion-flow-schema";
import type { Workspace } from "@9thlevelsoftware/legion-flow-persist";

/**
 * The CLI contract lives here and nowhere else.
 *
 * A command handler is a function from a CommandContext to a ResultEnvelope.
 * It never writes to stdout, never sets an exit code, and never sees --json.
 * The runner validates the envelope, renders it as JSON or text, and maps
 * its status to the process exit code.
 */

export interface CommandContext {
  /** Workspace root the command operates on (usually process.cwd()); for display. */
  cwd: string;
  /** Whether stdin is an interactive terminal. Human-only verbs consult this. */
  isTTY: boolean;
  /** The handle for that root: audit chain, engine lock, project store, paths. */
  workspace: Workspace;
}

export type CommandHandler<Opts = Record<string, unknown>> = (
  ctx: CommandContext,
  opts: Opts
) => Promise<ResultEnvelope>;

export type TextRenderer = (envelope: ResultEnvelope) => string;

/** Output sink. The process adapter is the default; tests supply a capturing one. */
export interface RunnerIo {
  stdout(text: string): void;
  stderr(text: string): void;
  setExitCode(code: number): void;
}

export const processIo: RunnerIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Exit codes by envelope status. 1 is reserved for unexpected errors. */
export const EXIT_CODES = {
  ok: 0,
  ready: 0,
  refused: 2,
  usage_error: 2,
  blocked: 3,
  awaiting_decision: 3,
} as const satisfies Record<ResultEnvelope["status"], number>;

export const EXIT_UNEXPECTED = 1;

export function exitCodeFor(status: ResultEnvelope["status"]): number {
  return EXIT_CODES[status];
}

export class InvalidEnvelopeError extends Error {
  constructor(
    public readonly command: string,
    public readonly issues: string[]
  ) {
    super(`Command '${command}' produced an invalid result envelope: ${issues.join("; ")}`);
    this.name = "InvalidEnvelopeError";
  }
}

const SEVERITY_GLYPH: Record<Diagnostic["severity"], string> = {
  info: "✔",
  warning: "⚠",
  error: "✖",
};

export function renderDiagnostic(diag: Diagnostic): string {
  const lines = [`[${SEVERITY_GLYPH[diag.severity]}] ${diag.code}: ${diag.message}`];
  if (diag.path) {
    lines.push(`    at ${diag.path}`);
  }
  if (diag.hint) {
    // Hints are written as the instruction itself; some already carry the FIX: prefix, and it is never doubled.
    lines.push(`    FIX: ${diag.hint.replace(/^FIX:\s*/, "")}`);
  }
  return lines.join("\n");
}

export function renderNextAction(envelope: ResultEnvelope): string {
  const next = envelope.nextAction;
  switch (next.type) {
    case "command":
      return next.hint ? `Next: ${next.run}\n  ${next.hint}` : `Next: ${next.run}`;
    case "human_decision":
      return `Decision required (${next.decisionKind}): ${next.run}`;
    case "wait":
      return `Wait until ${next.until}: ${next.reason}`;
    case "none":
      return next.reason;
    case "credential_required":
      return `Credential required: set ${next.variable} for the ${next.adapter} adapter\n  ${next.hint}`;
  }
}

const GATE_GLYPH: Record<ResultEnvelope["gates"][number]["status"], string> = {
  satisfied: "✔",
  unsatisfied: "✖",
  unevaluable: "?",
};

export function renderGate(verdict: ResultEnvelope["gates"][number]): string {
  const lines = [`[${GATE_GLYPH[verdict.status]}] gate ${verdict.gateId}: ${verdict.status}, ${verdict.reason}`];
  if (verdict.waiver) {
    lines.push(`    waived by ${verdict.waiver.waivedBy}: ${verdict.waiver.reason}`);
  }
  return lines.join("\n");
}

/** Generic human-readable rendering of any envelope. Commands may override it. */
export function renderText(envelope: ResultEnvelope): string {
  const lines: string[] = [`${envelope.command}: ${envelope.status}`];
  if (envelope.phase !== "uninitialized") {
    lines.push(`Phase: ${envelope.phase}`);
  }
  for (const diag of envelope.diagnostics) {
    lines.push(renderDiagnostic(diag));
  }
  for (const verdict of envelope.gates) {
    lines.push(renderGate(verdict));
  }
  lines.push(renderNextAction(envelope));
  return lines.join("\n");
}

export interface RunCommandOptions {
  json: boolean;
  io?: RunnerIo;
  renderText?: TextRenderer;
  /** Runs after a valid envelope, before rendering (M4 slice l: the hook flush); its diagnostics are appended and never change the status. */
  afterCommand?: (ctx: CommandContext) => Promise<Diagnostic[]>;
}

/**
 * Run a handler and own everything that follows: validation, rendering, exit code.
 * Returns the validated envelope so in-process callers (and tests) can inspect it.
 */
export async function runCommand<Opts>(
  handler: CommandHandler<Opts>,
  ctx: CommandContext,
  opts: Opts,
  options: RunCommandOptions
): Promise<ResultEnvelope> {
  const io = options.io ?? processIo;
  const raw = await handler(ctx, opts);

  const parsed = ResultEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const command = typeof (raw as { command?: unknown })?.command === "string"
      ? (raw as { command: string }).command
      : "<unknown>";
    throw new InvalidEnvelopeError(
      command,
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    );
  }
  const envelope = parsed.data;
  if (options.afterCommand) {
    const extra = await options.afterCommand(ctx).catch((err: unknown): Diagnostic[] => [{ code: "hook_flush_failed", severity: "warning", message: `The hook flush failed: ${(err as Error).message}` }]);
    envelope.diagnostics.push(...extra);
  }

  if (options.json) {
    io.stdout(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    io.stdout((options.renderText ?? renderText)(envelope) + "\n");
  }
  io.setExitCode(exitCodeFor(envelope.status));
  return envelope;
}
