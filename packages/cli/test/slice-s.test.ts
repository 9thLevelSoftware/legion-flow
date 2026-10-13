import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ResultEnvelopeSchema, AUDIT_EVENT_TYPES } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, shipCommand, hooksCommand } from "../dist/index.js";
import { flushHooks } from "../dist/hooks.js";

const node = `"${process.execPath}"`;

/** A sink whose answer can change between flushes. */
async function sink(initial: number) {
  const state = { status: initial, hits: [] as { path: string; body: string }[] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    state.hits.push({ path: req.url ?? "", body });
    res.writeHead(state.status).end(state.status === 200 && req.url === "/v1/traces" ? "{}" : "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function project(hook: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-s-"));
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "SliceS", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.hooks = [hook];
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  return { root, ws, ctx };
}
const auditOf = async (ws: Workspace) => (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

describe("M4 slice (s): hook event types, credential pauses, and the challenge record in bundles", () => {
  test("every recorded event type is in the registry the compiler enforces, and --enable refuses a typo or a hook's own delivery event", async () => {
    assert.ok(AUDIT_EVENT_TYPES.includes("shipped") && AUDIT_EVENT_TYPES.includes("audit_rebaselined"));
    for (const [on, bad] of [[["shiped"], "shiped"], [["hook_delivered"], "hook_delivered"]] as const) {
      const { root, ctx } = await project({ name: "notify", on, url: "http://127.0.0.1:9/hook" });
      try {
        const env = await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
        assert.equal(env.status, "refused");
        assert.equal(env.diagnostics[0]?.code, "hook_event_unknown");
        assert.match(env.diagnostics[0]!.message, new RegExp(bad));
        const listed = await hooksCommand(ctx(), {});
        assert.ok(listed.diagnostics.some((d) => d.code === "hook_event_unknown"), "the listing says so too");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("an event hook answered 401 is paused: no attempt counted, nothing abandoned, the listing says failing; once accepted, everything goes in order", async () => {
    const s = await sink(401);
    process.env.LF_TEST_SLICE_S_KEY = "wrong-key";
    const { root, ws, ctx } = await project({ name: "notify", on: ["spec_created"], url: `${s.url}/hook`, secrets: [{ header: "x-key", ref: "env:LF_TEST_SLICE_S_KEY" }] });
    try {
      assert.equal((await hooksCommand(ctx(), { enable: "notify", approver: "lead" })).status, "ok");
      await specCommand(ctx(), { new: "One" });
      for (let i = 0; i < 7; i++) {
        const out = await flushHooks(ws);
        assert.match(out[0]!.message, /Hook notify is paused: HTTP 401\. Nothing is lost/);
        assert.match(out[0]!.hint ?? "", /FIX: check LF_TEST_SLICE_S_KEY/);
      }
      const events = await auditOf(ws);
      assert.equal(events.filter((e) => e.type === "hook_delivery_abandoned").length, 0, "seven 401s abandon nothing");
      const failed = events.filter((e) => e.type === "hook_delivery_failed");
      assert.equal(failed.length, 1, "seven paused flushes record the pause once, not once per command");
      assert.ok(failed[0]!.credential === true && failed[0]!.attempts === undefined);
      const listed = await hooksCommand(ctx(), {});
      assert.match(listed.diagnostics.find((d) => d.code === "hook_failing")!.message, /notify is failing: HTTP 401; its events wait, none is lost/);
      s.state.status = 200;
      const ok = await flushHooks(ws);
      assert.match(ok.find((d) => d.code === "hook_delivered")!.message, /delivered 1 event/);
      assert.equal(JSON.parse(s.state.hits.at(-1)!.body).event.type, "spec_created");
      assert.ok(!(await hooksCommand(ctx(), {})).diagnostics.some((d) => d.code === "hook_failing"), "the failure clears on success");
    } finally {
      delete process.env.LF_TEST_SLICE_S_KEY;
      await s.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unset secret pauses the hook the same way, and nothing is sent", async () => {
    const s = await sink(200);
    delete process.env.LF_TEST_SLICE_S_UNSET;
    const { root, ws, ctx } = await project({ name: "notify", on: ["spec_created"], url: `${s.url}/hook`, secrets: [{ header: "x-key", ref: "env:LF_TEST_SLICE_S_UNSET" }] });
    try {
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      await specCommand(ctx(), { new: "One" });
      for (let i = 0; i < 6; i++) assert.match((await flushHooks(ws))[0]!.message, /paused: LF_TEST_SLICE_S_UNSET is not set/);
      assert.equal(s.state.hits.length, 0);
      assert.equal((await auditOf(ws)).filter((e) => e.type === "hook_delivery_abandoned").length, 0);
    } finally {
      await s.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an otlp hook answered 403 is paused at the same span record; accepted later, it sends that record", async () => {
    const s = await sink(403);
    process.env.LF_TEST_SLICE_S_KEY = "wrong-key";
    const { root, ws, ctx } = await project({ name: "traces", kind: "otlp", url: s.url, secrets: [{ header: "authorization", ref: "env:LF_TEST_SLICE_S_KEY", prefix: "Bearer " }] });
    try {
      assert.equal((await hooksCommand(ctx(), { enable: "traces", approver: "lead" })).status, "ok");
      // One run's span record, as the evidence exporter writes it, and its evidence_recorded event.
      const record = JSON.stringify({ kind: "otlp_spans", runId: "run_slices1", seq: 0, resourceSpans: [] });
      const sha = createHash("sha256").update(record).digest("hex");
      await mkdir(join(ws.paths.runsDir, "run_slices1", "evidence"), { recursive: true });
      await writeFile(join(ws.paths.runsDir, "run_slices1", "evidence", `${sha}.json`), record);
      await ws.lock.withLock((held) => ws.audit.append({ type: "evidence_recorded", runId: "run_slices1", records: 1, sha256: [sha] }, held), "test");
      for (let i = 0; i < 6; i++) assert.match((await flushHooks(ws))[0]!.message, /Hook traces is paused: collector answered HTTP 403/);
      assert.equal((await auditOf(ws)).filter((e) => e.type === "hook_delivery_abandoned").length, 0);
      s.state.status = 200;
      assert.match((await flushHooks(ws)).find((d) => d.code === "hook_delivered")!.message, /sent 1 span record/);
    } finally {
      delete process.env.LF_TEST_SLICE_S_KEY;
      await s.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a challenge record about the bundled spec travels in the bundle and verifies; one about another version stays behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-s-bundle-"));
    const out = await mkdtemp(join(tmpdir(), "legion-flow-slice-s-out-"));
    const ws = Workspace.at(root);
    const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
    try {
      await initCommand(ctx(), { adapter: "fake", name: "Bundle", owner: "lead" });
      const created = await specCommand(ctx(), { new: "Bundle" });
      const specDir = created.diagnostics.find((d) => d.code === "spec_created")!.path!;
      const spec = JSON.parse(await readFile(join(specDir, "spec.json"), "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: "it works", kind: "behavior" }];
      await writeFile(join(specDir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
      assert.equal((await specCommand(ctx(), { challenge: true })).status, "ok");
      await approveCommand(ctx(true), { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx(), { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: "do it", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2) + "\n");
      assert.equal((await approveCommand(ctx(true), { subject: "plan", approver: "lead", check: [`${node} -e 0`] })).status, "ok");

      await shipCommand(ctx(), { bundle: join(out, "with") });
      const manifest = JSON.parse(await readFile(join(out, "with", "manifest.json"), "utf8")) as { members: { path: string }[] };
      assert.ok(manifest.members.some((m) => /^specs\/[^/]+\/challenge\.json$/.test(m.path)), JSON.stringify(manifest.members.map((m) => m.path)));
      const empty = await mkdtemp(join(tmpdir(), "legion-flow-slice-s-verify-"));
      const verified = ResultEnvelopeSchema.parse(await shipCommand({ cwd: empty, isTTY: false, workspace: Workspace.at(empty) }, { verify: join(out, "with") }));
      await rm(empty, { recursive: true, force: true });
      assert.equal(verified.status, "ok", JSON.stringify(verified.diagnostics));
      // A tampered record fails on its hash: it is listed and hashed like every member (the fingerprint check is defense in depth).
      const bundled = manifest.members.find((m) => m.path.endsWith("challenge.json"))!.path;
      await writeFile(join(out, "with", ...bundled.split("/")), "{}");
      const empty2 = await mkdtemp(join(tmpdir(), "legion-flow-slice-s-verify-"));
      const tampered = ResultEnvelopeSchema.parse(await shipCommand({ cwd: empty2, isTTY: false, workspace: Workspace.at(empty2) }, { verify: join(out, "with") }));
      await rm(empty2, { recursive: true, force: true });
      assert.equal(tampered.status, "blocked", JSON.stringify(tampered.diagnostics));
      assert.match(JSON.stringify(tampered.diagnostics), /challenge\.json (does not match its hash|is \d+ bytes)/);

      const record = JSON.parse(await readFile(join(specDir, "challenge.json"), "utf8"));
      record.rounds.at(-1).specFingerprint = "sha256:" + "0".repeat(64);
      await writeFile(join(specDir, "challenge.json"), JSON.stringify(record, null, 2));
      await shipCommand(ctx(), { bundle: join(out, "without") });
      const manifest2 = JSON.parse(await readFile(join(out, "without", "manifest.json"), "utf8")) as { members: { path: string }[] };
      assert.ok(!manifest2.members.some((m) => m.path.endsWith("challenge.json")), "a record about another version of the spec stays behind");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});
