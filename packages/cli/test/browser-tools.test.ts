import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { join } from "node:path";
import { ResultEnvelopeSchema, McpServerConfigSchema, PlanTaskSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { findBrowsers, browserImageTag } from "@9thlevelsoftware/legion-flow-browser";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const SECRET = "hunter2-correct-horse-7781";
const browsers = findBrowsers();
const noBrowser = browsers.length ? undefined : "no Chrome, Edge, or cached Chromium on this machine";

/** A loopback shop: a sign-in form, a third-party tracker the page tries to load, and a welcome page that records what it was sent. */
let shop: Server;
let shopUrl = "";
const posted: string[] = [];
before(async () => {
  shop = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/done") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posted.push(new URLSearchParams(body).get("pw") ?? "");
        res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>Welcome back</h1></body></html>");
      });
      return;
    }
    if (req.url === "/frame") return void res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><label>Outer <input type="password" name="outer"></label><iframe srcdoc='<label>Inner <input type="password" name="inner"></label>'></iframe></body></html>`);
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><h1>Shop</h1><img src="https://tracker.example.com/pixel.png" alt=""><form action="/done" method="post"><label>Password <input type="password" name="pw"></label><button type="submit">Sign in</button></form></body></html>`);
  });
  await new Promise<void>((r) => shop.listen(0, "127.0.0.1", () => r()));
  shopUrl = `http://127.0.0.1:${(shop.address() as { port: number }).port}/`;
});
after(() => new Promise<void>((r) => shop.close(() => r())));

async function project(task: Record<string, unknown>, toolCalls: unknown[] = [], files: Record<string, string> = {}, config: (cfg: Record<string, any>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-browsetools-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  for (const [p, c] of Object.entries(files)) await writeFile(join(root, p), c);
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Browse", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  config(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Browse" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "edited", kind: "behavior" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx(), { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx(), { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "Browse", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] }, ...task }];
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
  await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }], toolCalls }));
  const exec = (o: Record<string, unknown> = {}) => executeCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 120_000, ...o });
  return { root, ws, ctx, exec, approved };
}

async function records(ws: Workspace, runId: string) {
  const loaded = (await ws.runs.load(runId))!;
  const recs = await Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any>));
  return {
    calls: recs.filter((r) => r.kind === "tool_call").sort((a, b) => a.step - b.step),
    steps: recs.filter((r) => r.kind === "browser_step").sort((a, b) => a.step - b.step),
    session: recs.find((r) => r.kind === "browser_session"),
    sessions: recs.filter((r) => r.kind === "browser_session").length,
    failed: recs.filter((r) => r.kind === "tool_server_failed"),
    summary: recs.find((r) => r.kind === "agent_summary")?.text as string,
  };
}

/** Every byte under .legion-flow, to prove a value appears nowhere. */
async function everything(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += await readFile(join(e.parentPath, e.name), "utf8").catch(() => "");
  return out;
}

/** Docker Desktop with both the agent's node image and the locally built browser image; otherwise the test is skipped. */
async function dockerReady(t: { skip: (m: string) => void }): Promise<boolean> {
  const has = (image: string) => promisify(execFile)("docker", ["image", "inspect", image]).then(() => true, () => false);
  if (process.platform === "linux" || !(await has(resolveDockerSettings(undefined).image)) || !(await has(browserImageTag()))) {
    t.skip(`needs Docker Desktop, ${resolveDockerSettings(undefined).image}, and ${browserImageTag()} (docker build -t ${browserImageTag()} .legion-flow/var/images/browser)`);
    return false;
  }
  return true;
}

const full = { allowedDomains: ["127.0.0.1"], allowRisk: ["read", "edit", "network"], secrets: [{ name: "shop_pw", ref: "env:LF_TEST_SHOP_PW" }] };

describe("M4 slices (o1) and (o2): model-driven browsing through the tool gateway, on the host and in the browser container", () => {
  test("the agent observes, types a declared secret by ref, signs in, and reads the result; the secret reaches the site and no record; off-list hosts and stale refs are refused", { skip: noBrowser }, async () => {
    process.env.LF_TEST_SHOP_PW = SECRET;
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { ...full, startUrl: shopUrl } }, [
      { name: "browser__observe" },
      { name: "browser__fill_secret", arguments: { ref: "${ref:Password}", secret: "shop_pw" } },
      { name: "browser__observe" },
      { name: "browser__click", arguments: { ref: "${ref:Sign in}" } },
      { name: "browser__extract" },
      { name: "browser__goto", arguments: { url: "https://tracker.example.com/" } },
      { name: "browser__click", arguments: { ref: "e2" } },
      { name: "browser__screenshot" },
      { name: "browser__press", arguments: { ref: "e2" } },
    ]);
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await records(ws, env.runId!);
      assert.deepEqual(r.failed, []);
      assert.match(r.summary, /- listed: browser__click, browser__extract, browser__fill, browser__fill_secret, browser__goto, browser__observe, browser__press, browser__screenshot\n/);
      assert.match(r.summary, /- browser__observe: ok ok: observed \d+ ref\(s\)/);
      assert.match(r.summary, /- browser__fill_secret: ok ok: typed the secret shop_pw into e\d+ \(value not recorded\)/);
      assert.match(r.summary, /- browser__observe: error error: refused: a secret was typed on this page/);
      assert.match(r.summary, /- browser__click: ok ok: clicked e\d+/);
      assert.match(r.summary, /- browser__extract: ok ok: extracted the page; page http:\/\/127\.0\.0\.1:\d+\/done\n<untrusted-content source="browser">\nWelcome back/);
      assert.match(r.summary, /- browser__goto: error error: refused: https:\/\/tracker\.example\.com\/ is not in this task's allowedDomains/);
      assert.match(r.summary, /- browser__click: error error: observe first/);
      assert.match(r.summary, /- browser__screenshot: ok ok: screenshot/);
      assert.match(r.summary, /- browser__press: error error: refused: press needs key as a non-empty string/);
      assert.deepEqual(posted.slice(-1), [SECRET], "the site received the secret");
      assert.equal(r.calls.length, 9);
      assert.ok(r.calls.every((c) => c.verdict === "relayed"));
      assert.match(r.calls[7]!.result, /"type":"image","sha256":"[0-9a-f]{64}"/, "the screenshot is hashed in the tool_call record, not inlined");
      assert.equal(r.steps.length, 9);
      assert.ok(r.steps[0]!.ariaSha256 && !r.steps[1]!.ariaSha256);
      assert.ok(r.steps[7]!.screenshot?.sha256);
      assert.equal(r.session.secretsFilled, 1);
      assert.equal(r.sessions, 1, "the session is closed once, though the gateway is closed twice");
      assert.ok(r.session.blocked.some((b: { url: string }) => b.url === "https://tracker.example.com/pixel.png"), JSON.stringify(r.session.blocked));
      assert.ok(!(await everything(join(root, ".legion-flow"))).includes(SECRET), "the secret is in no record, log, brief, or prompt");
    } finally {
      delete process.env.LF_TEST_SHOP_PW;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("under vm-docker the browser runs in its own container, reaches a host app only through the forward proxy, and types a secret no record holds", async (t) => {
    if (!(await dockerReady(t))) return;
    process.env.LF_TEST_SHOP_PW = SECRET;
    const hostShop = shopUrl.replace("127.0.0.1", "host.docker.internal");
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { allowedDomains: ["host.docker.internal"], startUrl: hostShop, allowRisk: ["read", "edit", "network"], secrets: [{ name: "shop_pw", ref: "env:LF_TEST_SHOP_PW" }] } }, [
      { name: "browser__observe" },
      { name: "browser__extract" },
      { name: "browser__fill_secret", arguments: { ref: "${ref:Password}", secret: "shop_pw" } },
      { name: "browser__click", arguments: { ref: "${ref:Sign in}" } },
    ]);
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await records(ws, env.runId!);
      assert.deepEqual(r.failed, []);
      assert.match(r.summary, /- browser__observe: ok ok: observed \d+ ref\(s\)/);
      assert.match(r.summary, /- browser__extract: ok [^\n]*\n<untrusted-content source="browser">\nShop/);
      assert.equal(r.session.container, true);
      assert.equal(r.session.browser.kind, "chromium");
      assert.deepEqual(r.session.egress.forwardHosts, ["host.docker.internal"]);
      assert.ok(r.session.egress.summary.hosts.includes("host.docker.internal") && r.session.egress.summary.requests > 0, JSON.stringify(r.session.egress));
      assert.match(r.session.egress.logSha256, /^[0-9a-f]{64}$/);
      assert.ok(r.steps[0]!.ariaSha256, "the step record came back through _meta");
      assert.ok(r.session.blocked.some((b: { url: string }) => b.url === "https://tracker.example.com/pixel.png"));
      assert.equal(r.session.secretsFilled, 1);
      assert.deepEqual(posted.slice(-1), [SECRET], "the host app received the secret through the proxy");
      assert.ok(!(await everything(join(root, ".legion-flow"))).includes(SECRET), "the secret is in no record, log, brief, prompt, or egress log");
    } finally {
      delete process.env.LF_TEST_SHOP_PW;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("under vm-docker serve runs inside the browser container from the run's tree, and the agent's typing reaches the served app", async (t) => {
    if (!(await dockerReady(t))) return;
    const app = [
      'const http = require("node:http");',
      'http.createServer((q, s) => {',
      '  if (q.method === "POST") { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => s.end("<html><body><h1>Searched for " + new URLSearchParams(b).get("q") + "</h1></body></html>")); return; }',
      '  s.end(\'<html><body><form action="/done" method="post"><label>Query <input name="q"></label><button type="submit">Search</button></form></body></html>\');',
      '}).listen(Number(process.env.PORT), "127.0.0.1");',
      '',
    ].join("\n");
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], allowRisk: ["read", "edit", "network"], serve: { command: ["node", "app.cjs"], url: "http://127.0.0.1:{port}/" }, startUrl: "/" } }, [
      { name: "browser__observe" },
      { name: "browser__fill", arguments: { ref: "${ref:Query}", text: "contained apps" } },
      { name: "browser__click", arguments: { ref: "${ref:Search}" } },
      { name: "browser__extract" },
    ], { "app.cjs": app });
    try {
      const env = ResultEnvelopeSchema.parse(await exec({ sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await records(ws, env.runId!);
      assert.deepEqual(r.failed, []);
      assert.match(r.summary, /Searched for contained apps/, r.summary);
      assert.match(r.session.served, /node app\.cjs/);
      assert.deepEqual(r.session.egress.forwardHosts, [], "loopback means the container itself and is never forwarded");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("by default only the read tools are exposed; serve starts the app from the run's own tree on the host tier", { skip: noBrowser }, async () => {
    const app = `require("node:http").createServer((q, s) => s.end("<html><body><p>Served from the run tree</p></body></html>")).listen(Number(process.env.PORT), "127.0.0.1");\n`;
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], serve: { command: [process.execPath, "app.cjs"], url: "http://127.0.0.1:{port}/" }, startUrl: "/" } }, [{ name: "browser__extract" }, { name: "browser__goto", arguments: { url: "/" } }], { "app.cjs": app });
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await records(ws, env.runId!);
      assert.match(r.summary, /- listed: browser__extract, browser__observe, browser__screenshot\n/);
      assert.match(r.summary, /- browser__extract: ok [^\n]*\n<untrusted-content source="browser">\nServed from the run tree/);
      assert.match(r.summary, /- browser__goto: error .*not a tool this task may call/);
      assert.equal(r.calls[1]!.verdict, "refused_policy");
      assert.match(r.session.served, /app\.cjs$/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("approval refuses a browsing task without a session, a session without the tools, an unlisted start host, and an unknown browser tool", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ tools: ["browser"] }, "plan_browser_session_missing"],
      [{ browser: { allowedDomains: ["127.0.0.1"] } }, "plan_browser_tools_missing"],
      [{ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], startUrl: "https://example.com/" } }, "plan_browser_session_unsafe"],
      [{ tools: ["browser.evaluate"], browser: { allowedDomains: ["127.0.0.1"] } }, "plan_tool_unknown"],
      [{ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], serve: { command: ["node", "app.cjs"], url: "http://127.0.0.1:{port}/" }, secrets: [{ name: "pw", ref: "env:LF_TEST_SHOP_PW" }] } }, "plan_browser_session_unsafe"],
    ];
    for (const [task, code] of cases) {
      const { root, approved } = await project(task);
      try {
        assert.equal(approved.status, "refused", code);
        assert.ok(approved.diagnostics.some((d) => d.code === code), `${code}: ${JSON.stringify(approved.diagnostics)}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    assert.equal(PlanTaskSchema.safeParse({ id: "T-01", title: "x", contract: { filesAllowed: ["a"], verificationCommands: [] }, tools: ["browser"], browser: { allowedDomains: ["*.example.com"] } }).success, false, "a wildcard is never a host");
    assert.equal(McpServerConfigSchema.safeParse({ name: "browser", command: "node" }).success, false, "the built-in's name is reserved");
  });

  test("fill_secret checks the frame that owns the field: a srcdoc frame has no host and is refused; the top-level field fills", { skip: noBrowser }, async () => {
    process.env.LF_TEST_SHOP_PW = SECRET;
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { ...full, startUrl: shopUrl + "frame" } }, [
      { name: "browser__observe" },
      { name: "browser__fill_secret", arguments: { ref: "${ref:Inner}", secret: "shop_pw" } },
      { name: "browser__fill_secret", arguments: { ref: "${ref:Outer}", secret: "shop_pw" } },
    ]);
    try {
      const env = ResultEnvelopeSchema.parse(await exec());
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const r = await records(ws, env.runId!);
      assert.match(r.summary, /- browser__fill_secret: error error: refused: the field's frame host '\(none\)' is not in allowedDomains/);
      assert.match(r.summary, /- browser__fill_secret: ok ok: typed the secret shop_pw into e\d+/);
      assert.equal(r.session.secretsFilled, 1);
    } finally {
      delete process.env.LF_TEST_SHOP_PW;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("on the host tier with no browser found, execute refuses before the run instead of running without the tools", { skip: process.platform === "win32" ? undefined : "the browser search is redirected through Windows variables here" }, async () => {
    const empty = await mkdtemp(join(tmpdir(), "legion-flow-nobrowser-"));
    const keys = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "PLAYWRIGHT_BROWSERS_PATH"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const { root, ws, exec } = await project({ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], startUrl: shopUrl } });
    try {
      for (const k of keys) process.env[k] = empty;
      const env = await exec();
      assert.equal(env.status, "refused");
      assert.equal(env.diagnostics[0]?.code, "browser_not_found", JSON.stringify(env.diagnostics));
      assert.deepEqual(await ws.runs.list(), []);
    } finally {
      for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      await rm(root, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("execute applies the serve-with-secrets rule too, so a plan approved before the rule cannot run the pair", async () => {
    // An approval made before slice r: approve a serve-only session, add a secret, and point the receipt at the edited plan.
    const { root, ws, ctx, exec } = await project({ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"], serve: { command: ["node", "app.cjs"], url: "http://127.0.0.1:{port}/" } } });
    try {
      const fingerprintOf = async () => (await planCommand(ctx(), {})).diagnostics.find((d) => d.code === "plan_fingerprint")!.message.replace("Fingerprint ", "");
      const before = await fingerprintOf();
      const planJson = (await planCommand(ctx(), {})).diagnostics.find((d) => d.code === "plan")!.path! + "/plan.json";
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks[0].browser.secrets = [{ name: "pw", ref: "env:LF_TEST_SHOP_PW" }];
      await writeFile(planJson, JSON.stringify(p, null, 2));
      const after = await fingerprintOf();
      for (const f of await readdir(ws.paths.approvalsDir)) {
        const path = join(ws.paths.approvalsDir, f);
        await writeFile(path, (await readFile(path, "utf8")).split(before).join(after));
      }
      process.env.LF_TEST_SHOP_PW = SECRET;
      const env = await exec();
      assert.equal(env.status, "refused");
      assert.equal(env.diagnostics[0]?.code, "browser_session_unsafe", JSON.stringify(env.diagnostics));
      assert.deepEqual(await ws.runs.list(), []);
    } finally {
      delete process.env.LF_TEST_SHOP_PW;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("execute refuses a missing browser image under vm-docker and an unset secret before any run starts", async (t) => {
    if (await dockerReady(t)) {
      const a = await project({ tools: ["browser"], browser: { allowedDomains: ["127.0.0.1"] } }, [], {}, (cfg) => (cfg.sandbox = { docker: { browserImage: "legion-flow-browser:not-built-here" } }));
      try {
        const env = await a.exec({ sandbox: "vm-docker", allowNoSandbox: false });
        assert.equal(env.status, "refused");
        const d = env.diagnostics.find((x) => x.code === "browser_image_missing");
        assert.ok(d, JSON.stringify(env.diagnostics));
        assert.match(d!.hint ?? "", /FIX: build or pull legion-flow-browser:not-built-here/);
        assert.deepEqual(await a.ws.runs.list(), []);
      } finally {
        await rm(a.root, { recursive: true, force: true });
      }
    }
    delete process.env.LF_TEST_SHOP_PW;
    const b = await project({ tools: ["browser"], browser: { ...full, startUrl: "http://127.0.0.1:1/" } });
    try {
      const env = await b.exec();
      assert.equal(env.status, "refused");
      assert.equal(env.diagnostics[0]?.code, "browser_secret_missing");
      assert.match(env.diagnostics[0]!.message, /LF_TEST_SHOP_PW is not set/);
    } finally {
      await rm(b.root, { recursive: true, force: true });
    }
  });
});
