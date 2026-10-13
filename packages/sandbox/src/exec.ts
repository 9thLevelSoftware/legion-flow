import { spawnFrozen, type AdapterOutcome, type ExecSpec, type PathMapper, type SandboxExec } from "@9thlevelsoftware/legion-flow-engine";
import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";
import type { DockerCli } from "./docker-cli.js";
import { TOOLS_ROUTE_ALIAS } from "./spawn-policy.js";
import { containerNameFor, hardeningArgs, runImage, type DockerSettings } from "./settings.js";
import { startEgress, type EgressSession } from "./network.js";

export interface DockerExecOptions {
  routes?: readonly EgressRoute[];
  /** The run's cache directory on the host for a run id; mounted on the proxy. */
  runDirFor?: (runId: string) => string;
  egressDistDir?: string;
  /** Secret values by variable name, read from the operator's environment by the caller. */
  secrets?: Readonly<Record<string, string>>;
  now?: () => Date;
}

/**
 * M4 slice q: replace `${NAME}` in the arguments from declared constants only (never env, which may hold secrets).
 * Returns the unresolved names instead of handing the agent a literal placeholder.
 */
export function expandArgv(args: readonly string[], constants: Readonly<Record<string, string>>): { ok: true; args: string[] } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const out = args.map((a) => a.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => (Object.hasOwn(constants, name) ? constants[name]! : (missing.add(name), whole))));
  return missing.size ? { ok: false, missing: [...missing] } : { ok: true, args: out };
}

const unresolved = (argv: string[], missing: string[]): AdapterOutcome => ({ exitCode: null, signal: null, timedOut: false, spawnError: `the arguments name ${missing.map((m) => "${" + m + "}").join(", ")}, which this tier did not set; nothing ran`, stdoutTail: "", stderrTail: "", argv, egress: { shape: "none" } });

/** The unhardened tier: paths are what they are, the allowlisted env is passed as values. */
export const hostExec: SandboxExec = async (spec: ExecSpec): Promise<AdapterOutcome> => {
  const identity: PathMapper = (p) => p;
  let args = spec.args(identity);
  if (spec.expandArgs) {
    const expanded = expandArgv(args, spec.constants ?? {});
    if (!expanded.ok) return unresolved([spec.command, ...args], expanded.missing);
    args = expanded.args;
  }
  // No proxy on the host tier, so no base URL is set: the vendor default applies and the real key is in the environment.
  const outcome = await spawnFrozen({ command: spec.command, args, cwd: spec.cwd(identity), env: { ...spec.env, ...(spec.constants ?? {}) }, signal: spec.signal, timeoutMs: spec.timeoutMs, stdoutPath: spec.stdoutPath });
  return { ...outcome, argv: outcome.argv ?? [spec.command, ...args], egress: { shape: "none" } };
};

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Translate host paths to guest paths by the longest matching mount. */
export function mountMapper(mounts: ExecSpec["mounts"]): PathMapper {
  const sorted = [...mounts].sort((a, b) => normalize(b.host).length - normalize(a.host).length);
  return (hostPath) => {
    const h = normalize(hostPath);
    for (const m of sorted) {
      const base = normalize(m.host);
      if (h === base) return m.guest;
      if (h.startsWith(base + "/")) return m.guest + h.slice(base.length);
    }
    throw new TypeError(`${hostPath} is not under any mount (${mounts.map((m) => m.host).join(", ")})`);
  };
}

/**
 * The vm-docker tier: `docker run` with the hardening set, the spec's mounts
 * as `-v`, env names only as `-e NAME` (values live in the client's
 * environment), the image, then the command in guest terms. Timeout and abort
 * kill the container by name.
 */
export function dockerExec(docker: DockerCli, settings: DockerSettings, runId: string | (() => string), options: DockerExecOptions = {}): SandboxExec {
  return async (spec) => {
    const map = mountMapper(spec.mounts);
    const id = typeof runId === "function" ? runId() : runId;
    const name = containerNameFor(id);
    const routes = options.routes ?? [];
    const now = options.now ?? (() => new Date());

    let egress: EgressSession | null = null;
    const env: Record<string, string> = { ...spec.env };
    if (routes.length > 0) {
      if (!options.runDirFor || !options.egressDistDir) throw new TypeError("dockerExec: routes need runDirFor and egressDistDir");
      egress = await startEgress({ docker, settings, runId: id, runDir: options.runDirFor(id), egressDistDir: options.egressDistDir, routes, secrets: options.secrets ?? {}, now });
      env.LF_EGRESS_URL = egress.url;
    }

    // Declared constants are safe to record and go inline; secrets and host state travel by name with the value in the client env.
    const constants: Record<string, string> = { ...(spec.constants ?? {}) };
    if (egress && spec.baseUrl) constants[spec.baseUrl.envName] = `${egress.url}/${spec.baseUrl.alias}`;
    // The run's tool gateway route (M4 slice k): the agent reaches it through the proxy, which holds the token.
    if (egress && routes.some((r) => r.alias === TOOLS_ROUTE_ALIAS)) constants.LF_TOOLS_URL = `${egress.url}/${TOOLS_ROUTE_ALIAS}/mcp`;
    const argv = [...hardeningArgs(settings, name, { network: egress ? egress.networkName : "none", labels: [`legion-flow.run=${id}`, `legion-flow.created=${now().toISOString()}`] })];
    for (const m of spec.mounts) argv.push("-v", `${m.host}:${m.guest}${m.readonly ? ":ro" : ""}`);
    for (const envName of Object.keys(env)) argv.push("-e", envName);
    for (const [k, v] of Object.entries(constants)) argv.push("-e", `${k}=${v}`);
    let guestArgs = spec.args(map);
    if (spec.expandArgs) {
      const expanded = expandArgv(guestArgs, constants);
      if (!expanded.ok) {
        const stopped = egress ? await egress.stop() : null;
        void stopped;
        return unresolved(["docker", ...argv, spec.command, ...guestArgs], expanded.missing);
      }
      guestArgs = expanded.args;
    }
    argv.push("-w", spec.cwd(map), runImage(settings), spec.command, ...guestArgs);
    await docker.run(["rm", "-f", name], { timeoutMs: 15_000 });
    const result = await docker.run(argv, { timeoutMs: spec.timeoutMs, signal: spec.signal, env, containerName: name, stdoutPath: spec.stdoutPath });
    const stopped = egress ? await egress.stop() : null;
    // A pinned image removed after preflight: Docker refuses (exit 125) and, with --pull never, nothing is fetched.
    const vanished = settings.imageId && result.code === 125 && /no such image/i.test(result.stderr)
      ? `the image ${settings.imageId} that preflight resolved ${settings.image} to is no longer present; it is never pulled (re-run to preflight the current image)`
      : undefined;
    return {
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(result.spawnError ? { spawnError: result.spawnError } : vanished ? { spawnError: vanished } : {}),
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      argv: ["docker", ...argv],
      ...(spec.stdoutPath ? { stdoutPath: spec.stdoutPath } : {}),
      ...(egress
        ? { egress: { shape: "proxy" as const, url: egress.url, proxyArgv: egress.proxyArgv, logPath: stopped?.logPath ?? null, summary: stopped?.summary ?? null } }
        : { egress: { shape: "none" as const } }),
    };
  };
}
