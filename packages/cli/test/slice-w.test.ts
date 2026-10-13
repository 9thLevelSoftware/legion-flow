import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, hooksCommand } from "../dist/index.js";
import { flushHooks } from "../dist/hooks.js";

const node = `"${process.execPath}"`;
const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "fake-mcp-server.js");

describe("M4 slice (w): one tool budget across the attempts of an execute --retry", () => {
  test("attempt 1 spends 15 of 20, attempt 2 gets the other 5 and is refused the rest; a later execute starts fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-w-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    try {
      await initCommand(ctx(), { adapter: "fake", name: "Budget", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      cfg.mcpServers = [{ name: "fake", command: process.execPath, args: [fakeServer] }];
      cfg.toolPolicy = { maxSteps: 20 };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      const created = await specCommand(ctx(), { new: "Budget" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2));
      await approveCommand(ctx(), { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx(), { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: "Use tools", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] }, tools: ["fake"] }];
      await writeFile(planJson, JSON.stringify(p, null, 2));
      await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
      const calls = Array.from({ length: 15 }, (_, i) => ({ name: "fake__read_notes", arguments: { n: i } }));
      await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }], toolCalls: calls, byAttempt: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 0 }] }));
      const exec = (o: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...o });

      await exec({ retry: 1 });
      const summaries = () => readFile(ws.paths.eventsJsonl, "utf8").then((t) => t.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>).filter((e) => e.type === "tool_calls"));
      const [first, second] = await summaries();
      assert.deepEqual([first!.calls, first!.refused, first!.usedBefore], [15, 0, undefined]);
      assert.deepEqual([second!.calls, second!.refused, second!.usedBefore], [15, 10, 15], "the second attempt had 5 left and was refused the other 10");
      const verdicts = async (runId: string) => {
        const loaded = (await ws.runs.load(runId))!;
        return Promise.all(loaded.evidenceIndex.filter((e) => e.producedBy === "tools").map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { kind: string; verdict?: string; args?: string }));
      };
      const refusedRec = (await verdicts(second!.runId)).find((r) => r.verdict === "refused_budget")!;
      assert.ok(refusedRec, "a refused call is recorded with the budget verdict");

      // A later execute of the same task is a new invocation: its budget starts fresh.
      await exec();
      const third = (await summaries())[2]!;
      assert.deepEqual([third.calls, third.refused, third.usedBefore], [15, 0, undefined]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (w): OTLP batching never changes what is retried or abandoned", () => {
  async function setup() {
    const state = { status: 200, hits: [] as number[] };
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      state.hits.push((JSON.parse(body) as { resourceSpans: unknown[] }).resourceSpans.length);
      res.writeHead(state.status, { "content-type": "application/json" }).end(state.status === 200 ? "{}" : "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-w-otlp-"));
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    await initCommand(ctx(), { adapter: "fake", name: "Batch", owner: "lead" });
    const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
    cfg.hooks = [{ name: "traces", kind: "otlp", url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }];
    await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
    await hooksCommand(ctx(), { enable: "traces", approver: "lead" });
    /** One run's span records, each with one resourceSpans entry (a big one when asked), and their evidence_recorded event. */
    const record = async (runId: string, specs: ("ok" | "tampered" | "big")[]) => {
      const dir = join(ws.paths.runsDir, runId, "evidence");
      await mkdir(dir, { recursive: true });
      const shas: string[] = [];
      for (const [i, s] of specs.entries()) {
        const text = JSON.stringify({ kind: "otlp_spans", runId, seq: i, resourceSpans: [{ resource: { attributes: [] }, note: s === "big" ? "x".repeat(1_100_000) : `r${i}` }] });
        const sha = createHash("sha256").update(text).digest("hex");
        await writeFile(join(dir, `${sha}.json`), s === "tampered" ? text.replace(`r${i}`, "altered") : text);
        shas.push(sha);
      }
      await ws.lock.withLock((held) => ws.audit.append({ type: "evidence_recorded", runId, records: shas.length, sha256: shas }, held), "test");
    };
    const audit = async () => (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    return { state, ws, record, audit, done: async () => { await new Promise<void>((r) => server.close(() => r())); await rm(root, { recursive: true, force: true }); } };
  }

  test("a failed batch is retried record by record, each with its own attempts", async () => {
    const t = await setup();
    try {
      await t.record("run_batch1", ["ok", "ok", "ok"]);
      t.state.status = 500;
      assert.match((await flushHooks(t.ws))[0]!.message, /could not send a batch of 3 span records .* retried one by one/);
      assert.deepEqual(t.state.hits, [3]);
      t.state.status = 200;
      await flushHooks(t.ws);
      assert.deepEqual(t.state.hits, [3, 1, 1, 1], "after a failed batch the records go alone");
      assert.equal((await t.audit()).filter((e) => e.type === "hook_delivered").length, 3);
    } finally {
      await t.done();
    }
  });

  test("a tampered record is abandoned alone between two batches; an oversize record goes alone", async () => {
    const t = await setup();
    try {
      await t.record("run_batch2", ["ok", "ok", "tampered", "ok", "ok"]);
      await flushHooks(t.ws);
      assert.deepEqual(t.state.hits, [2, 2], "the good records still went out batched");
      const events = await t.audit();
      assert.equal(events.filter((e) => e.type === "hook_delivery_abandoned").length, 1);
      assert.equal(events.filter((e) => e.type === "hook_delivered").length, 4);
      t.state.hits.length = 0;
      await t.record("run_batch3", ["big", "ok", "ok"]);
      await flushHooks(t.ws);
      assert.deepEqual(t.state.hits, [1, 2], "the record over the byte cap went alone, the rest together");
    } finally {
      await t.done();
    }
  });
});
