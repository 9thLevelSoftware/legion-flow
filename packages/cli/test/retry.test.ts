import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, RecallDocSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { redact, failureCode } from "@9thlevelsoftware/legion-flow-engine";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, recallCommand, mapCommand, RETRYABLE_CODES } from "../dist/index.js";

const node = `"${process.execPath}"`;

async function project(tier: string, script: unknown) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-retry-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "check.cjs"), 'const s = require("fs").readFileSync("src/a.ts", "utf8");\nprocess.exit(s.includes("bad") ? 1 : 0);\n');
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "Retry", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = tier;
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx, { new: "Retry" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "a is not bad", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Fix a", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [`${node} check.cjs`] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  assert.equal(approved.status, "ok", JSON.stringify(approved.diagnostics));
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(script));
  const exec = (opts: Record<string, unknown> = {}) => executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000, ...opts });
  return { root, ws, ctx, exec };
}

const BAD = { edits: [{ path: "src/a.ts", content: "export const a = 'bad';\n" }] };
const GOOD = { edits: [{ path: "src/a.ts", content: "export const a = 'good';\n" }], summary: "Fixed the payment rounding bug in src/a.ts." };

async function recallDoc(ctx: unknown, opts: Record<string, unknown>) {
  const env = ResultEnvelopeSchema.parse(await recallCommand(ctx as never, opts));
  return RecallDocSchema.parse(JSON.parse(await readFile(env.diagnostics.find((d) => d.code === "recall_document")!.path!, "utf8")));
}

describe("M4 slice (g): execute --retry and previous attempts", () => {
  test("R0 --retry 2: a failed attempt, then a withheld one (its check failed, nothing applied), then the last applies; each brief lists the earlier attempts; the summary is evidence and recall finds it", async () => {
    const { root, ws, ctx, exec } = await project("R0", { byAttempt: [{ exitCode: 3 }, BAD, GOOD] });
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ retry: 2 }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const retries = env.diagnostics.filter((d) => d.code === "execution_retry").map((d) => d.message);
      assert.equal(retries.length, 2);
      assert.match(retries[0]!, /Attempt 1 of 3 .* failed with adapter_failed/);
      assert.match(retries[1]!, /Attempt 2 of 3 .* withheld, nothing applied/);
      assert.ok(env.diagnostics.some((d) => d.code === "execution_auto_applied"));
      assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 'good';\n");

      const taskRuns = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.task);
      assert.equal(taskRuns.length, 3);
      assert.equal(taskRuns.filter((r) => r.run.kind === "workflow" && r.run.applied).length, 1, "only the last attempt applied");
      const brief = JSON.parse(await readFile(join(ws.paths.cacheRunsDir, env.runId!, "brief.json"), "utf8"));
      assert.deepEqual(brief.previousAttempts.map((a: { outcome: string; code: string }) => `${a.outcome}/${a.code}`), ["withheld/withheld", "failed/adapter_failed"], "newest first, our codes");
      assert.equal(brief.previousAttempts[0].checks[0].status, "unsatisfied");
      const prompt = await readFile(join(ws.paths.cacheRunsDir, env.runId!, "prompt.md"), "utf8");
      assert.match(prompt, /### Previous attempts \(2, newest first; recorded by Legion, not by an agent\)/);
      assert.match(prompt, /<untrusted-content source="previous-attempts">/);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string });
      assert.equal(events.filter((e) => e.type === "proposal_withheld").length, 1);
      assert.equal(events.filter((e) => e.type === "execution_failed").length, 1);

      const last = await ws.runs.load(env.runId!);
      const summaries: { text: string; truncated: boolean }[] = [];
      for (const e of last!.evidenceIndex.filter((x) => x.producedBy === "spawn")) {
        const rec = JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8"));
        if (rec.kind === "agent_summary") summaries.push(rec);
      }
      assert.equal(summaries.length, 1);
      assert.match(summaries[0]!.text, /payment rounding/);
      assert.equal(summaries[0]!.truncated, false);

      const doc = await recallDoc(ctx, { query: "payment rounding" });
      const transcript = doc.blocks.find((b) => b.source === "transcript")!;
      assert.equal(transcript.status, "OK");
      assert.equal(transcript.items[0]?.id, env.runId);
      assert.match(transcript.answer, /written by agents and unverified/);
      assert.equal(doc.blocks.at(-1)?.source, "transcript", "last in authority");
      const before = await recallDoc(ctx, { query: "payment rounding", knownAt: "2020-01-01T00:00:00.000Z" });
      assert.equal(before.blocks.find((b) => b.source === "transcript")!.items.length, 0, "runs started after the time asked about do not count");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("every attempt failing ends blocked after the last; without --retry nothing changes", async () => {
    const { root, exec } = await project("R0", { exitCode: 3 });
    try {
      const env = await exec({ retry: 1 });
      assert.equal(env.status, "blocked");
      assert.equal(env.diagnostics.filter((d) => d.code === "execution_retry").length, 1);
      assert.match(env.diagnostics.find((d) => d.code === "execution_failed")!.message, /adapter_failed/);
      const plain = await exec({});
      assert.equal(plain.status, "blocked");
      assert.equal(plain.diagnostics.filter((d) => d.code === "execution_retry").length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R1: a proposal with a failing check still goes to a human; --retry acts only on failed runs", async () => {
    const { root, exec } = await project("R1", BAD);
    try {
      const env = await exec({ retry: 2 });
      assert.equal(env.status, "awaiting_decision", JSON.stringify(env.diagnostics));
      assert.equal(env.diagnostics.filter((d) => d.code === "execution_retry").length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--retry is validated, does not combine with --resume or --jobs, and never retries a usage limit, a moved checkout, or a crash", async () => {
    const { root, exec } = await project("R0", GOOD);
    try {
      for (const retry of [0, 4, "x"]) assert.equal((await exec({ retry })).diagnostics[0]?.code, "retry_invalid");
      assert.equal((await exec({ retry: 1, resume: true })).diagnostics[0]?.code, "retry_conflict");
      assert.equal((await exec({ retry: 1, jobs: 2 })).diagnostics[0]?.code, "retry_conflict");
      assert.deepEqual([...RETRYABLE_CODES].sort(), ["adapter_failed", "adapter_timeout", "contract_violation"]);
      for (const code of ["usage_limit_exceeded", "source_changed", "effect_unknown_after_crash", "adapter_aborted"]) assert.equal(RETRYABLE_CODES.has(code), false, code);
      assert.equal(failureCode("spawn: adapter_failed: fake exited 3"), "adapter_failed");
      assert.equal(failureCode("aborted"), null);
      assert.deepEqual(redact("key sk-abcdefgh123 and sk-abcdefgh123", ["sk-abcdefgh123", "short"]), { text: "key [redacted] and [redacted]", count: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (g): map --routes", () => {
  test("routes are listed and filtered by URL prefix or module; recall's map block answers a URL the query names", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-routes-cli-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "server.ts"), 'app.get("/users", (req, res) => res.send([]));\nrouter.post("/orders", handler);\n');
      const ws = Workspace.at(root);
      const ctx = { cwd: root, isTTY: false, workspace: ws };
      await initCommand(ctx, { adapter: "fake", name: "Routes", owner: "lead" });
      const built = await mapCommand(ctx, {});
      assert.match(built.diagnostics.find((d) => d.code === "map_built")!.message, /2 HTTP routes/);
      const all = await mapCommand(ctx, { routes: true });
      assert.equal(all.status, "ok", JSON.stringify(all.diagnostics));
      assert.deepEqual(all.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["GET /users src/server.ts:1 [express_call]", "POST /orders src/server.ts:2 [express_call]"]);
      assert.deepEqual((await mapCommand(ctx, { routes: "/us" })).diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["GET /users src/server.ts:1 [express_call]"]);
      assert.equal((await mapCommand(ctx, { routes: "src/" })).diagnostics.filter((d) => d.code === "map_result").length, 2);
      assert.equal((await mapCommand(ctx, { routes: true, deps: "src/server.ts" })).status, "usage_error");
      const doc = await recallDoc(ctx, { query: "who serves /users" });
      assert.match(doc.blocks[0]!.items.map((i) => i.text).join("\n"), /GET \/users is declared in src\/server\.ts:1 \(express_call, found by syntax\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
