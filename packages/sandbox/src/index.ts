import { join } from "node:path";
import { DEFAULT_TREE_EXCLUDES, type LegionFlowPaths } from "@9thlevelsoftware/legion-flow-persist";
import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";
import type { Materializer, MaterializeInput } from "@9thlevelsoftware/legion-flow-engine";
import { realDockerCli, type DockerCli } from "./docker-cli.js";
import { dockerExec, hostExec } from "./exec.js";
import { strategyFor, type MaterializeStrategy } from "./strategies.js";
import { resolveDockerSettings, type DockerSettings } from "./settings.js";

export { realDockerCli, dockerClientEnv } from "./docker-cli.js";
export type { DockerCli, DockerResult, DockerRunOptions } from "./docker-cli.js";
export { resolveDockerSettings, hardeningArgs, runImage, containerNameFor, GUEST, DEFAULT_DOCKER_IMAGE } from "./settings.js";
export type { DockerSettings } from "./settings.js";
export { dockerPreflight, dockerCheapChecks, IMAGE_IDENTITY_FORMAT } from "./preflight.js";
export type { PreflightReport, PreflightCheck, DockerPreflightInput } from "./preflight.js";
export { hostExec, dockerExec, mountMapper, expandArgv } from "./exec.js";
export type { DockerExecOptions } from "./exec.js";
export { startEgress, cleanupStale, networkNameFor, outboundNetworkNameFor, proxyNameFor, egressUrlFor, EgressStartError } from "./network.js";
export { egressDistDir, secretRefs, validateRoutes } from "@9thlevelsoftware/legion-flow-egress";
export type { EgressSession, StartEgressInput } from "./network.js";
export { copyStrategy, worktreeStrategy, strategyFor, WorktreeUnsupportedError } from "./strategies.js";
export type { TreeStrategy, MaterializeStrategy } from "./strategies.js";

export const SANDBOX_TIER_IDS = ["unhardened", "vm-docker", "jail-bwrap", "jail-seatbelt", "vm-wsl2-hardened", "vm-windows-sandbox", "remote-e2b"] as const;
export type SandboxTierId = (typeof SANDBOX_TIER_IDS)[number];

export interface SandboxTierDefinition {
  id: SandboxTierId;
  title: string;
  /** Whether this build can run it. */
  available: boolean;
  isSandbox: boolean;
}

export const SANDBOX_TIERS: readonly SandboxTierDefinition[] = [
  { id: "unhardened", title: "Copy of the tree, no isolation", available: true, isSandbox: false },
  { id: "vm-docker", title: "Docker, network none, read-only root, hardened flags", available: true, isSandbox: true },
  { id: "jail-bwrap", title: "bubblewrap jail (Linux)", available: false, isSandbox: true },
  { id: "jail-seatbelt", title: "seatbelt jail (macOS)", available: false, isSandbox: true },
  { id: "vm-wsl2-hardened", title: "WSL2 distro with networking off, then bwrap", available: false, isSandbox: true },
  { id: "vm-windows-sandbox", title: "Windows Sandbox, disposable", available: false, isSandbox: true },
  { id: "remote-e2b", title: "E2B sandbox (optional CALL)", available: false, isSandbox: true },
];

/** What a tier does and does not enforce. Reported, never assumed. */
export interface EnforcementReport {
  tier: SandboxTierId;
  isSandbox: boolean;
  filesystemIsolated: boolean;
  networkEnforced: boolean;
  credentialsOutsideAgent: boolean;
  notEnforced: string[];
  caveats: string[];
  docker?: { image: string; user: string; memory: string; cpus: number; pidsLimit: number };
  egress?: { shape: "none" | "proxy"; routes: { alias: string; host: string; port?: number; scheme: string; headers: string[]; refs: string[] }[] };
}

export function enforcementReport(tier: SandboxTierId, settings?: DockerSettings, routes: readonly EgressRoute[] = []): EnforcementReport {
  const deps = `the tree excludes ${DEFAULT_TREE_EXCLUDES.join(", ")}, so a check that needs installed dependencies is unevaluable here`;
  if (tier === "unhardened") {
    return {
      tier,
      isSandbox: false,
      filesystemIsolated: false,
      networkEnforced: false,
      credentialsOutsideAgent: false,
      notEnforced: ["filesystem isolation: the adapter runs as the operator and can write anywhere; only the proposal is contract-checked", "network: unrestricted", "credentials: the adapter's environment holds its own key"],
      caveats: ["this is not a sandbox", deps],
    };
  }
  if (tier === "vm-docker") {
    const s = settings ?? resolveDockerSettings(undefined);
    const shape = routes.length > 0 ? "proxy" : "none";
    const plaintext = routes.filter((r) => r.scheme === "http").map((r) => r.host);
    return {
      tier,
      isSandbox: true,
      filesystemIsolated: true,
      networkEnforced: true,
      credentialsOutsideAgent: true,
      notEnforced: [
        "the bind-mounted tree is writable by design; the FileContract reconciliation remains the write boundary",
        ...(shape === "proxy" ? ["the allowlist is a host rule, not a request rule: the agent may send any path to an allowlisted host"] : []),
      ],
      caveats: [
        "Docker Desktop is itself a Linux VM and the host docker client is trusted",
        "Enhanced Container Isolation licensing is unverified",
        "drive sharing for the workspace is probed on every execute, not assumed",
        shape === "proxy"
          ? `network: an internal network with no gateway; the only reachable name is the proxy, which forwards to ${routes.length} allowlisted host(s); no CONNECT, so tools needing raw TLS cannot run here; the proxy is trusted code in a container that does have egress`
          : "network: --network none; no route exists, so only an adapter that needs no provider (fake) can run",
        shape === "proxy" ? "credentials: set only in the proxy container's environment; the agent holds a placeholder" : "credentials: none are passed",
        ...(plaintext.length > 0 ? [`plaintext upstream (http) for: ${plaintext.join(", ")}`] : []),
        deps,
      ],
      docker: { image: s.image, user: s.user, memory: s.memory, cpus: s.cpus, pidsLimit: s.pidsLimit },
      egress: { shape, routes: routes.map((r) => ({ alias: r.alias, host: r.host, ...(r.port ? { port: r.port } : {}), scheme: r.scheme, headers: r.secrets.map((x) => x.header), refs: r.secrets.map((x) => x.ref.slice(4)) })) },
    };
  }
  return {
    tier,
    isSandbox: true,
    filesystemIsolated: false,
    networkEnforced: false,
    credentialsOutsideAgent: false,
    notEnforced: ["this tier is not available in this build"],
    caveats: ["arrives in a later slice"],
  };
}

export interface CreateMaterializerInput {
  tier: SandboxTierId;
  strategy: MaterializeStrategy;
  paths: LegionFlowPaths;
  runId: string;
  settings?: DockerSettings;
  docker?: DockerCli;
  routes?: readonly EgressRoute[];
  egressDistDir?: string;
  secrets?: Readonly<Record<string, string>>;
  now?: () => Date;
}

/** A materializer is a tree strategy (how the tree is made) plus a tier's exec (how an argv runs against it). */
export function createMaterializer(input: CreateMaterializerInput): Materializer | null {
  const strategy = strategyFor(input.strategy, input.paths);
  // The container is named after the run; materialize learns the id, so a materializer built before the run exists still names it right.
  let currentRunId = input.runId;
  const materialize = async (i: MaterializeInput) => {
    currentRunId = i.runId;
    return strategy.materialize(i);
  };
  if (input.tier === "unhardened") {
    return { tier: "unhardened", materialize, dispose: (t) => strategy.dispose(t), exec: hostExec };
  }
  if (input.tier === "vm-docker") {
    const settings = input.settings ?? resolveDockerSettings(undefined);
    const exec = dockerExec(input.docker ?? realDockerCli, settings, () => currentRunId, {
      routes: input.routes ?? [],
      runDirFor: (runId) => join(input.paths.varDir, "egress", runId),
      egressDistDir: input.egressDistDir,
      secrets: input.secrets,
      now: input.now,
    });
    return { tier: "vm-docker", materialize, dispose: (t) => strategy.dispose(t), exec };
  }
  return null;
}

/** Kept for slice (a) callers: the unhardened copy materializer. */
export function materializerFor(tier: SandboxTierId, paths: LegionFlowPaths): Materializer | null {
  return tier === "unhardened" ? createMaterializer({ tier, strategy: "copy", paths, runId: "host" }) : null;
}
export { hostSession, dockerSession, GUEST_ROOT, type SessionOpener, type SessionSpec, type OpenedSession } from "./session.js";
export { spawnAllowed, TOOLS_ROUTE_ALIAS } from "./spawn-policy.js";
export type { SpawnKind, SpawnVerdict } from "./spawn-policy.js";
