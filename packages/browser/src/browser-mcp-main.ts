/**
 * The browser container's entry (M4 slice o2): a newline JSON-RPC MCP server on
 * stdio around the session core. Built-ins and ./session-core.js only, because
 * this dist is mounted alone; playwright-core is the image's global install,
 * loaded by path. stdout belongs to the protocol: nothing else writes there.
 *
 * Config arrives in LF_BROWSER_CONFIG (no secret values: those are separate
 * variables named by the session's refs). Chromium goes through the run's
 * forward proxy (LF_BROWSER_PROXY). Each tool result carries the step records
 * and the session state in `_meta`, which the host strips into evidence.
 */
import { createRequire } from "node:module";
import { startBrowserSession, type BrowserToolServer, type CoreSession, type BrowserToolDef } from "./session-core.js";

interface Config {
  session: CoreSession;
  tools: BrowserToolDef[];
  runId: string;
  treeDir: string;
}

const config = JSON.parse(process.env.LF_BROWSER_CONFIG ?? "null") as Config | null;
const proxy = process.env.LF_BROWSER_PROXY;
const pending: Record<string, unknown>[] = [];
let server: BrowserToolServer | null = null;
let startError: string | null = null;

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const ready: Promise<void> = (async () => {
  if (!config) throw new Error("LF_BROWSER_CONFIG is not set");
  const pw = createRequire(import.meta.url)(process.env.LF_PLAYWRIGHT_CORE ?? "/usr/local/lib/node_modules/playwright-core") as typeof import("playwright-core");
  server = await startBrowserSession({
    session: config.session,
    tools: config.tools,
    treeDir: config.treeDir,
    env: process.env,
    runId: config.runId,
    // Screenshots travel once, as image content; the host re-attaches them to the step record.
    record: async (rec) => {
      const shot = rec.screenshot as { sha256: string } | undefined;
      pending.push(shot ? { ...rec, screenshot: { sha256: shot.sha256 } } : rec);
    },
    launch: async () => {
      // Loopback is the container itself (the served app), so it bypasses the proxy; Playwright otherwise forces loopback through it.
      const browser = await pw.chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"], ...(proxy ? { proxy: { server: proxy, bypass: "127.0.0.1,localhost,[::1]" } } : {}) });
      return { browser, info: { kind: "chromium", version: browser.version() } };
    },
  });
})().catch((err: unknown) => {
  startError = (err as Error).message.split("\n")[0]!.slice(0, 300);
});

async function handle(msg: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } }): Promise<void> {
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      // Answered only once the browser is up, so a session that cannot start fails the client's connect with the reason.
      await ready;
      if (startError) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `the browser session could not start: ${startError}` } });
      return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legion-flow-browser", version: "1" } } });
    case "ping":
      return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: (config?.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
    case "tools/call": {
      await ready;
      if (!server) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `the browser session is not running: ${startError ?? "unknown"}` } });
      const result = await server.call(msg.params?.name ?? "", msg.params?.arguments ?? {});
      return send({ jsonrpc: "2.0", id: msg.id, result: { ...result, _meta: { "legion-flow/records": pending.splice(0), "legion-flow/state": server.state() } } });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

// One request at a time, in order: the page is one shared resource.
let chain: Promise<void> = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    let msg: Parameters<typeof handle>[0];
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    chain = chain.then(() => handle(msg)).catch((err: unknown) => {
      process.stderr.write(`browser server: ${(err as Error).message}\n`);
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (err as Error).message.split("\n")[0]! } });
    });
  }
});
const stop = async () => {
  await ready.catch(() => undefined);
  await server?.close().catch(() => undefined);
  process.exit(0);
};
process.stdin.on("end", () => void stop());
process.on("SIGTERM", () => void stop());
