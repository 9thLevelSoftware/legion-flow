import { findBrowsers, browserImageTag } from "@9thlevelsoftware/legion-flow-browser";
import { sqliteHealth } from "@9thlevelsoftware/legion-flow-memory";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace, LoadProjectResult } from "@9thlevelsoftware/legion-flow-persist";
import { dockerCheapChecks, resolveDockerSettings, type DockerCli } from "@9thlevelsoftware/legion-flow-sandbox";
import { ADAPTER_DEFINITIONS, agentImageTag, vendorPrefixMatches } from "@9thlevelsoftware/legion-flow-adapters";
import { spawnFrozen } from "@9thlevelsoftware/legion-flow-engine";

const execFileAsync = promisify(execFile);

/** The one home of the Node floor. A test asserts it matches `engines.node` in the manifests. */
export const NODE_FLOOR = "22.13.0";

/**
 * Everything doctor learns about the machine comes through this port. The
 * real adapter asks the process and the shell; tests supply a fake with
 * scripted answers, so every verdict is testable on any CI host.
 */
export interface SystemProbe {
  nodeVersion(): string;
  /** Resolved paths for a binary on PATH; empty when absent. */
  which(binary: string): Promise<string[]>;
  /** Trimmed stdout of a command, or null when it is absent, fails, or times out. */
  run(command: string, args: string[]): Promise<string | null>;
  /** Whether the SQLite driver loads and builds an FTS5 table (the memory index). */
  sqlite(): Promise<{ ok: true; sqliteVersion: string } | { ok: false; reason: string }>;
  /** The first browser a browser check would launch, if any (never downloads). */
  browser(): Promise<{ kind: string; executablePath: string } | null>;
  /** A GET to a loopback URL (M4 slice z), never following a redirect; null when it fails or times out. Optional so scripted probes need not answer. */
  httpGet?(url: string): Promise<{ status: number; body: string } | null>;
}

const COMMAND_TIMEOUT_MS = 10_000;

export const realProbe: SystemProbe = {
  nodeVersion: () => process.versions.node,
  sqlite: () => sqliteHealth(),
  browser: async () => findBrowsers()[0] ?? null,
  async httpGet(url) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      return { status: res.status, body: (await res.text()).slice(0, 2_000) };
    } catch {
      return null;
    }
  },
  async which(binary) {
    const resolver = process.platform === "win32" ? "where.exe" : "which";
    try {
      const { stdout } = await execFileAsync(resolver, [binary], { timeout: COMMAND_TIMEOUT_MS });
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  },
  async run(command, args) {
    // The engine's spawn resolves Windows .cmd shims (npm installs `codex` that way) through cmd.exe; execFile cannot start them.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const out = await spawnFrozen({ command, args, cwd: process.cwd(), env, signal: new AbortController().signal, timeoutMs: COMMAND_TIMEOUT_MS });
    return out.exitCode === 0 ? out.stdoutTail.trim() : null;
  },
};

export interface DiagnosticItem {
  /** Stable snake_case identifier host agents can branch on. */
  code: string;
  check: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixHint?: string;
}

export interface DoctorReport {
  timestamp: string;
  allPassed: boolean;
  /** The project store's verdict, so doctor and status never disagree about the record. */
  project: LoadProjectResult;
  diagnostics: DiagnosticItem[];
}

/** What every check may read. The project is loaded once and shared. */
export interface CheckInputs {
  probe: SystemProbe;
  workspace: Workspace;
  project: LoadProjectResult;
}

/** A check yields one diagnostic, several (one per configured item), or nothing when it has nothing to report. */
export type DoctorCheck = (inputs: CheckInputs) => Promise<DiagnosticItem | DiagnosticItem[] | null>;

/** Compare dotted numeric versions ("22.13.0"); missing parts count as zero. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

const nodeVersionCheck: DoctorCheck = async ({ probe }) => {
  const version = probe.nodeVersion();
  if (compareVersions(version, NODE_FLOOR) >= 0) {
    return {
      code: "node_version",
      check: "Node.js Version",
      status: "pass",
      message: `Node.js v${version} satisfies engine requirement >= ${NODE_FLOOR}`,
    };
  }
  return {
    code: "node_version",
    check: "Node.js Version",
    status: "fail",
    message: `Node.js v${version} is below required >= ${NODE_FLOOR}`,
    fixHint: `Upgrade to Node.js v${NODE_FLOOR} or higher`,
  };
};

const pathShadowingCheck: DoctorCheck = async ({ probe }) => {
  const paths = await probe.which("legion");
  if (paths.length === 0) return null;
  return {
    code: "path_shadowing",
    check: "PATH Binary Disambiguation ('legion')",
    status: "warn",
    message: `'legion' resolved at: ${paths.join(", ")}. Note: 'legion' belongs to legion-cli or legion-ascended. Use 'legion-flow' for this engine.`,
  };
};

const pathSiblingCheck: DoctorCheck = async ({ probe }) => {
  const paths = await probe.which("legion-cli");
  if (paths.length === 0) return null;
  return {
    code: "path_sibling",
    check: "PATH Binary Disambiguation ('legion-cli')",
    status: "pass",
    message: `'legion-cli' found at: ${paths.join(", ")} (non-colliding sibling binary)`,
  };
};

/**
 * The sandbox package's cheap Docker checks (client, daemon, linux engine, image), through the probe so tests stay
 * scripted. The probe container is run by execute, never by doctor. Failures are warnings here: a machine without
 * Docker still runs every governance verb, and the unhardened tier remains behind --allow-no-sandbox.
 */
const dockerChecks: DoctorCheck[] = ["docker_cli", "docker_daemon", "docker_linux_engine", "docker_image"].map((id) => async ({ probe, project }) => {
  const docker: DockerCli = {
    async run(args) {
      const out = await probe.run("docker", [...args]);
      if (out !== null) return { code: 0, signal: null, stdout: out, stderr: "", timedOut: false };
      // The probe cannot tell a missing client from a stopped daemon; PATH resolution can.
      const onPath = await probe.which("docker");
      return onPath.length === 0
        ? { code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "docker is not on PATH" }
        : { code: 1, signal: null, stdout: "", stderr: "docker did not answer", timedOut: false };
    },
  };
  const settings = resolveDockerSettings(project.kind === "valid" ? project.config.sandbox : undefined);
  const { checks } = await dockerCheapChecks({ docker, settings });
  const check = checks.find((c) => c.id === id);
  if (!check) return null;
  return {
    code: id,
    check: `Docker sandbox: ${id.replace("docker_", "").replace("_", " ")}`,
    status: check.status === "fail" ? "warn" : check.status,
    message: check.status === "pass" ? check.message : `${check.message}. The vm-docker tier is unavailable until this is fixed; the unhardened tier needs --allow-no-sandbox on a terminal.`,
    ...(check.fix ? { fixHint: check.fix } : {}),
  };
});

const projectCheck: DoctorCheck = async ({ project }) => {
  switch (project.kind) {
    case "valid":
      return {
        code: "project_config",
        check: "Project Configuration",
        status: "pass",
        message: `Project configuration found and schema-valid at ${project.path} (phase ${project.phase})`,
      };
    case "absent":
      return {
        code: "project_config",
        check: "Project Configuration",
        status: "warn",
        message: "No .legion-flow project found in this workspace.",
        fixHint: "Run 'legion-flow init --adapter <id>' to initialize.",
      };
    case "invalid":
      return {
        code: "project_config",
        check: "Project Configuration",
        status: "fail",
        message: `project.json is ${project.cause.replace("_", " ")}: ${project.detail}`,
        fixHint: "Move the file aside and run 'legion-flow init' again, or restore it from version control.",
      };
  }
};

const auditChainCheck: DoctorCheck = async ({ workspace }) => {
  const result = await workspace.audit.verify();
  if (result.valid && result.unindexedTail) {
    return {
      code: "audit_chain",
      check: "Audit Chain Integrity",
      status: "warn",
      message: `Audit chain verified: ${result.verifiedCount} events intact; the last one is committed but not yet indexed (a write was interrupted after the event was recorded).`,
      fixHint: "The next locked write folds it into the index. At M0 only 'legion-flow init' writes, so this stays reported until M1 adds more writers.",
    };
  }
  if (result.valid) {
    const state = await workspace.audit.readChain().catch(() => null);
    const baselined = state?.baseline ? `; rebaselined at seq ${state.baseline.seq} by ${state.baseline.operator} (${state.baseline.at})` : "";
    return {
      code: "audit_chain",
      check: "Audit Chain Integrity",
      status: "pass",
      message: `Audit chain verified: ${result.verifiedCount} events intact with cryptographic hash verification${baselined}`,
    };
  }
  return {
    code: "audit_chain",
    check: "Audit Chain Integrity",
    status: "fail",
    message: `Audit chain verification failed: ${result.error}`,
    fixHint: 'Investigate file tampering; the one repair is legion-flow doctor --rebaseline-audit --reason "<24+ chars>" --approver <id>, which records a baseline and never rewrites history.',
  };
};

/** Each real adapter: binary on PATH, `--version` answers with the vendor prefix. Absent is a warning with the install FIX. */
const adapterChecks: DoctorCheck[] = ADAPTER_DEFINITIONS.map((def) => async ({ probe }) => {
  const paths = await probe.which(def.binary);
  if (paths.length === 0) {
    return { code: `adapter_${def.id}`, check: `Adapter '${def.id}' CLI`, status: "warn", message: `'${def.binary}' is not on PATH; the ${def.id} adapter can run only inside the agent image.`, fixHint: def.installHint };
  }
  const version = await probe.run(def.binary, ["--version"]);
  if (version === null) {
    return { code: `adapter_${def.id}`, check: `Adapter '${def.id}' CLI`, status: "warn", message: `'${def.binary}' is on PATH (${paths[0]}) but '--version' did not answer.`, fixHint: def.installHint };
  }
  if (!vendorPrefixMatches(def.vendorPrefix, version)) {
    return { code: `adapter_${def.id}`, check: `Adapter '${def.id}' CLI`, status: "fail", message: `'${def.binary}' at ${paths[0]} answered '${version.split("\n")[0]}', which does not carry the vendor prefix '${def.vendorPrefix.text}'; a different program is shadowing it.`, fixHint: "FIX: remove or rename the shadowing program, then reinstall the vendor CLI." };
  }
  return { code: `adapter_${def.id}`, check: `Adapter '${def.id}' CLI`, status: "pass", message: `${version.split("\n")[0]}, resolved on PATH (${paths[0]}${paths.length > 1 ? `; a .cmd shim beside it runs through cmd.exe` : ""})` };
});

/** The agent image the real adapters run in under vm-docker. */
const agentImageCheck: DoctorCheck = async ({ probe }) => {
  const tag = agentImageTag();
  const id = await probe.run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
  if (id === null) {
    return { code: "agent_image", check: "Agent image", status: "warn", message: `${tag} is not built; claude and codex cannot run in the vm-docker tier until it is.`, fixHint: "FIX: run 'legion-flow execute' once with a real adapter; it writes the Dockerfile and prints the exact docker build command." };
  }
  return { code: "agent_image", check: "Agent image", status: "pass", message: `${tag} present as ${id}` };
};

/** The browser image a browsing task runs in under vm-docker (M4 slice o2). Never builds or pulls. */
const browserImageCheck: DoctorCheck = async ({ probe, project }) => {
  const tag = (project.kind === "valid" ? project.config.sandbox?.docker?.browserImage : undefined) ?? browserImageTag();
  const id = await probe.run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
  if (id === null) {
    return { code: "browser_image", check: "Browser image", status: "warn", message: `${tag} is not present; a task whose tools name 'browser' cannot run in the vm-docker tier until it is.`, fixHint: tag === browserImageTag() ? "FIX: run 'legion-flow execute' on a browsing task once; it writes the Dockerfile under .legion-flow/var/images/browser and prints the exact docker build command." : `FIX: build or pull ${tag} (project.json sandbox.docker.browserImage).` };
  }
  return { code: "browser_image", check: "Browser image", status: "pass", message: `${tag} present as ${id}` };
};

/** The project's self-hosted Firecrawl (M4 slice z), only when web.firecrawlUrl is set; a loopback readiness GET. Never starts it. */
const webFirecrawlCheck: DoctorCheck = async ({ probe, project }) => {
  const base = project.kind === "valid" ? project.config.web?.firecrawlUrl : undefined;
  if (!base) return null;
  const url = new URL("v0/health/readiness", base.endsWith("/") ? base : `${base}/`).toString();
  const fix = "FIX: start your Firecrawl stack (docker compose up -d in its checkout); Legion never starts or builds it.";
  if (!probe.httpGet) return { code: "web_firecrawl", check: "Web (Firecrawl)", status: "warn", message: `cannot reach ${url} from this probe.`, fixHint: fix };
  const got = await probe.httpGet(url);
  if (got === null) return { code: "web_firecrawl", check: "Web (Firecrawl)", status: "warn", message: `${url} did not answer; tasks whose tools name 'web' will get refusals from every scrape.`, fixHint: fix };
  let ready = false;
  try {
    ready = got.status === 200 && (JSON.parse(got.body) as { status?: string }).status === "ok";
  } catch {
    ready = false;
  }
  return ready
    ? { code: "web_firecrawl", check: "Web (Firecrawl)", status: "pass", message: `${url} reports ready (a heartbeat only; it does not test scraping).` }
    : { code: "web_firecrawl", check: "Web (Firecrawl)", status: "warn", message: `${url} answered HTTP ${got.status} without {"status":"ok"}.`, fixHint: fix };
};

/** The memory index driver: node:sqlite with FTS5 (ADR-0003). */
const indexSqliteCheck: DoctorCheck = async ({ probe }) => {
  const health = await probe.sqlite();
  if (!health.ok) {
    return { code: "index_sqlite", check: "Memory index driver", status: "fail", message: `node:sqlite could not open a database with FTS5: ${health.reason}`, fixHint: "FIX: use Node 22.13.0 or later built with SQLite and FTS5 (the official builds are); map and recall need it." };
  }
  return { code: "index_sqlite", check: "Memory index driver", status: "pass", message: `node:sqlite with FTS5, SQLite ${health.sqliteVersion}` };
};

/**
 * Each configured language server: the command on the host (for the unhardened
 * escape) and its image (for vm-docker). Never starts a server or a container.
 */
const languageServerChecks: DoctorCheck = async ({ probe, project }) => {
  if (project.kind !== "valid") return null;
  const servers = project.config.map?.languageServers ?? [];
  const out: DiagnosticItem[] = [];
  for (const s of servers) {
    const code = `language_server_${s.language}`;
    const check = `Language server ${s.language}`;
    const onHost = (await probe.which(s.command)).length > 0;
    if (!s.image) {
      out.push({ code, check, status: "warn", message: `no image is set, so the vm-docker tier cannot run it; ${onHost ? `${s.command} is on PATH for the host escape` : `${s.command} is not on PATH either`}.`, fixHint: "FIX: set map.languageServers[].image to an image with the server installed, or run legion-flow map --sandbox unhardened --allow-no-sandbox on a terminal." });
      continue;
    }
    const id = await probe.run("docker", ["image", "inspect", s.image, "--format", "{{.Id}}"]);
    if (id === null) {
      out.push({ code, check, status: "warn", message: `image ${s.image} is not present locally${onHost ? `; ${s.command} is on PATH for the host escape` : ""}.`, fixHint: `FIX: docker pull ${s.image} (or build it with the server installed).` });
      continue;
    }
    out.push({ code, check, status: "pass", message: `image ${s.image} present as ${id}${onHost ? `; ${s.command} also on PATH` : ""}.` });
  }
  return out;
};

/** Browser checks need a browser on the host: Chrome, then Edge, then Playwright's cached Chromium. */
const browserCheck: DoctorCheck = async ({ probe }) => {
  const b = await probe.browser();
  if (!b) return { code: "browser", check: "Browser for browser checks", status: "warn", message: "no installed Chrome or Edge and no cached Playwright Chromium; browser: checks will be unevaluable (nothing is ever downloaded).", fixHint: "FIX: install Chrome or Edge, or run npx playwright install chromium yourself." };
  return { code: "browser", check: "Browser for browser checks", status: "pass", message: `${b.kind} at ${b.executablePath}` };
};

/** Each declared MCP server: command on the host, download-and-run launchers, image for vm-docker. Starts nothing. */
const mcpServerChecks: DoctorCheck = async ({ probe, project }) => {
  if (project.kind !== "valid") return null;
  const out: DiagnosticItem[] = [];
  for (const s of project.config.mcpServers ?? []) {
    const code = `mcp_server_${s.name}`;
    const check = `MCP server '${s.name}'`;
    const launcher = /^(npx|pnpx|bunx|uvx|pipx)(\.cmd|\.exe)?$/i.test(s.command.split(/[\\/]/).pop() ?? "");
    const onHost = (await probe.which(s.command)).length > 0;
    const image = s.image ? await probe.run("docker", ["image", "inspect", s.image, "--format", "{{.Id}}"]) : null;
    const notes = [
      launcher ? `'${s.command}' downloads and runs a package each time; pin it in an image instead` : null,
      s.image ? (image ? `image ${s.image} present` : `image ${s.image} is not present locally`) : "no image, so the vm-docker tier cannot run it",
      onHost ? `'${s.command}' is on PATH` : `'${s.command}' is not on PATH`,
    ].filter(Boolean).join("; ");
    const status = launcher || !s.image || !image ? "warn" : "pass";
    out.push({ code, check, status, message: `${notes}.`, ...(status === "warn" ? { fixHint: s.image && !image ? `FIX: docker pull ${s.image} (or build it with the server installed).` : "FIX: give the server an image with it installed (mcpServers[].image), or probe it on the host with legion-flow tools --sandbox unhardened --allow-no-sandbox." } : {}) });
  }
  return out;
};

/** Optional CALL hooks (M4 slice l): which are enabled by consent, which are declared without one. Never calls a hook. */
const hooksCheck: DoctorCheck = async ({ workspace, project }) => {
  if (project.kind !== "valid" || !(project.config.hooks ?? []).length) return null;
  const { hookStates } = await import("./hooks.js");
  const states = await hookStates(workspace, project.config);
  const on = states.filter((s) => s.enabled).map((s) => s.hook.name);
  const off = states.filter((s) => !s.enabled).map((s) => `${s.hook.name} (${s.reason})`);
  return { code: "hooks", check: "Optional CALL hooks", status: "pass", message: `${on.length ? `enabled by consent: ${on.join(", ")}` : "none enabled, so no external call is made"}${off.length ? `; declared but not enabled: ${off.join(", ")}` : ""}. Doctor never calls a hook.` };
};

/** Ordered list of checks. New checks are appended here and read the machine only through the probe. */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  nodeVersionCheck,
  pathShadowingCheck,
  pathSiblingCheck,
  ...dockerChecks,
  ...adapterChecks,
  agentImageCheck,
  browserImageCheck,
  indexSqliteCheck,
  languageServerChecks,
  browserCheck,
  mcpServerChecks,
  webFirecrawlCheck,
  hooksCheck,
  projectCheck,
  auditChainCheck,
];

export async function runDoctor(workspace: Workspace, probe: SystemProbe = realProbe): Promise<DoctorReport> {
  const project = await workspace.project.load();
  const inputs: CheckInputs = { probe, workspace, project };

  const diagnostics: DiagnosticItem[] = [];
  for (const check of DOCTOR_CHECKS) {
    const item = await check(inputs);
    for (const i of [item].flat()) if (i) diagnostics.push(i);
  }

  return {
    timestamp: new Date().toISOString(),
    allPassed: diagnostics.every((d) => d.status !== "fail"),
    project,
    diagnostics,
  };
}
