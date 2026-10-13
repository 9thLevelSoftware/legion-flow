import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { riskForAnnotations, ToolProbeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { hostSession, dockerSession, realDockerCli, resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initCommand, toolsCommand, runDoctor, type SystemProbe } from "../dist/index.js";
import { probeServer } from "../dist/mcp-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "..", "dist", "fake-mcp-server.js");
const bin = join(here, "..", "dist", "bin.js");

async function project(servers: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-mcpout-"));
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Out", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.mcpServers = servers;
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  return { root, ws, ctx };
}

describe("M4 slice (f): outbound MCP servers (ADR-0005 spike)", () => {
  test("annotations map to one risk class, most cautious first; contradictory hints are flagged", () => {
    assert.deepEqual(riskForAnnotations({ readOnlyHint: true }), { riskClass: "read" });
    assert.deepEqual(riskForAnnotations({ destructiveHint: true }), { riskClass: "create_delete" });
    assert.deepEqual(riskForAnnotations({ readOnlyHint: true, openWorldHint: true }), { riskClass: "network" });
    assert.deepEqual(riskForAnnotations(undefined), { riskClass: "edit" }, "no hints is not a promise");
    assert.equal(riskForAnnotations({ readOnlyHint: true, destructiveHint: true }).riskClass, "create_delete");
    assert.match(riskForAnnotations({ readOnlyHint: true, destructiveHint: true }).conflict ?? "", /both true/);
  });

  test("tools probes a server on the host through our own spawn and transport: identity, protocol, five tools with mapped risks, nothing called", async () => {
    const { root, ctx } = await project([{ name: "fake", command: process.execPath, args: [fakeServer] }]);
    try {
      const r = await toolsCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(r.status, "ok", JSON.stringify(r.diagnostics));
      assert.match(r.diagnostics.find((d) => d.code === "mcp_probe")!.message, /fake-mcp 1\.0\.0, protocol \S+, 5 tool\(s\)/);
      assert.deepEqual(r.diagnostics.filter((d) => d.code === "mcp_tool").map((d) => d.message), ["fake.add_memory: network", "fake.delete_note: create_delete", "fake.fetch_url: network", "fake.mystery: edit", "fake.read_notes: read"]);
      const record = ToolProbeSchema.parse(JSON.parse(await readFile(r.diagnostics.find((d) => d.code === "mcp_probe")!.path!, "utf8")));
      assert.ok(record.protocolVersion, "the negotiated protocol version is recorded");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("the Windows .cmd shim: a server launched through a .cmd file by absolute path probes the same way", { skip: process.platform === "win32" ? undefined : "Windows only" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-mcpshim-"));
    await copyFile(fakeServer, join(dir, "fake-mcp-server.js"));
    await writeFile(join(dir, "probe.cmd"), '@node "%~dp0fake-mcp-server.js" %*\r\n');
    const { root, ctx } = await project([{ name: "shim", command: join(dir, "probe.cmd") }]);
    try {
      const r = await toolsCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(r.status, "ok", JSON.stringify(r.diagnostics));
      assert.equal(r.diagnostics.filter((d) => d.code === "mcp_tool").length, 5);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("refusals before anything starts, and a server that is not an MCP server fails with its stderr", async () => {
    const { root, ctx } = await project([{ name: "fake", command: process.execPath, args: [fakeServer] }, { name: "broken", command: process.execPath, args: ["-e", "console.error('not mcp'); process.exit(3)"] }]);
    try {
      assert.equal((await toolsCommand(ctx(), {})).diagnostics[0]?.code, "mcp_server_image_missing");
      assert.equal((await toolsCommand(ctx(), { sandbox: "unhardened" })).diagnostics[0]?.code, "sandbox_not_hardened");
      assert.equal((await toolsCommand(ctx(false), { sandbox: "unhardened", allowNoSandbox: true })).diagnostics[0]?.code, "sandbox_confirmation_requires_tty");
      assert.equal((await toolsCommand(ctx(), { server: "nope" })).diagnostics[0]?.code, "mcp_server_unknown");
      const broken = await toolsCommand(ctx(), { server: "broken", sandbox: "unhardened", allowNoSandbox: true });
      assert.equal(broken.status, "blocked");
      assert.match(broken.diagnostics.find((d) => d.code === "mcp_probe_failed")!.message, /not mcp/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    const none = await project([]);
    try {
      assert.equal((await toolsCommand(none.ctx(), {})).diagnostics[0]?.code, "mcp_servers_absent");
    } finally {
      await rm(none.root, { recursive: true, force: true });
    }
  });

  test("doctor warns on a download-and-run launcher and a missing image, and starts nothing", async () => {
    const { root, ws } = await project([{ name: "pkg", command: "npx", args: ["-y", "some-mcp-server"] }]);
    try {
      const probe: SystemProbe = { nodeVersion: () => "24.0.0", which: async () => [], run: async () => null, sqlite: async () => ({ ok: true, sqliteVersion: "3" }), browser: async () => null };
      const item = (await runDoctor(ws, probe)).diagnostics.find((d) => d.code === "mcp_server_pkg")!;
      assert.equal(item.status, "warn");
      assert.match(item.message, /downloads and runs a package/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the hardened tier, where Docker and the pinned image answer", async () => {
  const image = resolveDockerSettings(undefined).image;
  const present = await promisify(execFile)("docker", ["image", "inspect", image]).then(() => true, () => false);
  test("the fake server inside docker run -i (no network, tree read-only) probes the same way", { skip: present ? undefined : `${image} is not present locally` }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-mcpdocker-"));
    try {
      const base = dockerSession(realDockerCli, resolveDockerSettings(undefined), `lf-mcp-test-${Date.now().toString(36)}`);
      const open = (spec: Parameters<typeof base>[0]) => base({ ...spec, extraMounts: [{ host: dirname(fakeServer), guest: "/legion/mcp", readonly: true }] });
      const probe = await probeServer({ name: "fake", command: "node", args: ["/legion/mcp/fake-mcp-server.js"] }, "vm-docker", open, root, {}, "test");
      assert.equal(probe.ok, true, probe.reason);
      assert.equal(probe.tools.length, 5);
      assert.equal(probe.serverInfo?.name, "fake-mcp");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
  void hostSession;
});

describe("M4 slice (f): mcp --http", () => {
  test("loopback only, with a token: 401 without it, 403 for a foreign Origin, the seven read-only tools with it", async () => {
    const { root } = await project([]);
    const child = spawn(process.execPath, [bin, "mcp", "--http", "--port", "0"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    try {
      const { port, token } = await new Promise<{ port: number; token: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no listening line: ${stderr}`)), 15_000);
        child.stderr.on("data", (c) => {
          stderr += c;
          const p = /listening http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
          const t = /bearer token ([0-9a-f]{64})/.exec(stderr);
          if (p && t) {
            clearTimeout(timer);
            resolve({ port: Number(p[1]), token: t[1]! });
          }
        });
      });
      const url = `http://127.0.0.1:${port}/mcp`;
      const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
      const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(ping) });
      assert.equal((await post({})).status, 401);
      assert.equal((await post({ authorization: "Bearer " + "0".repeat(64) })).status, 401);
      assert.equal((await post({ authorization: `Bearer ${token}`, origin: "http://evil.example" })).status, 403);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405, "stateless: GET is not served");
      const client = new Client({ name: "legion-flow-test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["doctor", "map", "next", "recall", "runs", "show", "status"]);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
      await client.close();
      assert.equal(stdout, "", "nothing on stdout, and the token never there");
    } finally {
      child.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
