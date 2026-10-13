/**
 * Outbound MCP (M4 slice f, ADR-0005): probe a declared stdio server. The
 * process is spawned by our own session code (spawnPiped on the host, which
 * handles Windows .cmd shims with our quoting; docker run -i under vm-docker),
 * never by the SDK's own spawner, and the SDK's Client speaks over those pipes
 * through the small transport below. A probe lists tools and never calls one.
 * Loaded by dynamic import, so no other verb pays for the SDK.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, ResultEnvelope } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { buildAdapterEnv } from "@9thlevelsoftware/legion-flow-adapters";
import { dockerSession, hostSession, realDockerCli, spawnAllowed, type DockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SCHEMA_VERSIONS, riskForAnnotations, ToolProbeSchema, type McpServerConfig, type ToolProbe } from "@9thlevelsoftware/legion-flow-schema";
import type { OpenedSession, SessionOpener } from "@9thlevelsoftware/legion-flow-sandbox";

/** A Transport over a session's pipes; listeners attach in start(), as Client.connect expects. */
export class PipedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protocolVersion?: string;
  private readonly buffer = new ReadBuffer();
  private started = false;
  constructor(private readonly session: OpenedSession) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("PipedTransport already started");
    this.started = true;
    this.session.stdout.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          this.onerror?.(err as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.session.stdout.on("error", (err: Error) => this.onerror?.(err));
    void this.session.exited.then(() => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => this.session.stdin.write(serializeMessage(message), (err) => (err ? reject(err) : resolve())));
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async close(): Promise<void> {
    await this.session.kill();
    this.onclose?.();
  }
}

/** How a declared server is started on a tier (shared by the probe and the tool gateway): its session opener and environment. */
export function serverSession(server: McpServerConfig, tier: ToolProbe["tier"], dockerSettings: DockerSettings): { open: SessionOpener; env: Record<string, string> } {
  const open = tier === "unhardened" ? hostSession : dockerSession(realDockerCli, { ...dockerSettings, image: server.image! }, `lf-mcp-${server.name}-${randomBytes(3).toString("hex")}`);
  const env: Record<string, string> = tier === "unhardened" ? buildAdapterEnv(process.env, { mode: "host", extraAllowlist: server.envKeys ?? [] }) : Object.fromEntries((server.envKeys ?? []).flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : [])));
  return { open, env };
}

export async function probeServer(server: McpServerConfig, tier: ToolProbe["tier"], open: SessionOpener, root: string, env: Record<string, string>, clientVersion: string): Promise<ToolProbe> {
  const t0 = Date.now();
  const timeoutMs = server.timeoutMs ?? 30_000;
  let session: OpenedSession | null = null;
  const base = { schema: SCHEMA_VERSIONS.TOOL_PROBE, server: server.name, tier } as const;
  try {
    session = await open({ command: server.command, args: server.args ?? [], root, env });
    const transport = new PipedTransport(session);
    const client = new Client({ name: "legion-flow", version: clientVersion });
    const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${timeoutMs} ms`)), timeoutMs);
        timer.unref();
      });
      return Promise.race([p, limit]).finally(() => clearTimeout(timer));
    };
    await withTimeout(client.connect(transport), "initialize");
    const listed = await withTimeout(client.listTools(), "tools/list");
    const info = client.getServerVersion();
    const tools = listed.tools
      .map((t) => {
        const mapped = riskForAnnotations(t.annotations as Record<string, unknown> | undefined);
        return { name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}), riskClass: mapped.riskClass, ...(mapped.conflict ? { conflict: mapped.conflict } : {}) };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    await client.close().catch(() => undefined);
    return ToolProbeSchema.parse({ ...base, ok: true, ...(info ? { serverInfo: { name: info.name, version: info.version } } : {}), ...(transport.protocolVersion ? { protocolVersion: transport.protocolVersion } : {}), tools, ms: Date.now() - t0 });
  } catch (err: unknown) {
    const tail = session?.stderrTail().slice(-300).trim();
    return ToolProbeSchema.parse({ ...base, ok: false, reason: `${(err as Error).message}${tail ? ` (stderr: ${tail})` : ""}`, tools: [], ms: Date.now() - t0 });
  } finally {
    if (session) await session.kill().catch(() => undefined);
  }
}

// ---- the tools verb ----


export interface ToolsOptions {
  server?: string;
  sandbox?: string;
  allowNoSandbox?: boolean;
}

type Envelope = (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => Promise<ResultEnvelope>;

/** `tools`: probe each declared server and report its tools with mapped risk classes; never calls a tool. */
export async function toolsVerb(ws: Workspace, servers: readonly McpServerConfig[], opts: ToolsOptions, ctx: { isTTY: boolean; dockerSettings: DockerSettings; clientVersion: string; requireSandbox?: boolean }, envelope: Envelope, statusNext: () => Promise<ResultEnvelope["nextAction"]>): Promise<ResultEnvelope> {
  const chosen = opts.server ? servers.filter((s) => s.name === opts.server) : [...servers];
  if (servers.length === 0) return envelope("refused", [{ code: "mcp_servers_absent", severity: "error", message: "project.json declares no mcpServers; there is nothing to probe.", hint: "Add mcpServers: [{ name, command, args, envKeys, image }] to project.json (it is config: approvals are made again)." }], await statusNext());
  if (chosen.length === 0) return envelope("refused", [{ code: "mcp_server_unknown", severity: "error", message: `No MCP server named '${opts.server}' (declared: ${servers.map((s) => s.name).join(", ")}).` }], await statusNext());
  const tier = (opts.sandbox ?? "vm-docker") as ToolProbe["tier"];
  if (tier !== "vm-docker" && tier !== "unhardened") return envelope("usage_error", [{ code: "tools_sandbox_unknown", severity: "error", message: `--sandbox must be vm-docker or unhardened (got '${opts.sandbox}').` }], { type: "command", run: "legion-flow tools" });
  const policy = spawnAllowed({ kind: "mcp_server", tier, hardened: tier === "vm-docker", ...(ctx.requireSandbox ? { require: true } : {}) });
  if (!policy.ok) return envelope("refused", [{ code: policy.code, severity: "error", message: policy.message, hint: policy.hint }], await statusNext());
  if (tier === "unhardened" && (!opts.allowNoSandbox || !ctx.isTTY)) {
    return envelope("refused", [{ code: opts.allowNoSandbox ? "sandbox_confirmation_requires_tty" : "sandbox_not_hardened", severity: "error", message: "Running an MCP server on the host is not a sandbox: a server is an arbitrary program, and npx-style commands download and run code.", hint: "FIX: re-run with --allow-no-sandbox on a terminal to accept that, or give the server an image for the default vm-docker tier." }], await statusNext());
  }
  if (tier === "vm-docker") {
    const missing = chosen.filter((s) => !s.image).map((s) => s.name);
    if (missing.length) return envelope("refused", [{ code: "mcp_server_image_missing", severity: "error", message: `MCP server(s) ${missing.join(", ")} have no image for the vm-docker tier.`, hint: "FIX: set mcpServers[].image to an image with the server installed, or run legion-flow tools --sandbox unhardened --allow-no-sandbox on a terminal." }], await statusNext());
  }
  const diagnostics: Diagnostic[] = [];
  let failed = 0;
  const dir = join(ws.paths.varDir, "cache", "tools");
  await mkdir(dir, { recursive: true });
  for (const server of chosen) {
    const { open, env } = serverSession(server, tier, ctx.dockerSettings);
    const probe = await probeServer(server, tier, open, ws.root, env, ctx.clientVersion);
    const bytes = JSON.stringify(probe, null, 2) + "\n";
    const path = join(dir, `${server.name}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
    await atomicWriteFile(path, bytes);
    if (!probe.ok) {
      failed++;
      diagnostics.push({ code: "mcp_probe_failed", severity: "error", message: `${server.name} (${tier}): ${probe.reason}`, path });
      continue;
    }
    diagnostics.push({ code: "mcp_probe", severity: "info", message: `${server.name} (${tier}): ${probe.serverInfo ? `${probe.serverInfo.name} ${probe.serverInfo.version}` : "unnamed server"}, protocol ${probe.protocolVersion ?? "unknown"}, ${probe.tools.length} tool(s) in ${probe.ms} ms; nothing was called.`, path });
    for (const t of probe.tools.slice(0, 25)) diagnostics.push({ code: "mcp_tool", severity: t.conflict ? "warning" : "info", message: `${server.name}.${t.name}: ${t.riskClass}${t.conflict ? ` (${t.conflict})` : ""}` });
  }
  return envelope(failed ? "blocked" : "ok", diagnostics, failed ? { type: "command", run: "legion-flow doctor", hint: "Check the server command and image." } : await statusNext());
}
