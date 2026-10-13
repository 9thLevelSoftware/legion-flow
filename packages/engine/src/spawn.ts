import { execFile, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AdapterOutcome } from "./ports.js";

const execFileAsync = promisify(execFile);
const TAIL = 4000;
const CMD_EXPANDS = /[%^!]/;

/** POSIX children lead their own process group (M4 slice r) so the whole group can be signalled. */
const OWN_GROUP = process.platform !== "win32";
/** How long a POSIX group gets after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 3000;

/**
 * Kill a child and everything it started. On Windows `child.kill()` ends only the direct child: for a .cmd shim that
 * is cmd.exe, and the vendor CLI behind it lives on, holding the output pipes so 'close' never fires (M4 slice q).
 * taskkill /T /F ends the tree. On Linux and macOS the child was spawned as its own group's leader, so the group gets
 * SIGTERM and, if it has not exited within KILL_GRACE_MS, SIGKILL (M4 slice r): a CLI that ignores SIGTERM cannot
 * keep the pipes open either.
 */
export function killProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean; exitCode?: number | null; signalCode?: NodeJS.Signals | null }): void {
  if (OWN_GROUP && child.pid !== undefined) {
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    group("SIGTERM");
    setTimeout(() => {
      if ((child.exitCode === null || child.exitCode === undefined) && !child.signalCode) group("SIGKILL");
    }, KILL_GRACE_MS).unref();
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    });
    return;
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
}

export interface SpawnFrozenInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  /** When set, the whole stdout is written here (flushed before the outcome resolves); the tail stays on the outcome. */
  stdoutPath?: string;
}

export interface ResolvedCommand {
  command: string;
  /** Windows: the target is a .cmd/.bat shim that must run through cmd.exe. */
  viaCmdShim: boolean;
}

/**
 * On Windows a bare command may resolve to a .cmd shim (npm installs `codex`
 * that way), which spawn without a shell cannot start. Prefer a real
 * executable; fall back to the shim and say so. Paths with a separator or an
 * extension are taken as given.
 */
export async function resolveCommand(command: string, platform: NodeJS.Platform = process.platform): Promise<ResolvedCommand> {
  if (platform !== "win32" || /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return { command, viaCmdShim: /\.(cmd|bat)$/i.test(command) };
  }
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { timeout: 10_000 });
    const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const ext of [".exe", ".com", ".cmd", ".bat"]) {
      const match = candidates.find((c) => c.toLowerCase().endsWith(ext));
      if (match) return { command: match, viaCmdShim: ext === ".cmd" || ext === ".bat" };
    }
    return { command: candidates[0] ?? command, viaCmdShim: false };
  } catch {
    return { command, viaCmdShim: false };
  }
}

function quoteForCmd(argv: readonly string[]): string {
  // cmd.exe /s strips the outer pair of quotes; each argument is wrapped so spaces survive.
  return '"' + argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ") + '"';
}

/**
 * Spawn a frozen argv with no shell (cmd.exe only for a Windows .cmd shim, with
 * our own quoting and a refusal of anything it would expand). The child is
 * killed on timeout and on abort; the outcome says which. Output is kept as a
 * bounded tail, and optionally written whole to `stdoutPath`.
 */
export async function spawnFrozen(input: SpawnFrozenInput): Promise<AdapterOutcome> {
  const resolved = await resolveCommand(input.command);
  let command = resolved.command;
  let args = [...input.args];
  let verbatim = false;
  if (resolved.viaCmdShim) {
    if ([command, ...args].some((a) => CMD_EXPANDS.test(a))) {
      return { exitCode: null, signal: null, timedOut: false, spawnError: `'${input.command}' is a .cmd shim that must run through cmd.exe, and an argument contains a character cmd.exe would expand (% ^ !)`, stdoutTail: "", stderrTail: "" };
    }
    args = ["/d", "/s", "/c", quoteForCmd([command, ...args])];
    command = "cmd.exe";
    verbatim = true;
  }
  let out: WriteStream | null = null;
  if (input.stdoutPath) {
    await mkdir(dirname(input.stdoutPath), { recursive: true });
    out = createWriteStream(input.stdoutPath);
  }
  const argvRecord = [resolved.command, ...input.args];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: AdapterOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      const done = () => resolve({ ...outcome, argv: argvRecord, ...(input.stdoutPath ? { stdoutPath: input.stdoutPath } : {}) });
      if (out) out.end(done);
      else done();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim, detached: OWN_GROUP });
    } catch (err) {
      finish({ exitCode: null, signal: null, timedOut: false, spawnError: (err as Error).message, stdoutTail: "", stderrTail: "" });
      return;
    }
    const kill = () => killProcessTree(child);
    const onAbort = () => kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-TAIL);
      out?.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-TAIL);
    });
    child.on("error", (err) => finish({ exitCode: null, signal: null, timedOut, spawnError: err.message, stdoutTail: stdout, stderrTail: stderr }));
    child.on("close", (code, sig) => finish({ exitCode: code, signal: sig ?? null, timedOut, stdoutTail: stdout, stderrTail: stderr }));
  });
}

/** A long-lived child with stdin and stdout piped, for a protocol such as LSP. */
export interface PipedProcess {
  stdin: import("node:stream").Writable;
  stdout: import("node:stream").Readable;
  stderrTail(): string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): Promise<void>;
  argv: string[];
  /** The child process id, for a tree kill (Windows does not kill grandchildren with the child). */
  pid?: number;
}

/**
 * Spawn a frozen argv with pipes, with the same rules as spawnFrozen: no shell,
 * a Windows .cmd shim through cmd.exe with our own quoting, and a refusal of
 * anything cmd.exe would expand. The caller owns the lifetime and kills it.
 */
export async function spawnPiped(input: { command: string; args: readonly string[]; cwd: string; env: Record<string, string> }): Promise<PipedProcess> {
  const resolved = await resolveCommand(input.command);
  let command = resolved.command;
  let args = [...input.args];
  let verbatim = false;
  if (resolved.viaCmdShim) {
    if ([command, ...args].some((a) => CMD_EXPANDS.test(a))) throw new Error(`'${input.command}' is a .cmd shim that must run through cmd.exe, and an argument contains a character cmd.exe would expand (% ^ !)`);
    args = ["/d", "/s", "/c", quoteForCmd([command, ...args])];
    command = "cmd.exe";
    verbatim = true;
  }
  const child = spawn(command, args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim, detached: OWN_GROUP });
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-TAIL)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", (err) => {
      stderr += `\nspawn failed: ${err.message}`;
      resolve({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
  });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderrTail: () => stderr,
    exited,
    argv: [resolved.command, ...input.args],
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    async kill() {
      killProcessTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}
