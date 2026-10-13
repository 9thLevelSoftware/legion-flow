/**
 * A deterministic fake stdio MCP server for tests. Built-ins only: under the
 * vm-docker tier this file runs alone in a plain node image, so an import of
 * any package would crash it before initialize. Newline-delimited JSON-RPC.
 * Four tools cover the annotation cases: read-only, destructive, open-world,
 * and none at all.
 */
let buffer = "";

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

import { appendFileSync } from "node:fs";

const TOOLS = [
  { name: "read_notes", description: "Read notes", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "delete_note", description: "Delete a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "fetch_url", description: "Fetch a URL", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: "mystery", description: "No hints at all", inputSchema: { type: "object", properties: {} } },
  // M4 slice n2: Graphiti's add_memory shape, for the memory_export hook.
  { name: "add_memory", description: "Add an episode to memory", inputSchema: { type: "object", properties: { name: { type: "string" }, episode_body: { type: "string" }, source_description: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
];

function handle(msg: { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }): void {
  if (msg.method === undefined || msg.id === undefined) return; // notifications (initialized) and responses
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: process.argv.includes("--version-two") ? "2.0.0" : "1.0.0" } } });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      // M4 slice k: a deterministic answer naming the tool and echoing its arguments, so a test can see the relay.
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
      // --log <path> appends each call's arguments as a line, so a test can read what was sent; --memory-error answers add_memory with an error.
      const logAt = process.argv.indexOf("--log");
      if (logAt >= 0 && process.argv[logAt + 1]) appendFileSync(process.argv[logAt + 1]!, JSON.stringify({ name, arguments: msg.params?.arguments ?? {} }) + "\n");
      if (name === "add_memory" && process.argv.includes("--memory-error")) return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "memory store unavailable" }], isError: true } });
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `fake-mcp ${name} ${JSON.stringify(msg.params?.arguments ?? {})}` }] } });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
