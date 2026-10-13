import { spawn } from "node:child_process";
import type { PipedProcess } from "@9thlevelsoftware/legion-flow-engine";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** What the `docker` client answered. `timedOut` is set by us, never inferred from the exit code. */
export interface DockerResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface DockerRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra variables for the client process (values for names passed with `-e NAME`). */
  env?: Record<string, string>;
  /** Called when the client has been asked to stop; the implementation kills the container by name. */
  containerName?: string;
  /** Host path that receives the whole stdout (the agent's output under `docker run`); flushed before the result resolves. */
  stdoutPath?: string;
}

/**
 * The one seam to the Docker client. Preflight and the exec are written against
 * it; tests script it, and the real one spawns `docker` with a client
 * environment of its own (PATH, HOME, DOCKER_* and so on), never the agent's.
 */
export interface DockerCli {
  run(args: readonly string[], options?: DockerRunOptions): Promise<DockerResult>;
  /**
   * Start `docker` with stdin and stdout piped (a `docker run -i` session, e.g.
   * a language server). Killing it removes the container by name, because the
   * client exiting does not stop the container. Optional so scripted fakes
   * that never open a session need not implement it.
   */
  open?(args: readonly string[], options: { env?: Record<string, string>; containerName: string }): PipedProcess;
}

const CLIENT_ENV_NAMES = ["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA"];
const TAIL = 8000;

export function dockerClientEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CLIENT_ENV_NAMES.includes(name) || name.startsWith("DOCKER_")) out[name] = value;
  }
  return out;
}

const KILL_GRACE_MS = 5000;

export const realDockerCli: DockerCli = {
  run(args, options = {}) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const env = { ...dockerClientEnv(), ...(options.env ?? {}) };
      let out: WriteStream | null = null;
      if (options.stdoutPath) {
        mkdirSync(dirname(options.stdoutPath), { recursive: true });
        out = createWriteStream(options.stdoutPath);
      }
      const finish = (result: DockerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        options.signal?.removeEventListener("abort", stop);
        if (out) out.end(() => resolve(result));
        else resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("docker", [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        finish({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: (err as Error).message });
        return;
      }
      /** Stop the container by name (the client exiting does not stop it), then the client after a grace period. */
      const stop = () => {
        if (options.containerName) {
          const killer = spawn("docker", ["kill", options.containerName], { env, stdio: "ignore", windowsHide: true });
          killer.on("error", () => {});
        }
        graceTimer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // already gone
          }
        }, options.containerName ? KILL_GRACE_MS : 0);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-TAIL);
        out?.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-TAIL);
      });
      child.on("error", (err) => finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: err.message }));
      child.on("close", (code, sig) => finish({ code, signal: sig ?? null, stdout, stderr, timedOut }));
    });
  },
  open(args, options) {
    const env = { ...dockerClientEnv(), ...(options.env ?? {}) };
    const child = spawn("docker", [...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-TAIL)));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("error", (err) => {
        stderr += `
spawn failed: ${err.message}`;
        resolve({ code: null, signal: null });
      });
      child.on("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderrTail: () => stderr,
      exited,
      argv: ["docker", ...args],
      async kill() {
        await new Promise<void>((resolve) => {
          const rm = spawn("docker", ["rm", "-f", options.containerName], { env, stdio: "ignore", windowsHide: true });
          rm.on("error", () => resolve());
          rm.on("exit", () => resolve());
        });
        try {
          child.kill();
        } catch {
          // already gone
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS))]);
      },
    };
  },
};
