import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";
import { EGRESS_FORWARD_FILE, EGRESS_LOG_FILE, EGRESS_PORT, EGRESS_READY_FILE, EGRESS_ROUTES_FILE, parseEgressLog, secretRefs, summarizeEgress, type EgressSummary } from "@9thlevelsoftware/legion-flow-egress";
import type { DockerCli } from "./docker-cli.js";
import { GUEST, hardeningArgs, runImage, type DockerSettings } from "./settings.js";

export const networkNameFor = (runId: string) => `lf-net-${runId}`;
/** The proxy's second network: per run and not internal, so the proxy is never a neighbour of other containers on the default bridge. */
export const outboundNetworkNameFor = (runId: string) => `lf-out-${runId}`;
export const proxyNameFor = (runId: string) => `lf-proxy-${runId}`;
export const egressUrlFor = (runId: string) => `http://${proxyNameFor(runId)}:${EGRESS_PORT}`;

export class EgressStartError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EgressStartError";
  }
}

export interface EgressSession {
  networkName: string;
  outboundNetworkName: string;
  proxyName: string;
  /** What the agent sees: http://lf-proxy-<runId>:8080 */
  url: string;
  /** The `docker run` argv of the proxy, env names only, for evidence. */
  proxyArgv: string[];
  stop(): Promise<{ logPath: string | null; summary: EgressSummary | null }>;
}

export interface StartEgressInput {
  docker: DockerCli;
  settings: DockerSettings;
  runId: string;
  /**
   * The proxy's own directory on the host (var/egress/<runId>), mounted read-write at /legion/run on the proxy only.
   * It must not be under any mount the agent has, or the agent could rewrite the egress log before it is hashed.
   */
  runDir: string;
  /** The egress package's dist directory; mounted read-only. */
  egressDistDir: string;
  routes: readonly EgressRoute[];
  /** Resolved secret values by variable name, for the client's environment only. */
  secrets: Readonly<Record<string, string>>;
  /** Forward mode (M4 slice o2): exact hosts a client on the internal network may reach through this proxy by CONNECT or absolute URI. */
  forwardHosts?: readonly string[];
  readyTimeoutMs?: number;
  now?: () => Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-run egress: an internal network (no gateway, so deny-all is structural),
 * a proxy container on it plus a second per-run outbound network (never the
 * shared default bridge), routes on the mounted run
 * directory, secrets only in the proxy's environment. The agent joins the
 * internal network and can reach exactly one name.
 */
export async function startEgress(input: StartEgressInput): Promise<EgressSession> {
  const { docker, runId } = input;
  const networkName = networkNameFor(runId);
  const outboundName = outboundNetworkNameFor(runId);
  const proxyName = proxyNameFor(runId);
  const created = (input.now ?? (() => new Date()))().toISOString();
  const labels = ["--label", `legion-flow.run=${runId}`, "--label", `legion-flow.created=${created}`];

  await docker.run(["rm", "-f", proxyName], { timeoutMs: 15_000 });
  await docker.run(["network", "rm", networkName], { timeoutMs: 15_000 });
  await docker.run(["network", "rm", outboundName], { timeoutMs: 15_000 });
  await mkdir(input.runDir, { recursive: true });
  await rm(join(input.runDir, EGRESS_READY_FILE), { force: true });
  await rm(join(input.runDir, EGRESS_LOG_FILE), { force: true });
  await writeFile(join(input.runDir, EGRESS_ROUTES_FILE), JSON.stringify(input.routes, null, 2) + "\n", "utf8");
  if (input.forwardHosts) await writeFile(join(input.runDir, EGRESS_FORWARD_FILE), JSON.stringify(input.forwardHosts) + "\n", "utf8");
  else await rm(join(input.runDir, EGRESS_FORWARD_FILE), { force: true });

  const net = await docker.run(["network", "create", "--internal", ...labels, networkName], { timeoutMs: 30_000 });
  if (net.code !== 0) throw new EgressStartError("egress_network_failed", `docker network create: ${net.stderr.trim() || net.spawnError || "unknown error"}`);
  const out = await docker.run(["network", "create", ...labels, outboundName], { timeoutMs: 30_000 });
  if (out.code !== 0) {
    await docker.run(["network", "rm", networkName], { timeoutMs: 15_000 });
    throw new EgressStartError("egress_network_failed", `docker network create (outbound): ${out.stderr.trim() || out.spawnError || "unknown error"}`);
  }
  const teardownNetworks = async () => {
    await docker.run(["network", "rm", networkName], { timeoutMs: 15_000 });
    await docker.run(["network", "rm", outboundName], { timeoutMs: 15_000 });
  };

  const refs = secretRefs(input.routes);
  const proxyArgv = [
    ...hardeningArgs(input.settings, proxyName, { network: networkName, detach: true, keep: true, labels: [`legion-flow.run=${runId}`, `legion-flow.created=${created}`] }),
    // The host is reachable by this name on Docker Desktop already; the alias makes a Linux engine agree.
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${input.runDir}:${GUEST.run}`,
    "-v",
    `${input.egressDistDir}:${GUEST.egress}:ro`,
    ...refs.flatMap((name) => ["-e", name]),
    "-e",
    "LF_RUN_DIR",
    runImage(input.settings),
    "node",
    `${GUEST.egress}/proxy-main.js`,
  ];
  const env: Record<string, string> = { LF_RUN_DIR: GUEST.run };
  for (const name of refs) {
    const value = input.secrets[name];
    if (value === undefined) {
      await teardownNetworks();
      throw new EgressStartError("egress_secret_missing", `${name} is not set; the proxy cannot start`);
    }
    env[name] = value;
  }
  const started = await docker.run(proxyArgv, { timeoutMs: 60_000, env });
  if (started.code !== 0) {
    await teardownNetworks();
    throw new EgressStartError("egress_proxy_failed", `docker run (proxy): ${started.stderr.trim() || started.spawnError || "unknown error"}`);
  }
  // The proxy must also reach the outside: its own per-run outbound network, never the shared default bridge.
  const attached = await docker.run(["network", "connect", outboundName, proxyName], { timeoutMs: 30_000 });
  if (attached.code !== 0) {
    await docker.run(["rm", "-f", proxyName], { timeoutMs: 15_000 });
    await teardownNetworks();
    throw new EgressStartError("egress_proxy_failed", `docker network connect ${outboundName}: ${attached.stderr.trim() || "unknown error"}`);
  }

  const deadline = Date.now() + (input.readyTimeoutMs ?? 10_000);
  while (!(await exists(join(input.runDir, EGRESS_READY_FILE)))) {
    if (Date.now() > deadline) {
      const logs = await docker.run(["logs", "--tail", "20", proxyName], { timeoutMs: 15_000 });
      await docker.run(["rm", "-f", proxyName], { timeoutMs: 15_000 });
      await teardownNetworks();
      throw new EgressStartError("egress_proxy_unhealthy", `the proxy did not report ready in time: ${(logs.stderr + logs.stdout).trim().split("\n").slice(-3).join(" | ")}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    networkName,
    outboundNetworkName: outboundName,
    proxyName,
    url: egressUrlFor(runId),
    proxyArgv: ["docker", ...proxyArgv],
    async stop() {
      await docker.run(["rm", "-f", proxyName], { timeoutMs: 30_000 });
      await docker.run(["network", "rm", networkName], { timeoutMs: 30_000 });
      await docker.run(["network", "rm", outboundName], { timeoutMs: 30_000 });
      const logPath = join(input.runDir, EGRESS_LOG_FILE);
      if (!(await exists(logPath))) return { logPath: null, summary: summarizeEgress([]) };
      const lines = parseEgressLog(await readFile(logPath, "utf8"));
      return { logPath, summary: summarizeEgress(lines) };
    },
  };
}

/** Remove networks and containers this tool created for other runs more than `maxAgeMs` ago (a crash cannot pin them forever). */
export async function cleanupStale(docker: DockerCli, now: Date, maxAgeMs = 24 * 60 * 60 * 1000): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const cutoff = now.getTime() - maxAgeMs;
  const containers = await docker.run(["ps", "-a", "--filter", "label=legion-flow.run", "--format", '{{.Names}}|{{.Label "legion-flow.created"}}'], { timeoutMs: 15_000 });
  for (const line of containers.stdout.split("\n")) {
    const [name, created] = line.trim().split("|");
    if (!name) continue;
    const t = Date.parse(created ?? "");
    if (!Number.isFinite(t) || t < cutoff) {
      await docker.run(["rm", "-f", name], { timeoutMs: 15_000 });
      removed.push(name);
    }
  }
  const networks = await docker.run(["network", "ls", "--filter", "label=legion-flow.run", "--format", '{{.Name}}|{{.Label "legion-flow.created"}}'], { timeoutMs: 15_000 });
  for (const line of networks.stdout.split("\n")) {
    const [name, created] = line.trim().split("|");
    if (!name) continue;
    const t = Date.parse(created ?? "");
    if (!Number.isFinite(t) || t < cutoff) {
      await docker.run(["network", "rm", name], { timeoutMs: 15_000 });
      removed.push(name);
    }
  }
  return { removed };
}
