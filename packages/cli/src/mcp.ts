/**
 * The inbound MCP server: read-only tools over stdio. Loaded only by the `mcp`
 * verb (a dynamic import), so no other verb pays for the SDK's dependencies.
 * The transport owns stdout; nothing here writes to it except the protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResultEnvelopeSchema, type ResultEnvelope } from "@9thlevelsoftware/legion-flow-schema";
import type { CommandContext } from "./runner.js";
import { statusCommand, nextCommand, doctorCommand, CLI_VERSION } from "./commands.js";
import { MAP_FRESHNESS, MapQueryResultSchema, RecallDocSchema, SCHEMA_VERSIONS } from "@9thlevelsoftware/legion-flow-schema";
import { mapStatus, runMapQuery, checkArchitecture, recall, rulesOf } from "@9thlevelsoftware/legion-flow-memory";

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

/**
 * The only way a tool is added. It refuses a registration that does not
 * declare all three read-only hints or lacks an output schema, so no tool can
 * slip in that mutates, deletes, or reaches outside the host.
 */
export function registerReadOnlyTool(
  server: Pick<McpServer, "registerTool">,
  name: string,
  config: { title: string; description: string; inputSchema?: Record<string, z.ZodType>; outputSchema: z.ZodType; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } },
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
): void {
  const a = config.annotations;
  if (a.readOnlyHint !== true || a.destructiveHint !== false || a.openWorldHint !== false) {
    throw new Error(`tool '${name}' must declare readOnlyHint: true, destructiveHint: false, openWorldHint: false`);
  }
  if (!config.outputSchema) throw new Error(`tool '${name}' must declare an outputSchema`);
  const registration = { title: config.title, description: config.description, outputSchema: config.outputSchema, annotations: { ...a, title: config.title }, ...(config.inputSchema ? { inputSchema: config.inputSchema } : {}) };
  // The SDK's overloads distinguish zero-argument tools by the callback's arity; both shapes are wrapped here.
  if (config.inputSchema) {
    (server.registerTool as (n: string, c: unknown, cb: (args: Record<string, unknown>) => Promise<ToolResult>) => unknown)(name, registration, (args) => handler(args));
  } else {
    (server.registerTool as (n: string, c: unknown, cb: () => Promise<ToolResult>) => unknown)(name, registration, () => handler({}));
  }
}

function envelopeResult(env: ResultEnvelope): ToolResult {
  const isError = env.status === "refused" || env.status === "usage_error";
  const next = env.nextAction.type === "command" || env.nextAction.type === "human_decision" ? ` Next: ${env.nextAction.run}` : "";
  return { content: [{ type: "text", text: `${env.command}: ${env.status}, phase ${env.phase}.${next}` }], structuredContent: env as unknown as Record<string, unknown>, ...(isError ? { isError: true } : {}) };
}

const RunSummary = z.object({ id: z.string(), kind: z.string(), workflowId: z.string().optional(), status: z.string(), startedAt: z.string(), endedAt: z.string().optional() });

export function buildServer(ctx: CommandContext): McpServer {
  const server = new McpServer({ name: "legion-flow", version: CLI_VERSION });
  const ws = ctx.workspace;

  registerReadOnlyTool(server, "status", { title: "Project status", description: "Where the project stands and the one next action (the status envelope).", outputSchema: ResultEnvelopeSchema, annotations: READ_ONLY }, async () =>
    envelopeResult(await statusCommand(ctx, {}))
  );
  registerReadOnlyTool(server, "next", { title: "Next action", description: "The one next action, as the status envelope.", outputSchema: ResultEnvelopeSchema, annotations: READ_ONLY }, async () =>
    envelopeResult(await nextCommand(ctx, {}))
  );
  registerReadOnlyTool(server, "doctor", { title: "Readiness checks", description: "Readiness checks with FIX lines. The audit rebaseline is not reachable over MCP: it is a human act on a terminal.", outputSchema: ResultEnvelopeSchema, annotations: READ_ONLY }, async () =>
    envelopeResult(await doctorCommand(ctx, {}))
  );
  registerReadOnlyTool(
    server,
    "runs",
    { title: "Runs", description: "Every run of the project: id, kind, workflow, status, times.", outputSchema: z.object({ runs: z.array(RunSummary) }), annotations: READ_ONLY },
    async () => {
      const runs = (await ws.runs.list()).map((r) => ({
        id: r.run.id,
        kind: r.run.kind,
        ...(r.run.kind === "workflow" ? { workflowId: r.run.workflowId } : {}),
        status: r.run.status,
        startedAt: r.run.startedAt,
        ...(r.run.endedAt ? { endedAt: r.run.endedAt } : {}),
      }));
      return { content: [{ type: "text", text: `${runs.length} run(s).` }], structuredContent: { runs } };
    }
  );
  registerReadOnlyTool(
    server,
    "show",
    {
      title: "Show a run",
      description: "One run's record, evidence index (paths and hashes, never bodies), verdicts, and interrupt summaries.",
      inputSchema: { runId: z.string() },
      outputSchema: z.object({ run: z.record(z.string(), z.unknown()), evidenceIndex: z.array(z.record(z.string(), z.unknown())), verdicts: z.array(z.record(z.string(), z.unknown())), interrupts: z.array(z.record(z.string(), z.unknown())) }).partial(),
      annotations: READ_ONLY,
    },
    async (args) => {
      const runId = String(args.runId ?? "");
      if (!/^run_[0-9a-z]+$/.test(runId)) return { content: [{ type: "text", text: `'${runId}' is not a run id.` }], structuredContent: {}, isError: true };
      const loaded = await ws.runs.load(runId);
      if (!loaded) return { content: [{ type: "text", text: `No run ${runId}.` }], structuredContent: {}, isError: true };
      const interrupts = loaded.run.kind === "workflow" ? (await ws.interrupts.list(runId)).map((i) => ({ id: i.interrupt.id, kind: i.interrupt.kind, action: i.interrupt.action.name, status: i.effectiveStatus, expiresAt: i.interrupt.expiresAt })) : [];
      return {
        content: [{ type: "text", text: `${runId}: ${loaded.run.kind} ${loaded.run.status}, ${loaded.evidenceIndex.length} evidence file(s), ${loaded.verdicts.length} verdict(s).` }],
        structuredContent: { run: loaded.run as unknown as Record<string, unknown>, evidenceIndex: loaded.evidenceIndex, verdicts: loaded.verdicts as unknown as Record<string, unknown>[], interrupts },
      };
    }
  );
  registerReadOnlyTool(
    server,
    "map",
    {
      title: "Code map",
      description: "The deterministic code map: its freshness, or one question: deps (what a module depends on), impact (what depends on it), who_uses (modules using an exported symbol; name or path#name), check (violations of project.json map.rules), routes (HTTP routes found by syntax; target a URL prefix, a module path, or omit for all). Read-only; building the map is the CLI's job.",
      inputSchema: { query: z.enum(["freshness", "deps", "impact", "who_uses", "check", "routes"]), target: z.string().optional() },
      outputSchema: z.object({ freshness: z.enum(MAP_FRESHNESS), snapshotId: z.string().optional(), reason: z.string().optional(), result: MapQueryResultSchema.optional() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const query = String(args.query);
      if (query === "freshness") {
        const s = await mapStatus(ws);
        return { content: [{ type: "text", text: `Map is ${s.freshness}.` }], structuredContent: { freshness: s.freshness, ...(s.snapshot ? { snapshotId: s.snapshot.id } : {}), ...(s.reason ? { reason: s.reason } : {}) } };
      }
      if (query === "check") {
        const project = await ws.project.load();
        const rules = project.kind === "valid" ? rulesOf(project.config) : undefined;
        if (!rules) return { content: [{ type: "text", text: "The project declares no map.rules." }], structuredContent: { freshness: (await mapStatus(ws)).freshness }, isError: true };
        const check = await checkArchitecture(ws, rules, { requireFresh: false });
        if (check.kind === "not_fresh") return { content: [{ type: "text", text: "There is no map index; run legion-flow map." }], structuredContent: { freshness: check.status.freshness }, isError: true };
        const result = { schema: SCHEMA_VERSIONS.MAP_QUERY, query: { kind: "check" as const, target: `rules:${check.rulesSha256.slice(0, 16)}` }, snapshotId: check.snapshotId, freshness: check.status.freshness, modules: [], usedBy: [], candidates: [], external: [], violations: check.violations, routes: [] };
        return { content: [{ type: "text", text: `${check.violations.length} rule violation(s) (map ${check.status.freshness}).` }], structuredContent: { freshness: check.status.freshness, snapshotId: check.snapshotId, result: result as unknown as Record<string, unknown> } };
      }
      const target = typeof args.target === "string" && args.target ? args.target : query === "routes" ? "*" : "";
      if (!target) return { content: [{ type: "text", text: `${query} needs a target.` }], structuredContent: { freshness: (await mapStatus(ws)).freshness }, isError: true };
      const outcome = await runMapQuery(ws, query as "deps" | "impact" | "who_uses" | "routes", target);
      const base = { freshness: outcome.status.freshness, ...(outcome.status.snapshot ? { snapshotId: outcome.status.snapshot.id } : {}), ...(outcome.status.reason ? { reason: outcome.status.reason } : {}) };
      if (outcome.kind === "no_index") return { content: [{ type: "text", text: "There is no map index; run legion-flow map." }], structuredContent: base, isError: true };
      if (outcome.kind === "unknown_target") return { content: [{ type: "text", text: `'${outcome.target}' is not a module in the map.` }], structuredContent: base, isError: true };
      const r = outcome.result;
      const n = query === "routes" ? `${r.routes.length} routes` : query === "who_uses" ? (r.candidates.length ? `${r.candidates.length} candidates` : `${r.usedBy.length} modules`) : `${r.modules.length} modules`;
      return { content: [{ type: "text", text: `${query} ${r.query.target}: ${n} (map ${r.freshness}).` }], structuredContent: { ...base, result: r as unknown as Record<string, unknown> } };
    }
  );
  registerReadOnlyTool(
    server,
    "recall",
    {
      title: "Recall",
      description: "What the map and memory say about a question, in authority order: the deterministic map, deterministic facts, human facts and human-committed observations, facts an agent recorded (unverified), then agent run summaries (unverified). Optional world time (asOf) and record time (knownAt). Read-only.",
      inputSchema: { query: z.string().optional(), subject: z.string().optional(), predicate: z.string().optional(), asOf: z.string().optional(), knownAt: z.string().optional(), budget: z.number().int().min(50).max(20000).optional() },
      outputSchema: z.object({ recall: RecallDocSchema.optional(), error: z.string().optional() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = (k: string) => (typeof args[k] === "string" && (args[k] as string).length > 0 ? (args[k] as string) : undefined);
      const fail = (error: string) => ({ content: [{ type: "text" as const, text: error }], structuredContent: { error }, isError: true });
      if (!s("query") && !s("subject")) return fail("recall needs a query, a subject, or both");
      for (const k of ["asOf", "knownAt"]) if (s(k) && Number.isNaN(Date.parse(s(k)!))) return fail(`${k} is not a time`);
      const project = await ws.project.load();
      if (project.kind !== "valid") return fail("no project is initialized here");
      const doc = await recall(ws, { ...(s("query") ? { text: s("query")! } : {}), ...(s("subject") ? { subject: s("subject")! } : {}), ...(s("predicate") ? { predicate: s("predicate")! } : {}), ...(s("asOf") ? { asOf: s("asOf")! } : {}), ...(s("knownAt") ? { knownAt: s("knownAt")! } : {}), ...(typeof args.budget === "number" ? { budget: args.budget } : {}) });
      const counts = doc.blocks.map((b) => `${b.source} ${b.items.length}`).join(", ");
      return { content: [{ type: "text" as const, text: `Recall: ${counts}.` }], structuredContent: { recall: doc as unknown as Record<string, unknown> } };
    }
  );
  return server;
}

/** Serve until the client disconnects. */
export async function serveStdio(ctx: CommandContext): Promise<void> {
  const server = buildServer(ctx);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  await closed;
}

/**
 * Streamable HTTP on 127.0.0.1 (M4 slice f). Stateless: every POST gets a fresh server and transport, so GET
 * and DELETE (sessions, server-sent notifications) answer 405. Before any body is read: the Host header must
 * be loopback with this port, an Origin header must be a loopback origin (DNS-rebinding protection, done here
 * because the SDK's own options are deprecated), and the bearer token must match. The token is generated at
 * start and printed to stderr, and written to --token-file when given; never to stdout.
 */
export async function serveHttp(ctx: CommandContext, opts: { port: number; tokenFile?: string }): Promise<void> {
  const { createServer } = await import("node:http");
  const { randomBytes, timingSafeEqual } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let port = 0;
  const server = createServer(async (req, res) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!hosts.includes(req.headers.host ?? "")) return void res.writeHead(403).end();
    const origin = req.headers.origin;
    if (origin !== undefined && !hosts.map((h) => `http://${h}`).includes(origin)) return void res.writeHead(403).end();
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return void res.writeHead(401).end();
    if ((req.url ?? "").split("?")[0] !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
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
    const mcp = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  if (opts.tokenFile) await writeFile(opts.tokenFile, token + "\n", { mode: 0o600 });
  process.stderr.write(`legion-flow mcp: listening http://127.0.0.1:${port}/mcp (loopback only; use 127.0.0.1, not localhost)\n`);
  process.stderr.write(opts.tokenFile ? `legion-flow mcp: bearer token written to ${opts.tokenFile}\n` : `legion-flow mcp: bearer token ${token}\n`);
  await new Promise<void>((resolve) => server.on("close", () => resolve()));
}
