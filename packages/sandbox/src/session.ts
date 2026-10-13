/**
 * Sessions: a long-lived process with stdin and stdout piped, for a protocol
 * (a language server). The host tier spawns it directly; the vm-docker tier
 * runs it under `docker run -i` with the same hardening set as every other
 * container, no network, and the tree mounted read-only. The caller builds the
 * environment (an allowlist on the host; names only under Docker).
 */
import { spawnPiped, type Mount, type PathMapper, type PipedProcess } from "@9thlevelsoftware/legion-flow-engine";
import type { DockerCli } from "./docker-cli.js";
import { mountMapper } from "./exec.js";
import { hardeningArgs, runImage, type DockerSettings } from "./settings.js";

export interface SessionSpec {
  command: string;
  args: readonly string[];
  /** The host directory the server serves; mounted read-only at `guestRoot` under Docker. */
  root: string;
  env: Record<string, string>;
  extraMounts?: Mount[];
}

export interface OpenedSession extends PipedProcess {
  /** The root as the process sees it: the host path, or the guest path under Docker. */
  serverRoot: string;
}

export type SessionOpener = (spec: SessionSpec) => Promise<OpenedSession>;

export const GUEST_ROOT = "/work";

export const hostSession: SessionOpener = async (spec) => {
  const p = await spawnPiped({ command: spec.command, args: spec.args, cwd: spec.root, env: spec.env });
  return { ...p, serverRoot: spec.root };
};

/**
 * `docker run -i` with the hardening set; the image is the server's own. Env names travel as `-e NAME`, values in the client env.
 * `network` (M4 slice o2) puts the session on a per-run internal network instead of none, for the browser behind its forward proxy.
 */
export function dockerSession(docker: DockerCli, settings: DockerSettings, containerName: string, options: { network?: string } = {}): SessionOpener {
  return async (spec) => {
    if (!docker.open) throw new Error("this Docker client cannot open a session");
    const mounts: Mount[] = [{ host: spec.root, guest: GUEST_ROOT, readonly: true }, ...(spec.extraMounts ?? [])];
    const map: PathMapper = mountMapper(mounts);
    const base = hardeningArgs(settings, containerName, { labels: [`legion-flow.session=${containerName}`], ...(options.network ? { network: options.network } : {}) });
    const argv = [base[0]!, "-i", ...base.slice(1)];
    for (const m of mounts) argv.push("-v", `${m.host}:${m.guest}${m.readonly ? ":ro" : ""}`);
    for (const name of Object.keys(spec.env)) argv.push("-e", name);
    argv.push("-w", map(spec.root), runImage(settings), spec.command, ...spec.args);
    await docker.run(["rm", "-f", containerName], { timeoutMs: 15_000 });
    const p = docker.open(argv, { env: spec.env, containerName });
    return { ...p, serverRoot: GUEST_ROOT };
  };
}
