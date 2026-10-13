/**
 * M4 slice (q): the installed codex CLI, driven by the real codex adapter and the host tier's exec (so the .cmd shim,
 * the frozen spawn, and the adapter's own argv are what run), connects to a loopback MCP server with the bearer token
 * from LF_TOOLS_TOKEN at session start. It runs only when codex is on PATH. It makes no model call: CODEX_HOME is a
 * throwaway directory (never the user's login), OPENAI_API_KEY is removed, and the model provider is a dead loopback
 * port. The run is aborted as soon as tools/list arrives, and no codex process may outlive the abort.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecSpec } from "@9thlevelsoftware/legion-flow-engine";
import { adapterById } from "@9thlevelsoftware/legion-flow-adapters";
import { hostExec } from "@9thlevelsoftware/legion-flow-sandbox";

const run = promisify(execFile);
const codexOnPath = await run(process.platform === "win32" ? "where.exe" : "which", ["codex"]).then(() => true, () => false);

/** Command lines of live processes that mention `needle` (Windows only; elsewhere the check is skipped). */
async function processesMentioning(needle: string): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle.replace(/'/g, "''")}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name }`]);
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

describe("M4 slice (q): codex and the tool gateway, against the installed CLI", () => {
  test("the codex adapter's -c overrides make codex initialize and list tools with the bearer token, before any model call; abort leaves no codex behind", { skip: codexOnPath ? undefined : "codex is not on PATH" }, async () => {
    const seen: { auth: string | null; rpc: string | null }[] = [];
    const controller = new AbortController();
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let msg: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
        try {
          msg = JSON.parse(body);
        } catch {
          // not JSON
        }
        seen.push({ auth: req.headers.authorization ?? null, rpc: msg.method ?? null });
        const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gateway-probe", version: "1" } });
        else if (msg.method === "tools/list") {
          reply({ tools: [{ name: "fake__read_notes", description: "Read notes", inputSchema: { type: "object", properties: {} } }] });
          controller.abort();
        } else if (msg.id !== undefined) reply({});
        else res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const root = await mkdtemp(join(tmpdir(), "lf-codex-gw-"));
    const home = join(root, "codex-home");
    const tree = join(root, "tree");
    const runDir = join(root, "run");
    await mkdir(home, { recursive: true });
    await mkdir(tree, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "prompt.md"), "# probe\nReply with ok.\n");
    // The test's only changes to what the adapter asked for: an isolated codex home, no real key, a dead loopback provider.
    const isolated = (spec: ExecSpec) =>
      hostExec({
        ...spec,
        env: { ...Object.fromEntries(Object.entries(spec.env).filter(([k]) => k.toUpperCase() !== "OPENAI_API_KEY")), CODEX_HOME: home, LF_PROBE_KEY: "dummy" },
        args: (map) => {
          const a = spec.args(map);
          return [a[0]!, "-c", "model_provider=lfprobe", "-c", "model_providers.lfprobe.name=lfprobe", "-c", "model_providers.lfprobe.base_url=http://127.0.0.1:9/v1", "-c", "model_providers.lfprobe.env_key=LF_PROBE_KEY", ...a.slice(1)];
        },
      });
    try {
      const outcome = await adapterById("codex")!.run({ runId: "run_codexgw", workspaceRoot: root, treeDir: tree, promptPath: join(runDir, "prompt.md"), signal: controller.signal, timeoutMs: 90_000, exec: isolated, envMode: "host", tools: { url: `http://127.0.0.1:${port}/mcp`, token: "probe-token-q" } });
      assert.ok(seen.some((s) => s.rpc === "initialize"), `codex never initialized: ${outcome.stderrTail.slice(-400)}`);
      assert.ok(seen.some((s) => s.rpc === "tools/list"), "codex never listed tools");
      assert.ok(seen.filter((s) => s.rpc).every((s) => s.auth === "Bearer probe-token-q"), JSON.stringify(seen));
      assert.equal(outcome.timedOut, false, "the abort, not the timeout, ended the run");
      assert.match(outcome.argv!.join(" "), /mcp_servers\.legion\.url=http:\/\/127\.0\.0\.1:\d+\/mcp/);
      assert.ok(!outcome.argv!.join(" ").includes("probe-token-q"), "the token is never in the argv");
      await new Promise((r) => setTimeout(r, 3000));
      assert.deepEqual(await processesMentioning(tree), [], "no codex process outlived the abort");
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });
});

describe("M4 slice (aa): the installed codex reads Legion's catalog and speaks Responses to a provider (no model call)", () => {
  test("codex posts /v1/responses with the configured model, the freeform patch tool, no web search, and Bearer from the renamed variable", { skip: codexOnPath ? undefined : "codex is not on PATH" }, async () => {
    const seen: { path: string; auth: string | null; body: Record<string, any> | null }[] = [];
    const controller = new AbortController();
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: Record<string, any> | null = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null, body: parsed });
        res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"probe"}}');
        controller.abort();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const root = await mkdtemp(join(tmpdir(), "lf-codex-prov-"));
    const home = join(root, "codex-home");
    const tree = join(root, "tree");
    const runDir = join(root, "run");
    await mkdir(home, { recursive: true });
    await mkdir(tree, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "prompt.md"), "# probe\nReply with ok.\n");
    process.env.LF_PROBE_PROVIDER_KEY = "probe-provider-value";
    // The test's only change to what the adapter asked for: an isolated codex home.
    const isolated = (spec: ExecSpec) => hostExec({ ...spec, env: { ...spec.env, CODEX_HOME: home } });
    try {
      const adapter = adapterById("codex", { provider: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "LF_PROBE_PROVIDER_KEY", model: "probe-model-1" } })!;
      const outcome = await adapter.run({ runId: "run_codexprov", workspaceRoot: root, treeDir: tree, promptPath: join(runDir, "prompt.md"), signal: controller.signal, timeoutMs: 90_000, exec: isolated, envMode: "host", model: "probe-model-1" });
      const first = seen.find((s) => s.path.endsWith("/responses"));
      assert.ok(first, `codex never posted to /responses: ${JSON.stringify(seen.map((s) => s.path))} ${outcome.stderrTail.slice(-600)}`);
      assert.equal(first!.path, "/v1/responses");
      assert.equal(first!.auth, "Bearer probe-provider-value", "the provider's variable reached codex as its bearer");
      assert.equal(first!.body?.model, "probe-model-1");
      // In Responses-lite mode (the catalog sets use_responses_lite) codex sends its tools as an additional_tools input item, not a top-level tools field.
      const tools = JSON.stringify([...(first!.body?.tools ?? []), ...((first!.body?.input ?? []) as { type?: string }[]).filter((i) => i.type === "additional_tools")]);
      assert.ok(((first!.body?.input ?? []) as { type?: string }[]).some((i) => i.type === "additional_tools"), "lite mode: tools travel as an input item");
      assert.match(tools, /apply_patch/, "the patch tool is offered");
      assert.doesNotMatch(JSON.stringify(first!.body), /"type":"web_search/, "web search is off");
      assert.ok(!/failed to parse model_catalog_json/.test(outcome.stderrTail), outcome.stderrTail.slice(-400));
    } finally {
      delete process.env.LF_PROBE_PROVIDER_KEY;
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });
});
