import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "..", "dist", "fake-mcp-server.js");
const node = `"${process.execPath}"`;

async function project(opts: { server?: Record<string, unknown>; tools?: string[]; toolCalls?: unknown[]; maxSteps?: number }) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-toolgw-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Tools", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.mcpServers = [{ name: "fake", command: process.execPath, args: [fakeServer], ...(opts.server ?? {}) }];
  if (opts.maxSteps) cfg.toolPolicy = { maxSteps: opts.maxSteps };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Tools" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Use tools", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] }, ...(opts.tools ? { tools: opts.tools } : {}) }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }], toolCalls: opts.toolCalls ?? [] }));
  const exec = (o: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...o });
  return { root, ws, ctx, exec, approved };
}

/** What the run recorded: its tool_call and tool_server_failed evidence, the summary the fake agent wrote, and its brief and prompt. */
async function runRecords(ws: Workspace, runId: string) {
  const loaded = (await ws.runs.load(runId))!;
  const records = await Promise.all(loaded.evidenceIndex.map(async (e) => ({ producedBy: e.producedBy, rec: JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any> })));
  const calls = records.filter((r) => r.rec.kind === "tool_call").map((r) => r.rec).sort((a, b) => a.step - b.step);
  const failed = records.filter((r) => r.rec.kind === "tool_server_failed").map((r) => r.rec);
  const summary = records.find((r) => r.rec.kind === "agent_summary")?.rec.text as string;
  const brief = await readFile(join(ws.paths.cacheRunsDir, runId, "brief.json"), "utf8");
  const prompt = await readFile(join(ws.paths.cacheRunsDir, runId, "prompt.md"), "utf8");
  return { calls, failed, summary, brief, prompt };
}

describe("M4 slice (k): the tool gateway on the host tier", () => {
  test("default policy exposes the read tool only; a relayed call, a refused call, and an unknown name are each recorded; the token stays out of the brief, the prompt, and the evidence", async () => {
    const { root, ws, exec } = await project({ tools: ["fake"], toolCalls: [{ name: "fake__read_notes", arguments: { note: "${LF_TOOLS_TOKEN}" } }, { name: "fake__delete_note", arguments: { id: "1" } }, { name: "nope__x" }] });
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await runRecords(ws, env.runId!);
      assert.match(r.summary, /- listed: fake__read_notes\n/);
      assert.match(r.summary, /- fake__read_notes: ok fake-mcp read_notes \{"note":"\[redacted\]"\}/);
      assert.match(r.summary, /- fake__delete_note: error .*not a tool this task may call/);
      assert.match(r.summary, /- nope__x: error/);
      assert.deepEqual(r.calls.map((c) => `${c.step}:${c.verdict}`), ["1:relayed", "2:refused_policy", "3:unknown_tool"]);
      assert.match(r.calls[0]!.args, /\[redacted\]/, "the agent passed its token as an argument; the evidence never holds it");
      assert.match(r.brief, /"fake__read_notes"/);
      assert.match(r.prompt, /<untrusted-content source="tools">\n- fake__read_notes \(read\): Read notes/);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; calls?: number; refused?: number; budget?: number });
      const summaryEvent = events.find((e) => e.type === "tool_calls")!;
      assert.deepEqual([summaryEvent.calls, summaryEvent.refused, summaryEvent.budget], [3, 2, 20]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allowRisk and deny shape what is exposed; a task naming one tool sees only that one", async () => {
    const a = await project({ server: { allowRisk: ["read", "network"], deny: ["read_notes"] }, tools: ["fake"], toolCalls: [] });
    try {
      const env = await a.exec();
      assert.match((await runRecords(a.ws, env.runId!)).summary, /- listed: fake__add_memory, fake__fetch_url\n/);
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({ server: { allowRisk: ["edit", "read"] }, tools: ["fake.mystery"], toolCalls: [{ name: "fake__read_notes" }] });
    try {
      const env = await b.exec();
      const r = await runRecords(b.ws, env.runId!);
      assert.match(r.summary, /- listed: fake__mystery\n/);
      assert.equal(r.calls[0]!.verdict, "refused_policy", "a tool the task did not name is refused even though its risk class is allowed");
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("the step budget refuses the call past it and the run still completes; a task without tools starts no gateway", async () => {
    const a = await project({ tools: ["fake"], maxSteps: 2, toolCalls: [{ name: "fake__read_notes" }, { name: "fake__read_notes" }, { name: "fake__read_notes" }] });
    try {
      const env = await a.exec();
      assert.equal(env.status, "ok");
      assert.deepEqual((await runRecords(a.ws, env.runId!)).calls.map((c) => c.verdict), ["relayed", "relayed", "refused_budget"]);
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({ toolCalls: [{ name: "fake__read_notes" }] });
    try {
      const env = await b.exec();
      assert.match((await runRecords(b.ws, env.runId!)).summary, /- listed: error no LF_TOOLS_URL/);
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("a server that cannot start leaves an empty list, an error on call, and a record; the run still completes", async () => {
    const { root, ws, exec } = await project({ server: { args: ["-e", "process.exit(3)"] }, tools: ["fake"], toolCalls: [{ name: "fake__read_notes" }] });
    try {
      const env = await exec();
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await runRecords(ws, env.runId!);
      assert.match(r.summary, /- listed: \(none\)/);
      assert.equal(r.calls[0]!.verdict, "server_unavailable");
      assert.equal(r.failed[0]!.server, "fake");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a task naming an undeclared server is refused at approve plan", async () => {
    const { root, approved } = await project({ tools: ["ghost"] });
    try {
      assert.ok(approved.diagnostics.some((d) => d.code === "plan_tool_server_unknown"), JSON.stringify(approved.diagnostics));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (k): the tool gateway under vm-docker", async () => {
  const image = resolveDockerSettings(undefined).image;
  const present = await promisify(execFile)("docker", ["image", "inspect", image]).then(() => true, () => false);
  test("the agent reaches the gateway only through its egress proxy, which injects the token; the agent never holds it", { skip: present && process.platform !== "linux" ? undefined : "needs Docker Desktop and the pinned image" }, async () => {
    // The downstream server runs in the same image; its source travels inline, since the image does not carry it.
    const source = await readFile(fakeServer, "utf8");
    const { root, ws, exec } = await project({ server: { command: "node", args: ["--input-type=module", "-e", source], image }, tools: ["fake"], toolCalls: [{ name: "fake__read_notes", arguments: { probe: "docker" } }] });
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await runRecords(ws, env.runId!);
      assert.match(r.summary, /- listed: fake__read_notes\n/);
      assert.match(r.summary, /- fake__read_notes: ok fake-mcp read_notes \{"probe":"docker"\}/);
      assert.equal(r.calls[0]!.verdict, "relayed");
      const loaded = (await ws.runs.load(env.runId!))!;
      const outcomes = await Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { kind?: string; argv?: string[] }));
      const argv = outcomes.find((o) => o.kind === "adapter_outcome")!.argv!.join(" ");
      assert.match(argv, /LF_TOOLS_URL=http:\/\/lf-proxy-[^ ]+\/legion-tools\/mcp/, "the agent's gateway URL is the proxy route");
      assert.ok(!argv.includes("LF_TOOLS_TOKEN"), "the token never reaches the agent container");
      const tierRecord = outcomes.find((o) => o.kind === "sandbox_tier")!;
      assert.match(JSON.stringify(tierRecord), /legion-tools/, "the sandbox evidence names the gateway route it ran with");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("the gateway records who answered: one tool_server record per started server", () => {
  test("a declared server's reported name, version, and negotiated protocol version are evidence", async () => {
    const { root, ws, exec } = await project({ tools: ["fake"], toolCalls: [{ name: "fake__read_notes", arguments: {} }] });
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const loaded = (await ws.runs.load(env.runId!))!;
      const recs = await Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any>));
      const servers = recs.filter((r) => r.kind === "tool_server");
      assert.equal(servers.length, 1);
      assert.equal(servers[0]!.server, "fake");
      assert.equal(servers[0]!.builtin, false);
      assert.deepEqual(servers[0]!.serverInfo, { name: "fake-mcp", version: "1.0.0" });
      assert.match(servers[0]!.protocolVersion ?? "", /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(servers[0]!.tools > 0, "the count of tools the server listed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
