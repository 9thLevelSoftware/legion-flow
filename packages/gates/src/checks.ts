import { runBrowserCheck } from "@9thlevelsoftware/legion-flow-browser";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { SCHEMA_VERSIONS, type CheckEvidence, type GateStatus } from "@9thlevelsoftware/legion-flow-schema";

const execFileAsync = promisify(execFile);

/**
 * Checks run without a shell: one argv per check, spawned directly, output
 * captured as evidence. The only shell that can appear is cmd.exe on Windows,
 * when a command resolves to a .cmd/.bat shim that Node refuses to spawn
 * directly; that path is recorded in the evidence and refuses anything cmd.exe
 * itself would expand.
 */

export const OUTPUT_CAP_BYTES = 1_000_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** Quote-aware split: single and double quotes group, no escaping, no expansion. */
export function tokenizeArgv(check: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of check) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        argv.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) argv.push(current);
  return argv;
}

export interface RunCheckOptions {
  cwd: string;
  source: CheckEvidence["source"];
  taskId?: string;
  timeoutMs?: number;
  /** Test seam: pretend the platform is Windows and resolve shims through this function. */
  resolveWindowsCommand?: (command: string) => Promise<string | null>;
  /** Approved sha256 of each browser script (from the plan receipt); a browser: check without one is unevaluable. */
  browserScripts?: Readonly<Record<string, string>>;
}

export interface CheckOutcome {
  status: GateStatus;
  reason: string;
  evidence: CheckEvidence;
}

interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function capture(): { push(chunk: Buffer): void; text(): string; truncated: boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  const state = {
    truncated: false,
    push(chunk: Buffer) {
      if (size >= OUTPUT_CAP_BYTES) {
        state.truncated = true;
        return;
      }
      const room = OUTPUT_CAP_BYTES - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        state.truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
  return state;
}

function spawnCapture(command: string, args: string[], cwd: string, timeoutMs: number, verbatim = false): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const out = capture();
    const err = capture();
    let child: ReturnType<typeof spawn>;
    try {
      // verbatim: for the cmd.exe path we build the quoted command line ourselves; Node's own
      // Windows argument quoting would escape the quotes cmd.exe /s relies on.
      child = spawn(command, args, { cwd, shell: false, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: unknown) {
      resolve({ exitCode: null, signal: null, timedOut: false, spawnError: String((e as Error).message ?? e), stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: `${e.code ?? "ERR"}: ${e.message}`,
        stdout: out.text(),
        stderr: err.text(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout: out.text(),
        stderr: err.text(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    });
  });
}

/**
 * On Windows, resolve a bare command on PATH. `where` lists every match,
 * including extensionless shell scripts (npm ships one for Git Bash); prefer a
 * file Windows can actually execute: .exe, then .cmd, .bat, .com.
 */
export async function resolveWindowsCommandOnPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { timeout: 10_000 });
    const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const ext of [".exe", ".cmd", ".bat", ".com"]) {
      const match = candidates.find((c) => c.toLowerCase().endsWith(ext));
      if (match) return match;
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

const CMD_EXPANDS = /[%^!]/;

function quoteForCmd(argv: string[]): string {
  // cmd.exe /s strips the outer pair of quotes; each argument is wrapped so spaces survive.
  return '"' + argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ") + '"';
}

export async function runCheck(check: string, options: RunCheckOptions): Promise<CheckOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  if (check.startsWith("browser:")) {
    // A browser check: a deterministic script run by the browser package, not an argv.
    const rel = check.slice("browser:".length).trim();
    const expected = options.browserScripts?.[rel];
    const r = await runBrowserCheck(rel, { cwd: options.cwd, timeoutMs, ...(expected ? { expectedSha256: expected } : {}) });
    return {
      status: r.status,
      reason: r.reason,
      evidence: {
        schema: SCHEMA_VERSIONS.CHECK_EVIDENCE, check, argv: ["browser", rel], cwd: options.cwd, source: options.source, ...(options.taskId ? { taskId: options.taskId } : {}),
        startedAt, endedAt: new Date().toISOString(), exitCode: r.status === "satisfied" ? 0 : r.status === "unsatisfied" ? 1 : null, signal: null, timedOut: false, viaCmdShim: false,
        stdout: r.summary.join("\n"), stderr: "", stdoutTruncated: false, stderrTruncated: false, browser: r.record,
      },
    };
  }
  const argv = tokenizeArgv(check);
  const base = { schema: SCHEMA_VERSIONS.CHECK_EVIDENCE, check, argv, cwd: options.cwd, source: options.source, ...(options.taskId ? { taskId: options.taskId } : {}) } as const;

  const finish = (status: GateStatus, reason: string, result: SpawnResult, viaCmdShim: boolean): CheckOutcome => ({
    status,
    reason,
    evidence: {
      ...base,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(result.spawnError ? { spawnError: result.spawnError } : {}),
      viaCmdShim,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
  });

  const empty: SpawnResult = { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  if (argv.length === 0) {
    return finish("unevaluable", "empty check", { ...empty, spawnError: "empty argv" }, false);
  }

  let command = argv[0]!;
  let shimTarget = command;
  let viaCmdShim = false;
  const isWindows = options.resolveWindowsCommand !== undefined || process.platform === "win32";
  if (isWindows && !/[\\/]/.test(command)) {
    const resolver = options.resolveWindowsCommand ?? resolveWindowsCommandOnPath;
    const resolved = await resolver(command);
    if (resolved === null) {
      return finish("unevaluable", `command '${command}' not found on PATH`, { ...empty, spawnError: `ENOENT: ${command}` }, false);
    }
    if (/\.(cmd|bat)$/i.test(resolved)) {
      if (CMD_EXPANDS.test(check)) {
        return finish(
          "unevaluable",
          `'${command}' is a .cmd shim that must run through cmd.exe, and the check contains a character cmd.exe would expand (% ^ !)`,
          { ...empty, spawnError: "refused: cmd.exe expansion" },
          true
        );
      }
      viaCmdShim = true;
      shimTarget = resolved;
    } else {
      command = resolved;
    }
  }

  const result = viaCmdShim
    ? await spawnCapture("cmd.exe", ["/d", "/s", "/c", quoteForCmd([shimTarget, ...argv.slice(1)])], options.cwd, timeoutMs, true)
    : await spawnCapture(command, argv.slice(1), options.cwd, timeoutMs);

  if (result.spawnError) {
    return finish("unevaluable", `could not run '${command}': ${result.spawnError}`, result, viaCmdShim);
  }
  if (result.timedOut) {
    return finish("unevaluable", `check timed out after ${timeoutMs} ms`, result, viaCmdShim);
  }
  if (result.exitCode === 0) {
    return finish("satisfied", "exit 0", result, viaCmdShim);
  }
  return finish("unsatisfied", result.exitCode === null ? `terminated by ${result.signal}` : `exit ${result.exitCode}`, result, viaCmdShim);
}
