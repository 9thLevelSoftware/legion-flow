/**
 * The tool gateway (M4 slice k): for one task run, a Streamable HTTP MCP server in
 * this process, on loopback only, behind a per-run bearer token. It exposes the
 * tools the approved plan names for the task, filtered by each server's risk
 * policy, and relays calls to the declared servers, each started in the run's tier
 * the way `tools` starts them. Every call, allowed or refused, is evidence; the
 * budget is per run. Under Docker the agent reaches it through its egress proxy,
 * which injects the token, so the agent never holds it. Loaded by dynamic import.
 * Since slice (o1) a downstream may also be in-process: the built-in `browser`
 * server, started from the task's frozen browser session.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { riskForAnnotations, BROWSER_SERVER_NAME, WEB_SERVER_NAME, type BrowserSession, type McpServerConfig, type WebSession } from "@9thlevelsoftware/legion-flow-schema";
import { redact, type ToolSession } from "@9thlevelsoftware/legion-flow-engine";
import { spawnAllowed, TOOLS_ROUTE_ALIAS, type DockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";
import { PipedTransport, serverSession } from "./mcp-client.js";

export const TOOLS_DEFAULT_MAX_STEPS = 20;
const ARGS_MAX = 16 * 1024;
const RESULT_MAX = 64 * 1024;
const TOKEN_ENV = "LF_TOOLS_TOKEN";

type Tier = "vm-docker" | "unhardened";
interface Downstream {
  name: string;
  allowRisk: readonly string[];
  deny: readonly string[];
  call?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  close?: () => Promise<void>;
  tools: { name: string; description?: string; inputSchema: unknown; annotations?: Record<string, unknown>; riskClass: string }[];
  failed?: string;
}

export interface PreboundGateway {
  port: number;
  token: string;
  /** Under Docker: the egress route and secret the run's proxy needs to reach this gateway with the token. */
  route: EgressRoute;
  secrets: Record<string, string>;
  /** Start the named servers and begin serving this run. */
  attach(input: { runId: string; selection: string[]; record: (rec: Record<string, unknown>) => Promise<void>; redactValues: string[]; browser?: { session: BrowserSession; treeDir: string; open?: (input: { runId: string; record: (rec: Record<string, unknown>) => Promise<void> }) => Promise<BrowserServerLike> }; web?: { session: WebSession; firecrawlUrl: string } }): Promise<ToolSession>;
  close(): Promise<void>;
}

/** Image content is hashed, never inlined into the tool_call record; the browser server keeps its own screenshot record. */
const withoutImages = (value: unknown): unknown => {
  const content = (value as { content?: unknown })?.content;
  if (!Array.isArray(content)) return value;
  return { ...(value as object), content: content.map((c: { type?: string; data?: string }) => (c?.type === "image" && typeof c.data === "string" ? { type: "image", sha256: createHash("sha256").update(c.data).digest("hex"), bytes: c.data.length } : c)) };
};

/** What the gateway needs from a browser server: the host one (slice o1) or the container one (slice o2). */
interface BrowserServerLike {
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; riskClass: string }[];
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

const capJson = (value: unknown, max: number, secrets: readonly string[]) => {
  const text = JSON.stringify(withoutImages(value) ?? null);
  return { sha256: createHash("sha256").update(text).digest("hex"), text: redact(text.length > max ? text.slice(0, max) + "…[truncated]" : text, secrets).text, bytes: text.length };
};

/** Listen on loopback with a fresh token; attach() later binds it to a run once the run id exists. */
/**
 * `usedBefore` (M4 slice w): the attempts of one `execute --retry` share the task's budget, so a later attempt starts
 * with what the earlier ones left (counted from their tool_call records, refused calls included). A later
 * `execute` of the same task starts fresh.
 */
export async function prebindToolGateway(o: { servers: readonly McpServerConfig[]; tier: Tier; dockerSettings: DockerSettings; root: string; clientVersion: string; maxSteps: number; requireSandbox?: boolean; usedBefore?: number }): Promise<PreboundGateway> {
  const usedBefore = o.usedBefore ?? 0;
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let handler: ((name: string, args: unknown) => Promise<unknown>) | null = null;
  let lister: (() => unknown[]) | null = null;
  let port = 0;
  const http: HttpServer = createServer(async (req, res) => {
    // Loopback names, and the name a container's proxy uses for the host (Docker Desktop).
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `host.docker.internal:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) return void res.writeHead(403).end();
    if (req.headers.origin !== undefined) return void res.writeHead(403).end();
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return void res.writeHead(401).end();
    if ((req.url ?? "").split("?")[0] !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    if (!handler || !lister) return void res.writeHead(503).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 4 * 1024 * 1024) return void res.writeHead(413).end();
      chunks.push(c as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return void res.writeHead(400).end();
    }
    const mcp = new Server({ name: "legion-flow-tools", version: o.clientVersion }, { capabilities: { tools: {} } });
    const list = lister;
    const call = handler;
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list() as never }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => (await call(r.params.name, r.params.arguments)) as never);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  port = (http.address() as { port: number }).port;
  const downstream: Downstream[] = [];
  // Called by the session's stop and again by execute's finally: the second call finds nothing left to close.
  const close = async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    const closing = downstream.splice(0);
    for (const d of closing) await d.close?.().catch(() => undefined);
  };

  return {
    port,
    token,
    route: { alias: TOOLS_ROUTE_ALIAS, host: "host.docker.internal", port, scheme: "http", secrets: [{ header: "authorization", ref: `env:${TOKEN_ENV}`, prefix: "Bearer " }] },
    secrets: { [TOKEN_ENV]: token },
    close,
    async attach({ runId, selection, record, redactValues, browser, web }) {
      const secrets = [...redactValues, token];
      const wanted = [...new Set(selection.map((s) => s.split(".")[0]!))];
      for (const name of wanted) {
        // M4 slice z: the built-in web server, in this process, calling the project's Firecrawl on loopback.
        if (name === WEB_SERVER_NAME && web) {
          const d: Downstream = { name, allowRisk: web.session.allowRisk ?? ["network"], deny: web.session.deny ?? [], tools: [] };
          downstream.push(d);
          const { webToolServer } = await import("./web-server.js");
          const srv = webToolServer({ session: web.session, firecrawlUrl: web.firecrawlUrl, runId, record });
          d.call = (tool, args) => srv.call(tool, args);
          d.close = () => srv.close();
          d.tools = srv.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, riskClass: t.riskClass }));
          await record({ kind: "tool_server", runId, server: name, builtin: true, tools: d.tools.length });
          continue;
        }
        if (name === BROWSER_SERVER_NAME && browser) {
          const d: Downstream = { name, allowRisk: browser.session.allowRisk ?? ["read"], deny: browser.session.deny ?? [], tools: [] };
          downstream.push(d);
          try {
            let srv: BrowserServerLike;
            if (browser.open) srv = await browser.open({ runId, record });
            else {
              const { browserToolServer } = await import("@9thlevelsoftware/legion-flow-browser");
              srv = await browserToolServer({ session: browser.session, treeDir: browser.treeDir, runId, record });
            }
            d.call = (tool, args) => srv.call(tool, args);
            d.close = () => srv.close();
            d.tools = srv.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, riskClass: t.riskClass }));
            await record({ kind: "tool_server", runId, server: name, builtin: true, tools: d.tools.length });
          } catch (err: unknown) {
            d.failed = redact((err as Error).message.slice(0, 300), secrets).text;
            await record({ kind: "tool_server_failed", runId, server: name, reason: d.failed });
          }
          continue;
        }
        const server = o.servers.find((s) => s.name === name);
        if (!server) continue;
        const d: Downstream = { name, allowRisk: server.allowRisk ?? ["read"], deny: server.deny ?? [], tools: [] };
        downstream.push(d);
        const policy = spawnAllowed({ kind: "mcp_server", tier: o.tier, hardened: o.tier === "vm-docker", ...(o.requireSandbox ? { require: true } : {}) });
        if (!policy.ok) d.failed = policy.message;
        else if (o.tier === "vm-docker" && !server.image) d.failed = "no image for the vm-docker tier (mcpServers[].image)";
        else {
          try {
            const { open, env } = serverSession(server, o.tier, o.dockerSettings);
            const session = await open({ command: server.command, args: server.args ?? [], root: o.root, env });
            const transport = new PipedTransport(session);
            const client = new Client({ name: "legion-flow-tools", version: o.clientVersion });
            const timeout = server.timeoutMs ?? 30_000;
            await client.connect(transport, { timeout });
            const listed = await client.listTools(undefined, { timeout });
            const timeoutMs = server.timeoutMs ?? 30_000;
            d.call = (tool, args) => client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
            d.close = async () => {
              await client.close().catch(() => undefined);
              await session.kill().catch(() => undefined);
            };
            d.tools = listed.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}), riskClass: riskForAnnotations(t.annotations as Record<string, unknown> | undefined).riskClass }));
            // Who answered, and on which protocol (loose ends after slice aa): the server's own words are untrusted, so capped and redacted.
            const info = client.getServerVersion();
            const clip = (v: unknown) => redact(String(v ?? "").slice(0, 200), secrets).text;
            await record({ kind: "tool_server", runId, server: name, builtin: false, ...(info ? { serverInfo: { name: clip(info.name), version: clip(info.version) } } : {}), protocolVersion: transport.protocolVersion ? clip(transport.protocolVersion) : null, tools: d.tools.length });
          } catch (err: unknown) {
            d.failed = (err as Error).message.slice(0, 300);
          }
        }
        if (d.failed) await record({ kind: "tool_server_failed", runId, server: name, reason: d.failed });
      }
      const allowed = (server: string, tool: string) => {
        const d = downstream.find((x) => x.name === server);
        const t = d?.tools.find((x) => x.name === tool);
        if (!d || !t) return null;
        const named = selection.includes(server) || selection.includes(`${server}.${tool}`);
        const risky = d.allowRisk.includes(t.riskClass);
        const denied = d.deny.includes(tool);
        return named && risky && !denied ? { d, t } : null;
      };
      const exposed = downstream.flatMap((d) => d.tools.filter((t) => allowed(d.name, t.name)).map((t) => ({ server: d.name, ...t }))).sort((a, b) => (`${a.server}__${a.name}` < `${b.server}__${b.name}` ? -1 : 1));
      let step = 0;
      let refused = 0;
      lister = () => exposed.map((t) => ({ name: `${t.server}__${t.name}`, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) }));
      handler = async (name, args) => {
        step++;
        const at = name.indexOf("__");
        const server = at > 0 ? name.slice(0, at) : "";
        const tool = at > 0 ? name.slice(at + 2) : name;
        const argsRec = capJson(args, ARGS_MAX, secrets);
        const t0 = Date.now();
        const refuse = async (verdict: string, text: string) => {
          refused++;
          await record({ kind: "tool_call", runId, step, server, tool, verdict, argsSha256: argsRec.sha256, args: argsRec.text, isError: true, ms: Date.now() - t0 });
          return { content: [{ type: "text", text }], isError: true };
        };
        if (usedBefore + step > o.maxSteps) return refuse("refused_budget", usedBefore ? `The task's tool budget of ${o.maxSteps} call(s) is spent (${usedBefore} by earlier attempts of this execute --retry); no more tool calls are relayed.` : `The run's tool budget of ${o.maxSteps} call(s) is spent; no more tool calls are relayed.`);
        const hit = allowed(server, tool);
        if (!hit) {
          const d = downstream.find((x) => x.name === server);
          if (d?.failed) return refuse("server_unavailable", `${server} is unavailable in this run.`);
          return refuse(d?.tools.some((x) => x.name === tool) ? "refused_policy" : "unknown_tool", `${name} is not a tool this task may call.`);
        }
        try {
          const result = await hit.d.call!(tool, (args ?? {}) as Record<string, unknown>);
          const res = capJson(result, RESULT_MAX, secrets);
          await record({ kind: "tool_call", runId, step, server, tool, riskClass: hit.t.riskClass, verdict: "relayed", argsSha256: argsRec.sha256, args: argsRec.text, resultSha256: res.sha256, result: res.text, isError: Boolean((result as { isError?: boolean }).isError), ms: Date.now() - t0 });
          return result;
        } catch (err: unknown) {
          await record({ kind: "tool_call", runId, step, server, tool, riskClass: hit.t.riskClass, verdict: "relay_failed", argsSha256: argsRec.sha256, args: argsRec.text, isError: true, reason: redact((err as Error).message.slice(0, 300), secrets).text, ms: Date.now() - t0 });
          return { content: [{ type: "text", text: `${name} failed: ${(err as Error).message.slice(0, 200)}` }], isError: true };
        }
      };
      return {
        // Under Docker the tier fills LF_TOOLS_URL and the proxy injects the token: the agent gets neither.
        agent: o.tier === "vm-docker" ? {} : { url: `http://127.0.0.1:${port}/mcp`, token },
        exposed: exposed.map((t) => ({ name: `${t.server}__${t.name}`, riskClass: t.riskClass, ...(t.description ? { description: t.description } : {}) })),
        secrets: [token],
        stop: async () => {
          handler = null;
          lister = null;
          await close();
          return { calls: step, refused, budget: o.maxSteps, failedServers: downstream.filter((d) => d.failed).map((d) => d.name), ...(usedBefore ? { usedBefore } : {}) };
        },
      };
    },
  };
}
