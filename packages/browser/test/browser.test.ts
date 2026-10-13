import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SCHEMA_VERSIONS, BrowserScriptSchema, browserScriptProblem } from "@9thlevelsoftware/legion-flow-schema";
import { runBrowserCheck, findBrowsers, loadScript, scriptPathProblem } from "../dist/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SECRET = "hunter2-correct-horse-battery";

const SERVER = `const http = require("http");
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "text/html");
  if (u.pathname === "/done") return res.end("<h1>Welcome back</h1><p id=who>" + (u.searchParams.get("user") || "") + "</p>");
  res.end('<html><body><h1>Sign in</h1><img src="https://example.com/tracker.png"><form action="/done" method="get"><input name="user" aria-label="User"><input name="pw" type="password" aria-label="Password"><button>Go</button></form></body></html>');
}).listen(port, "127.0.0.1");
`;

const script = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ schema: SCHEMA_VERSIONS.BROWSER_SCRIPT, allowedDomains: ["127.0.0.1"], serve: { command: ["node", "server.js"], url: "http://127.0.0.1:{port}/" }, steps, ...extra });

async function tree(scriptBody: unknown) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-browser-"));
  await mkdir(join(root, "checks"), { recursive: true });
  await writeFile(join(root, "server.js"), SERVER);
  const text = JSON.stringify(scriptBody, null, 2);
  await writeFile(join(root, "checks", "login.json"), text);
  return { root, hash: sha(text) };
}

describe("browser scripts: validation without a browser", () => {
  test("a secret needs exact allowedDomains; the served host must be listed; paths stay inside the tree", () => {
    assert.throws(() => BrowserScriptSchema.parse({ ...script([{ action: "fill_secret", selector: "#pw", secretRef: "env:PW" }]), allowedDomains: [] }), /too_small|at least/i, "an empty allowlist does not even parse");
    assert.throws(() => BrowserScriptSchema.parse({ ...script([]), allowedDomains: ["*.example.com"] }), /exact hostname/);
    assert.equal(browserScriptProblem(BrowserScriptSchema.parse({ ...script([{ action: "goto", url: "/" }]), allowedDomains: ["example.com"] })), "serve.url host '127.0.0.1' is not in allowedDomains");
    assert.equal(scriptPathProblem("../x.json") !== null, true);
    assert.equal(scriptPathProblem("checks/a.json"), null);
    assert.ok(BrowserScriptSchema.safeParse(script([{ action: "evaluate", code: "1" }])).success === false, "evaluate is not in the registry");
  });

  test("an unapproved or changed script is unevaluable before any browser starts", async () => {
    const { root, hash } = await tree(script([{ action: "goto", url: "/" }]));
    try {
      assert.match((await runBrowserCheck("checks/login.json", { cwd: root })).reason, /no approved hash/);
      const changed = await runBrowserCheck("checks/login.json", { cwd: root, expectedSha256: "0".repeat(64) });
      assert.equal(changed.status, "unevaluable");
      assert.match(changed.reason, /changed since the plan was approved/);
      assert.equal(loadScript(root, "checks/login.json").ok && (loadScript(root, "checks/login.json") as { sha256: string }).sha256, hash);
      assert.equal((await runBrowserCheck("checks/login.json", { cwd: root, expectedSha256: hash, candidates: [] })).status, "unevaluable", "no browser is unevaluable, never a pass");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("browser scripts against a real browser, where one is installed", async () => {
  const browsers = findBrowsers();
  test("the served form: steps pass, the off-allowlist image is blocked, the secret is typed but never recorded anywhere, and no screenshot follows it", { skip: browsers.length ? undefined : "no Chrome, Edge, or cached Chromium on this machine" }, async () => {
    const body = script([
      { action: "goto", url: "/" },
      { action: "expect_text", text: "Sign in" },
      { action: "screenshot", name: "before" },
      { action: "fill", selector: "role=textbox[name=\"User\"]", value: "ada" },
      { action: "fill_secret", selector: "input[name=pw]", secretRef: "env:LF_TEST_PW" },
      { action: "screenshot", name: "with-secret" },
      { action: "click", selector: "text=Go" },
      { action: "expect_url", contains: "/done" },
      { action: "expect_text", text: "Welcome back" },
      { action: "extract", selector: "#who", name: "user" },
    ]);
    const { root, hash } = await tree(body);
    try {
      const r = await runBrowserCheck("checks/login.json", { cwd: root, expectedSha256: hash, env: { ...process.env, LF_TEST_PW: SECRET } });
      assert.equal(r.status, "satisfied", r.reason + "\n" + r.summary.join("\n"));
      assert.ok(r.record.blocked.some((b) => b.url === "https://example.com/tracker.png"), JSON.stringify(r.record.blocked));
      assert.equal(r.record.secretsFilled, 1);
      const withSecret = r.record.steps.find((s) => s.index === 5)!;
      assert.equal(withSecret.screenshot, undefined);
      assert.match(withSecret.detail, /skipped: a secret was typed/);
      assert.ok(r.record.steps[2]!.screenshot, "the screenshot before the secret was taken");
      assert.equal(r.record.steps.find((s) => s.action === "extract")!.extracted, "ada");
      const everything = JSON.stringify(r);
      assert.ok(!everything.includes(SECRET), "the secret value appears nowhere in the record, the summary, or the reason");
      assert.ok(!everything.includes("pw="), "URLs are recorded without their query string");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("a failing assertion is unsatisfied with a final screenshot; a secret on a host outside the list is refused at the step", { skip: browsers.length ? undefined : "no browser" }, async () => {
    const failing = await tree(script([{ action: "goto", url: "/" }, { action: "expect_text", text: "Nope, not here" }], { stepTimeoutMs: 800 }));
    try {
      const r = await runBrowserCheck("checks/login.json", { cwd: failing.root, expectedSha256: failing.hash });
      assert.equal(r.status, "unsatisfied");
      assert.ok(r.record.steps[1]!.screenshot, "the failing state is captured");
    } finally {
      await rm(failing.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    const badSelector = await tree(script([{ action: "goto", url: "/" }, { action: "fill_secret", selector: "#does-not-exist", secretRef: "env:LF_TEST_PW" }], { stepTimeoutMs: 800 }));
    try {
      const r = await runBrowserCheck("checks/login.json", { cwd: badSelector.root, expectedSha256: badSelector.hash, env: { ...process.env, LF_TEST_PW: SECRET } });
      assert.equal(r.status, "unsatisfied");
      assert.match(r.reason, /the secret field could not be filled/);
      assert.ok(!JSON.stringify(r).includes(SECRET), "a failed secret fill echoes nothing that was typed");
    } finally {
      await rm(badSelector.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    const offList = await tree({ schema: SCHEMA_VERSIONS.BROWSER_SCRIPT, allowedDomains: ["example.org"], steps: [{ action: "fill_secret", selector: "#x", secretRef: "env:LF_TEST_PW" }] });
    try {
      const r = await runBrowserCheck("checks/login.json", { cwd: offList.root, expectedSha256: offList.hash, env: { ...process.env, LF_TEST_PW: SECRET } });
      assert.equal(r.status, "unsatisfied");
      assert.match(r.reason, /no secret is typed there/);
      assert.equal(r.record.secretsFilled, 0);
    } finally {
      await rm(offList.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("M4 slice (o2): the browser image and the container entry", () => {
  test("the image pins the same playwright-core this package depends on, and its Dockerfile installs exactly that version", async () => {
    const { BROWSER_PLAYWRIGHT_VERSION, browserImageTag, browserDockerfile } = await import("../dist/index.js");
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies["playwright-core"], BROWSER_PLAYWRIGHT_VERSION);
    assert.equal(browserImageTag(), `legion-flow-browser:playwright-${BROWSER_PLAYWRIGHT_VERSION}`);
    assert.match(browserDockerfile(), new RegExp(`npm install -g playwright-core@${BROWSER_PLAYWRIGHT_VERSION.replace(/\./g, "\\.")} `));
    assert.match(browserDockerfile(), /--only-shell chromium/);
    assert.match(browserDockerfile(), /\nUSER node\n$/);
  });

  test("the files the container loads import only Node built-ins and each other", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["browser-mcp-main.js", "session-core.js", "common.js"]) {
      const text = await readFile(new URL(`../dist/${f}`, import.meta.url), "utf8");
      const specifiers = [...text.matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((m) => m[1]!);
      for (const s of specifiers) assert.ok(s.startsWith("node:") || s.startsWith("./"), `${f} imports ${s}, which the container does not have`);
    }
  });
});
