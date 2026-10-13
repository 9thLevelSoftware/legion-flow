import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, decideCommand, hooksCommand, learnCommand } from "../dist/index.js";
import { flushHooks, hookReadStats } from "../dist/hooks.js";

const node = `"${process.execPath}"`;

async function lifecycle(riskTier: "R0" | "R1", members: boolean, patch: (cfg: Record<string, any>, root: string) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-t-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "SliceT", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = riskTier;
  if (members) cfg.coordinator = { members: [{ id: "alt", adapter: "fake", model: "alt-model" }] };
  patch(cfg, root);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "SliceT" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Edit a", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  assert.equal((await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] })).status, "ok");
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ byMember: { default: { edits: [{ path: "src/a.ts", content: "export const a = 'default';\n" }] }, alt: { edits: [{ path: "src/a.ts", content: "export const a = 'alt';\n" }] } } }));
  return { root, ws, ctx };
}

async function sink() {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    hits.push(body);
    res.writeHead(200).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { hits, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("M4 slice (t): choice resume without an adapter, windowed hook reads, retirements", () => {
  test("a decided broadcast choice applies on resume with no adapter preparation (no terminal, no consent needed); an ordinary R1 run still needs them", async () => {
    // A "language server" that only leaves a marker when started: the resume must start none (it prepared no tier).
    const a = await lifecycle("R0", true, (cfg, root) => {
      cfg.map = { languageServers: [{ language: "fake", extensions: [".fl"], command: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'x')", join(tmpdir(), `lf-lsp-marker-${root.slice(-6)}`)] }] };
    });
    const marker = join(tmpdir(), `lf-lsp-marker-${a.root.slice(-6)}`);
    await writeFile(join(a.root, "src", "x.fl"), "fake\n");
    try {
      const started = ResultEnvelopeSchema.parse(await executeCommand(a.ctx(), { taskId: "T-01", broadcast: true, members: "default,alt", sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 }));
      assert.equal(started.status, "awaiting_decision", JSON.stringify(started.diagnostics));
      const interruptId = (started.nextAction as { interruptId: string }).interruptId;
      assert.equal((await decideCommand(a.ctx(), { interruptId, edit: JSON.stringify({ member: "alt" }), approver: "lead" })).status, "ok");
      await stat(marker); // positive control: the consented first execute did start the server
      await rm(marker, { force: true });
      // No terminal and no --allow-no-sandbox: preparing the host tier would refuse; applying a choice needs neither.
      const resumed = ResultEnvelopeSchema.parse(await executeCommand(a.ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false }));
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      assert.equal(await readFile(join(a.root, "src", "a.ts"), "utf8"), "export const a = 'alt';\n");
      await assert.rejects(stat(marker), "no language server was started on the host by a resume that prepared no tier");
    } finally {
      await rm(a.root, { recursive: true, force: true });
    }
    const b = await lifecycle("R1", false);
    try {
      const started = ResultEnvelopeSchema.parse(await executeCommand(b.ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 }));
      assert.equal(started.status, "awaiting_decision");
      await decideCommand(b.ctx(), { interruptId: (started.nextAction as { interruptId: string }).interruptId, approve: true, approver: "lead" });
      const resumed = await executeCommand(b.ctx(false), { resume: true, sandbox: "unhardened", installSignalHandlers: false });
      assert.equal(resumed.status, "refused", "the skip is scoped to choice runs: an ordinary run still needs its tier");
      assert.equal(resumed.diagnostics[0]?.code, "sandbox_not_hardened");
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });

  test("hook flushes read only from the oldest cursor, by bytes (a non-ASCII event included), and fall back to a full read on a bad offset without delivering twice", async () => {
    const s = await sink();
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-t-hooks-"));
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    try {
      await initCommand(ctx(), { adapter: "fake", name: "Windowed", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.hooks = [{ name: "notify", on: ["spec_created", "spec_challenge_round"], url: s.url }];
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      await specCommand(ctx(), { new: "Café crème" });
      await flushHooks(ws);
      assert.equal(s.hits.length, 1);
      const cursorFile = join(ws.paths.varDir, "hooks", "cursor-notify.json");
      const cursor = JSON.parse(await readFile(cursorFile, "utf8")) as { seq: number; offset: number };
      // The offset is the byte just after the line with the cursor's seq, counted in bytes past a non-ASCII event.
      const log = await readFile(ws.paths.eventsJsonl);
      assert.equal(log[cursor.offset - 1], 0x0a, "the offset sits on a line boundary");
      const lineStart = log.subarray(0, cursor.offset - 1).lastIndexOf(0x0a) + 1;
      assert.equal((JSON.parse(log.subarray(lineStart, cursor.offset - 1).toString("utf8")) as { _seq: number })._seq, cursor.seq);
      assert.ok(log.subarray(0, cursor.offset).toString("utf8").includes("Café crème"), "the non-ASCII event lies before the offset");
      assert.notEqual(Buffer.byteLength(log.subarray(0, cursor.offset).toString("utf8")), log.subarray(0, cursor.offset).toString("utf8").length, "so a string index would have been wrong");
      void stat;
      const before = { ...hookReadStats };
      assert.deepEqual(await flushHooks(ws), []);
      assert.equal(hookReadStats.windowed, before.windowed + 1, "the second flush read only from the cursor");
      assert.equal(hookReadStats.full, before.full);
      await specCommand(ctx(), { challenge: true });
      await flushHooks(ws);
      assert.equal(s.hits.length, 2, "the next event went out from the window");
      for (const bad of [(await stat(ws.paths.eventsJsonl)).size + 100, (JSON.parse(await readFile(cursorFile, "utf8")) as { offset: number }).offset - 5]) {
        const c = JSON.parse(await readFile(cursorFile, "utf8")) as Record<string, unknown>;
        c.offset = bad;
        await writeFile(cursorFile, JSON.stringify(c));
        const fulls = hookReadStats.full;
        await flushHooks(ws);
        assert.equal(hookReadStats.full, fulls + 1, `offset ${bad} falls back to a full read`);
        assert.equal(s.hits.length, 2, "and delivers nothing twice");
      }
    } finally {
      await s.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
