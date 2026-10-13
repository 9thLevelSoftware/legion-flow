import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { HookConfigSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, hooksCommand } from "../dist/index.js";
import { flushHooks } from "../dist/hooks.js";

const node = `"${process.execPath}"`;

async function collector() {
  const hits: { url: string; headers: Record<string, string | string[] | undefined>; body: { resourceSpans?: unknown[] } }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { hits, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/otel`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function project(base: string) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-otlphook-"));
  await mkdir(join(root, "src"), { recursive: true });
  for (const f of ["a", "b"]) await writeFile(join(root, "src", `${f}.ts`), `export const ${f} = 1;\n`);
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Otlp", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.hooks = [{ name: "traces", kind: "otlp", url: base, secrets: [{ header: "authorization", ref: "env:LF_TEST_OTLP_KEY", prefix: "Basic " }] }];
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Otlp" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = ["a", "b"].map((f, i) => ({ id: `T-0${i + 1}`, title: f, acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: [`src/${f}.ts`], verificationCommands: [] } }));
  await writeFile(planJson, JSON.stringify(p, null, 2));
  await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({}));
  const exec = (taskId: string) => executeCommand(ctx(), { taskId, sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
  return { root, ws, ctx, exec };
}

const recordedRuns = async (ws: Workspace) => (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; runId?: string; sha256?: string[] }).filter((e) => e.type === "evidence_recorded");

describe("M4 slice (n1): the otlp hook", () => {
  test("a run before consent is never sent; a run after it goes out in one batched request, as written, with the auth header; a second flush sends nothing", async () => {
    const sink = await collector();
    const { root, ws, ctx, exec } = await project(sink.base);
    process.env.LF_TEST_OTLP_KEY = "cHVibGljOnNlY3JldA==";
    try {
      assert.equal((await exec("T-01")).status, "ok");
      assert.deepEqual(await flushHooks(ws), [], "no consent, nothing sent");
      assert.equal((await hooksCommand(ctx(), { enable: "traces", approver: "lead" })).status, "ok");
      assert.match((await hooksCommand(ctx(), {})).diagnostics[0]!.message, /traces -> 127\.0\.0\.1:\d+ on run span records \(otlp\): enabled/);
      await flushHooks(ws);
      assert.equal(sink.hits.length, 0, "T-01's run predates the consent");
      assert.equal((await exec("T-02")).status, "ok");
      const out = await flushHooks(ws);
      const after = (await recordedRuns(ws)).at(-1)!;
      assert.ok(after.sha256!.length > 0);
      // Since slice (w) a run's records go out batched: one POST carrying every record's resourceSpans, in order, as written.
      assert.ok(after.sha256!.length > 1);
      assert.equal(sink.hits.length, 1, "one POST for the run's records");
      assert.ok(sink.hits.every((h) => h.url === "/otel/v1/traces" && h.headers.authorization === "Basic cHVibGljOnNlY3JldA==" && Array.isArray(h.body.resourceSpans)));
      const records = await Promise.all(after.sha256!.map(async (sha) => (JSON.parse(await readFile(join(ws.paths.runsDir, after.runId!, "evidence", `${sha}.json`), "utf8")) as { resourceSpans: unknown[] }).resourceSpans));
      assert.deepEqual(sink.hits[0]!.body.resourceSpans, records.flat(), "exactly the records as written, concatenated in order");
      const delivered = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; batch?: number }).filter((ev) => ev.type === "hook_delivered");
      assert.equal(delivered.length, after.sha256!.length, "one hook_delivered per record, so each record's hash stays in the audit");
      assert.match(out.find((d) => d.code === "hook_delivered")!.message, /sent \d+ span record\(s\)/);
      assert.deepEqual(await flushHooks(ws), []);
    } finally {
      delete process.env.LF_TEST_OTLP_KEY;
      await sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a redirect and a partial success are failures, retried; a tampered record is abandoned at once", async () => {
    const sink = await collector();
    const { root, ws, ctx, exec } = await project(sink.base);
    process.env.LF_TEST_OTLP_KEY = "k";
    try {
      await hooksCommand(ctx(), { enable: "traces", approver: "lead" });
      assert.equal((await exec("T-01")).status, "ok");
      const redirect = (async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v1/traces" } })) as typeof fetch;
      assert.match((await flushHooks(ws, redirect))[0]!.message, /redirects are refused/);
      const partial = (async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 2, errorMessage: "bad" } }), { status: 200 })) as typeof fetch;
      assert.match((await flushHooks(ws, partial))[0]!.message, /rejected 2 span\(s\)/);
      const run = (await recordedRuns(ws)).at(-1)!;
      await writeFile(join(ws.paths.runsDir, run.runId!, "evidence", `${run.sha256![0]}.json`), "{}");
      const out = await flushHooks(ws);
      assert.match(out.find((d) => d.code === "hook_delivery_abandoned")!.message, /no longer matches its hash/);
      assert.equal(sink.hits.length, run.sha256!.length - 1, "the rest of the run still goes out");
    } finally {
      delete process.env.LF_TEST_OTLP_KEY;
      await sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("schema: an otlp hook carries no on; an event hook must", () => {
    assert.equal(HookConfigSchema.safeParse({ name: "t", kind: "otlp", url: "https://cloud.langfuse.com/api/public/otel" }).success, true);
    assert.equal(HookConfigSchema.safeParse({ name: "t", kind: "otlp", on: ["shipped"], url: "https://x.example" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "t", url: "https://x.example" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "t", on: ["shipped"], url: "https://x.example" }).success, true);
    assert.equal(HookConfigSchema.safeParse({ name: "t", kind: "otlp", url: "https://x.example/otel/v1/traces" }).success, false, "the url is the base; /v1/traces is appended");
  });
});
