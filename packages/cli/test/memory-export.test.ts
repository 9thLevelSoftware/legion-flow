import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HookConfigSchema, SCHEMA_VERSIONS } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, learnCommand, hooksCommand, observeCommand, decideCommand } from "../dist/index.js";
import { flushHooks } from "../dist/hooks.js";

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "fake-mcp-server.js");

async function project(hook: Record<string, unknown> = {}, serverArgs: string[] = [], extra: (cfg: Record<string, any>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-memexport-"));
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  const log = join(root, "memory-calls.jsonl");
  await initCommand(ctx(), { adapter: "fake", name: "Export", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.mcpServers = [{ name: "memory", command: process.execPath, args: [fakeServer, "--log", log, ...serverArgs] }];
  cfg.hooks = [{ name: "graph", kind: "memory_export", server: "memory", sandbox: "unhardened", ...hook }];
  extra(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const sent = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; arguments: Record<string, string> });
  return { root, ws, ctx, log, sent };
}

describe("M4 slice (n2): the memory_export hook", () => {
  test("after consent a human fact goes out with the three fields; an agent fact, a corroboration, and a fact from before consent do not; nothing pending starts no server", async () => {
    const { root, ws, ctx, log, sent } = await project();
    try {
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "owner", text: "platform team", approver: "lead" });
      assert.equal((await hooksCommand(ctx(), { enable: "graph", approver: "lead" })).status, "ok");
      assert.match((await hooksCommand(ctx(), {})).diagnostics[0]!.message, /graph -> MCP server memory\.add_memory \(unhardened\) on facts and observations \(memory_export\): enabled/);
      assert.deepEqual(await flushHooks(ws), []);
      await assert.rejects(access(log), "with nothing pending the server was never started");
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "runs_on", text: "github actions", approver: "lead" });
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "flaky", text: "sometimes" });
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "runs_on", text: "github actions", approver: "lead" });
      const out = await flushHooks(ws);
      assert.match(out.find((d) => d.code === "hook_delivered")!.message, /exported 1 item/);
      const calls = await sent();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.name, "add_memory");
      assert.deepEqual(Object.keys(calls[0]!.arguments).sort(), ["episode_body", "name", "source_description"]);
      assert.equal(calls[0]!.arguments.episode_body, "topic:ci runs_on github actions");
      assert.match(calls[0]!.arguments.source_description, /^legion-flow human fact, valid from /);
      assert.ok(!JSON.stringify(calls).includes("lead"), "no person's identifier leaves");
      assert.deepEqual(await flushHooks(ws), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("includeLlm sends agent facts; a committed observation and a retro's facts go out, the retro's in order", async () => {
    const { root, ws, ctx, sent } = await project({ includeLlm: true });
    try {
      await hooksCommand(ctx(), { enable: "graph", approver: "lead" });
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "flaky_in", object: "module:src/net.ts" });
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "flaky_in", object: "module:src/net.ts" });
      const id = (await observeCommand(ctx(), {})).diagnostics.find((d) => d.code === "observation_candidate")!.message.match(/obc_[0-9a-f]{12}/)![0];
      const proposed = await observeCommand(ctx(), { propose: id });
      await decideCommand(ctx(), { interruptId: (proposed.nextAction as { interruptId: string }).interruptId, approve: true, approver: "lead" });
      await observeCommand(ctx(), { resume: true });
      // The retro event's shape, recorded directly: a release is not needed to show the export.
      await ws.lock.withLock(async (held) => {
        const { episode } = await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "retro", createdAt: new Date().toISOString(), releaseId: "rel_test1", facts: ["first", "second"].map((t, i) => ({ id: `fct_retro${i}`, subject: "release:rel_test1", predicate: "note", object: { text: t }, validAt: new Date().toISOString(), createdAt: new Date().toISOString(), origin: "deterministic" as const })) }, held);
        await ws.audit.append({ type: "retro_recorded", releaseId: "rel_test1", episodeId: episode.id, facts: 2 }, held);
      }, "test");
      await flushHooks(ws);
      const bodies = (await sent()).map((c) => c.arguments.episode_body);
      assert.equal(bodies[0], "topic:ci flaky_in module:src/net.ts", "the agent fact, with includeLlm");
      assert.ok(bodies.some((b) => b.startsWith("flaky_in module:src/net.ts: ")), "the committed observation");
      assert.deepEqual(bodies.slice(-2), ["release:rel_test1 note first", "release:rel_test1 note second"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a tool error is retried and a server that cannot start pauses the hook, with nothing skipped; editing the server's arguments ends the consent", async () => {
    const a = await project({}, ["--memory-error"]);
    try {
      await hooksCommand(a.ctx(), { enable: "graph", approver: "lead" });
      await learnCommand(a.ctx(), { subject: "topic:x", predicate: "p", text: "v", approver: "lead" });
      assert.match((await flushHooks(a.ws))[0]!.message, /the tool answered an error: memory store unavailable; attempt 1 of 5/);
      assert.match((await flushHooks(a.ws))[0]!.message, /attempt 2 of 5/);
      const cfg = JSON.parse(await readFile(a.ws.paths.projectConfig, "utf8"));
      cfg.mcpServers[0].args = [fakeServer];
      await writeFile(a.ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      assert.match((await hooksCommand(a.ctx(), {})).diagnostics[0]!.message, /disabled \(the hook changed after consent; consent again\)/, "the consent covers the server it names");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({}, [], (cfg) => (cfg.mcpServers[0].args = ["-e", "process.exit(3)"]));
    try {
      await hooksCommand(b.ctx(), { enable: "graph", approver: "lead" });
      await learnCommand(b.ctx(), { subject: "topic:x", predicate: "p", text: "v", approver: "lead" });
      // M4 slice s: a server that cannot start pauses the hook; nothing counts toward abandoning the item.
      for (let i = 0; i < 6; i++) assert.match((await flushHooks(b.ws))[0]!.message, /is paused: server memory could not start/);
      assert.equal((await readFile(b.ws.paths.eventsJsonl, "utf8")).split("\n").filter((l) => l.includes('"hook_delivery_failed"')).length, 1, "the pause is recorded once");
      assert.ok(!(await readFile(b.ws.paths.eventsJsonl, "utf8")).includes('"hook_delivery_abandoned"'));
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("--enable refuses an undeclared server and, under sandbox.require, a hook that would run its server on the host", async () => {
    const a = await project({ server: "ghost" });
    try {
      assert.equal((await hooksCommand(a.ctx(), { enable: "graph", approver: "lead" })).diagnostics[0]?.code, "hook_server_unknown");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await project({}, [], (cfg) => (cfg.sandbox = { require: true }));
    try {
      assert.equal((await hooksCommand(b.ctx(), { enable: "graph", approver: "lead" })).diagnostics[0]?.code, "sandbox_required_by_policy");
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("the default tier: the server runs in the hardened container and the fact goes out through its pipes", async (t) => {
    const image = resolveDockerSettings(undefined).image;
    if (!(await promisify(execFile)("docker", ["image", "inspect", image]).then(() => true, () => false))) return t.skip(`${image} is not present locally`);
    // The image does not carry the fake server, so its source travels inline; the container is read-only, so the
    // call is proven by the audit chain and the diagnostic rather than a log file.
    const source = await readFile(fakeServer, "utf8");
    const { root, ws, ctx } = await project({ sandbox: undefined }, [], (cfg) => (cfg.mcpServers = [{ name: "memory", command: "node", args: ["--input-type=module", "-e", source], image }]));
    try {
      assert.equal((await hooksCommand(ctx(), { enable: "graph", approver: "lead" })).status, "ok");
      await learnCommand(ctx(), { subject: "topic:ci", predicate: "runs_on", text: "github actions", approver: "lead" });
      const out = await flushHooks(ws);
      assert.match(out.find((d) => d.code === "hook_delivered")?.message ?? JSON.stringify(out), /exported 1 item/);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(events.some((e) => e.type === "hook_delivered" && e.hook === "graph"), "the delivery is on the audit chain");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("schema: a memory_export hook names a server and takes no url or secrets; the server fields belong to it alone", () => {
    assert.equal(HookConfigSchema.safeParse({ name: "g", kind: "memory_export", server: "memory" }).success, true);
    assert.equal(HookConfigSchema.safeParse({ name: "g", kind: "memory_export" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "g", kind: "memory_export", server: "memory", url: "https://x.example" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "g", on: ["shipped"], url: "https://x.example", server: "memory" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "g", on: ["shipped"] }).success, false, "an event hook needs a url");
  });
});

describe("M4 slice (t): retirements", () => {
  test("an approved supersession exports the new fact, then the retired one as <id>#retired naming its successor; the old fact is not sent again", async () => {
    const { root, ctx, ws, sent } = await project();
    try {
      await hooksCommand(ctx(), { enable: "graph", approver: "lead" });
      const first = await learnCommand(ctx(), { subject: "topic:ci", predicate: "owner", text: "platform team", approver: "lead" });
      const oldId = first.diagnostics.map((d) => /fct_[0-9a-z]+/.exec(d.message)?.[0]).find(Boolean)!;
      await flushHooks(ws);
      assert.deepEqual((await sent()).map((c) => c.arguments.name), [oldId]);
      const proposed = await learnCommand(ctx(), { subject: "topic:ci", predicate: "owner", text: "release team", supersedes: [oldId], approver: "lead" });
      assert.equal(proposed.status, "awaiting_decision", JSON.stringify(proposed.diagnostics));
      await decideCommand(ctx(), { interruptId: (proposed.nextAction as { interruptId: string }).interruptId, approve: true, approver: "lead" });
      await learnCommand(ctx(), { resume: true });
      await flushHooks(ws);
      const calls = (await sent()).slice(1);
      assert.equal(calls.length, 2, JSON.stringify(calls));
      assert.equal(calls[0]!.arguments.episode_body, "topic:ci owner release team");
      assert.equal(calls[1]!.arguments.name, `${oldId}#retired`);
      assert.match(calls[1]!.arguments.episode_body, new RegExp(`^retired: topic:ci owner platform team; superseded by fct_[0-9a-z]+$`));
      assert.match(calls[1]!.arguments.source_description, /^legion-flow supersession, recorded \d{4}-/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
