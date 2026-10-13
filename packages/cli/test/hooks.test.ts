import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, shipCommand, hooksCommand, statusCommand, runCommand, runDoctor, type SystemProbe } from "../dist/index.js";
import { flushHooks, HOOK_MAX_ATTEMPTS } from "../dist/hooks.js";

const node = `"${process.execPath}"`;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Counts every outbound connection this process opens, by host, until restored. */
function networkGuard() {
  const seen: string[] = [];
  const hostOf = (args: unknown[]) => {
    const a = args[0] as { host?: string; hostname?: string } | number | string | undefined;
    if (typeof a === "object" && a) return String(a.host ?? a.hostname ?? "localhost");
    return typeof args[1] === "string" ? args[1] : "localhost";
  };
  const originals = { connect: net.connect, createConnection: net.createConnection, tls: tls.connect, fetch: globalThis.fetch };
  (net as { connect: unknown }).connect = (...args: unknown[]) => (seen.push(hostOf(args)), (originals.connect as (...a: unknown[]) => unknown)(...args));
  (net as { createConnection: unknown }).createConnection = (...args: unknown[]) => (seen.push(hostOf(args)), (originals.createConnection as (...a: unknown[]) => unknown)(...args));
  (tls as { connect: unknown }).connect = (...args: unknown[]) => (seen.push(hostOf(args)), (originals.tls as (...a: unknown[]) => unknown)(...args));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname);
    return originals.fetch(input, init);
  }) as typeof fetch;
  return {
    seen,
    external: () => seen.filter((h) => !LOOPBACK.has(h)),
    restore: () => {
      (net as { connect: unknown }).connect = originals.connect;
      (net as { createConnection: unknown }).createConnection = originals.createConnection;
      (tls as { connect: unknown }).connect = originals.tls;
      globalThis.fetch = originals.fetch;
    },
  };
}

async function collector(status = 200, location?: string) {
  const hits: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
    res.writeHead(status, location ? { location } : {}).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { hits, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function project(hookUrl: string, on: string[]) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-hooks-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Hooks", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  cfg.hooks = [{ name: "notify", on, url: hookUrl, secrets: [{ header: "x-hook-key", ref: "env:LF_TEST_HOOK_KEY" }] }];
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  return { root, ws, ctx };
}

async function lifecycle(ws: Workspace, ctx: (tty?: boolean) => { cwd: string; isTTY: boolean; workspace: Workspace }, between: () => Promise<void>) {
  const created = await specCommand(ctx(), { new: "Hooks" });
  await between();
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  await between();
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "edit", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  await between();
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }] }));
  const executed = await executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
  assert.equal(executed.status, "ok", JSON.stringify(executed.diagnostics));
  await between();
  const shipped = await shipCommand(ctx(), { commit: true, approver: "lead" });
  assert.equal(shipped.status, "ok", JSON.stringify(shipped.diagnostics));
  await between();
}

describe("M4 slice (l): Optional CALL hooks", () => {
  test("the exit item: with a hook declared and no consent, a whole lifecycle and every flush make zero outbound connections and the hook endpoint is never called", async () => {
    const sink = await collector();
    const { root, ws, ctx } = await project(sink.url, ["spec_approved", "shipped"]);
    const guard = networkGuard();
    try {
      await lifecycle(ws, ctx, async () => assert.deepEqual(await flushHooks(ws), []));
      assert.deepEqual(guard.external(), [], "nothing left this machine");
      assert.equal(guard.seen.length, 0, "not even a loopback connection: a disabled hook does no work at all");
      assert.equal(sink.hits.length, 0);
      const listed = await hooksCommand(ctx(), {});
      assert.match(listed.diagnostics[0]!.message, /notify -> 127\.0\.0\.1:\d+ on spec_approved, shipped: disabled \(no consent\)/);
      const probe: SystemProbe = { nodeVersion: () => "24.0.0", which: async () => [], run: async () => null, sqlite: async () => ({ ok: true, sqliteVersion: "3" }), browser: async () => null };
      assert.match((await runDoctor(ws, probe)).diagnostics.find((d) => d.code === "hooks")!.message, /none enabled, so no external call is made/);
      // The control: the same guard does see a connection when one is made, by fetch or by a raw socket.
      await fetch(sink.url, { method: "POST", body: "{}" });
      const port = Number(new URL(sink.url).port);
      await new Promise<void>((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => s.end(resolve));
      });
      assert.ok(guard.seen.length >= 2, `the guard counts connections (saw ${guard.seen.length})`);
    } finally {
      guard.restore();
      await sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with consent: only the chosen events recorded after consent are delivered, the payload is the audit event alone, and the secret header is set by name", async () => {
    const sink = await collector();
    const { root, ws, ctx } = await project(sink.url, ["spec_approved", "shipped"]);
    process.env.LF_TEST_HOOK_KEY = "hook-secret-value";
    try {
      let consented = false;
      await lifecycle(ws, ctx, async () => {
        if (!consented && (await readFile(ws.paths.eventsJsonl, "utf8")).includes("spec_approved")) {
          assert.equal((await hooksCommand(ctx(false), { enable: "notify", approver: "lead" })).diagnostics[0]?.code, "hook_consent_requires_tty");
          assert.equal((await hooksCommand(ctx(), { enable: "notify", approver: "stranger" })).diagnostics[0]?.code, "approver_not_decision_owner");
          assert.equal((await hooksCommand(ctx(), { enable: "ghost", approver: "lead" })).diagnostics[0]?.code, "hook_unknown");
          assert.equal((await hooksCommand(ctx(), { enable: "notify", approver: "lead" })).status, "ok");
          consented = true;
        }
        await flushHooks(ws);
      });
      assert.deepEqual(sink.hits.map((h) => h.body.event.type), ["shipped"], "spec_approved happened before consent and is never sent");
      const hit = sink.hits[0]!;
      assert.equal(hit.headers["x-hook-key"], "hook-secret-value");
      assert.deepEqual(Object.keys(hit.body).sort(), ["event", "hook", "project"]);
      assert.equal(hit.body.hook, "notify");
      const events = await readFile(ws.paths.eventsJsonl, "utf8");
      assert.ok(events.includes("hook_enabled") && events.includes("hook_delivered"));
      assert.ok(!events.includes("hook-secret-value"), "the secret is never recorded");
      assert.deepEqual(await flushHooks(ws), [], "a second flush finds nothing new");
      assert.equal(sink.hits.length, 1);

      // Any change to the hook ends the consent: the next event is not sent.
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.hooks[0].on = ["shipped", "proposal_applied"];
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      assert.match((await hooksCommand(ctx(), {})).diagnostics[0]!.message, /disabled \(the hook changed after consent; consent again\)/);
      const guard = networkGuard();
      try {
        assert.deepEqual(await flushHooks(ws), []);
        assert.equal(guard.seen.length, 0);
      } finally {
        guard.restore();
      }
    } finally {
      delete process.env.LF_TEST_HOOK_KEY;
      await sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a redirect is refused: the second host receives nothing and the failure is recorded; --disable stops delivery; the runner appends the flush's diagnostics and never changes the status", async () => {
    const second = await collector();
    const first = await collector(307, second.url);
    const { root, ws, ctx } = await project(first.url, ["spec_created", "spec_approved"]);
    process.env.LF_TEST_HOOK_KEY = "redirect-secret";
    try {
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      await specCommand(ctx(), { new: "Redirect" });
      const out = await flushHooks(ws);
      assert.match(out[0]!.message, /redirect refused/);
      assert.equal(first.hits.length, 1);
      assert.equal(second.hits.length, 0, "the redirect target never sees the event or the secret");
      assert.match(await readFile(ws.paths.eventsJsonl, "utf8"), /hook_delivery_failed.*redirect refused/);

      // The runner path: afterCommand runs the flush and appends its diagnostics; the status is untouched.
      const io = { out: "", stdout(t: string) { this.out += t; }, stderr() {}, setExitCode() {} };
      const env = await runCommand(statusCommand, ctx(), {}, { json: true, io, afterCommand: async (c) => flushHooks(c.workspace) });
      assert.ok(env.diagnostics.some((d) => d.code === "hook_delivery_failed"), "the runner appended the flush's diagnostics");
      assert.equal(env.status, (await statusCommand(ctx(), {})).status);

      await hooksCommand(ctx(), { disable: "notify", approver: "lead" });
      const guard = networkGuard();
      try {
        assert.deepEqual(await flushHooks(ws), []);
        assert.equal(guard.seen.length, 0, "a disabled hook makes no call");
      } finally {
        guard.restore();
      }
      const quiet = await runCommand(statusCommand, ctx(), {}, { json: true, io, afterCommand: async (c) => flushHooks(c.workspace) });
      assert.ok(!quiet.diagnostics.some((d) => d.code.startsWith("hook_")), "with no enabled hook the runner appends nothing");
    } finally {
      delete process.env.LF_TEST_HOOK_KEY;
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the real binary flushes after a command: an enabled hook delivers its pending event and the envelope says so", async () => {
    const sink = await collector();
    const { root, ctx } = await project(sink.url, ["spec_created"]);
    try {
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      await specCommand(ctx(), { new: "Bin" });
      const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
      const run = await promisify(execFile)(process.execPath, [bin, "status", "--json"], { cwd: root, env: { ...process.env, LF_TEST_HOOK_KEY: "bin-key" } }).catch((e: { stdout: string }) => e);
      const env = JSON.parse(run.stdout) as { diagnostics: { code: string }[] };
      assert.ok(env.diagnostics.some((d) => d.code === "hook_delivered"), JSON.stringify(env.diagnostics));
      assert.deepEqual(sink.hits.map((h) => h.body.event.type), ["spec_created"]);
      assert.equal(sink.hits[0]!.headers["x-hook-key"], "bin-key");
    } finally {
      await sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a hook URL may not carry a credential", async () => {
    const { HookConfigSchema } = await import("@9thlevelsoftware/legion-flow-schema");
    assert.equal(HookConfigSchema.safeParse({ name: "x", on: ["shipped"], url: "https://user:token@hooks.example/x" }).success, false);
    assert.equal(HookConfigSchema.safeParse({ name: "x", on: ["shipped"], url: "http://hooks.example/x" }).success, false, "plain http only on loopback");
    assert.equal(HookConfigSchema.safeParse({ name: "x", on: ["shipped"], url: "https://hooks.example/x" }).success, true);
  });

  test("a failing delivery is retried after later commands, in order, and abandoned after the last attempt; it never changes a command's result", async () => {
    const { root, ws, ctx } = await project("https://hooks.example.invalid/legion", ["spec_created", "spec_approved"]);
    process.env.LF_TEST_HOOK_KEY = "k";
    try {
      assert.equal((await hooksCommand(ctx(), { enable: "notify", approver: "lead" })).status, "ok");
      await specCommand(ctx(), { new: "Retry" });
      let calls = 0;
      const failing = (async () => {
        calls++;
        return new Response(null, { status: 503 });
      }) as typeof fetch;
      for (let i = 1; i < HOOK_MAX_ATTEMPTS; i++) {
        const out = await flushHooks(ws, failing);
        assert.match(out[0]!.message, new RegExp(`attempt ${i} of ${HOOK_MAX_ATTEMPTS}`));
      }
      assert.equal(calls, HOOK_MAX_ATTEMPTS - 1, "one attempt per flush: later events wait behind the failing one");
      const last = await flushHooks(ws, failing);
      assert.equal(last[0]?.code, "hook_delivery_abandoned");
      assert.ok((await readFile(ws.paths.eventsJsonl, "utf8")).includes("hook_delivery_abandoned"));
    } finally {
      delete process.env.LF_TEST_HOOK_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});
