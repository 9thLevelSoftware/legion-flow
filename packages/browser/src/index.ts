/**
 * Browser checks: a deterministic script of typed actions, run as a verification
 * check on the host, with no model. Every request the page makes is
 * intercepted and anything outside allowedDomains is aborted and logged; this is
 * interception inside the browser, not network isolation (the served process
 * has the host's network). Secrets are typed by host code from the environment
 * and never recorded; no screenshot or page snapshot is taken while a typed
 * secret is on the page. Nothing here ever downloads a browser.
 */
import { readFileSync } from "node:fs";
import { join, isAbsolute, normalize, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { BrowserScriptSchema, browserScriptProblem, type BrowserCheckRecord, type BrowserScript, type GateStatus } from "@9thlevelsoftware/legion-flow-schema";
import { spawnPiped, type PipedProcess } from "@9thlevelsoftware/legion-flow-engine";
import { sha, keepShot, findBrowsers, freePort, SERVE_ENV, killTree, stripQuery, hostOf, SCREENSHOT_MAX_BYTES, type BrowserCandidate } from "./common.js";

export { findBrowsers, SCREENSHOT_MAX_BYTES, type BrowserCandidate } from "./common.js";
export { browserToolServer, browserToolDefs, type BrowserToolServer, type BrowserToolServerOptions, type BrowserToolDef, type BrowserToolResult, type CoreState } from "./session.js";
export { BROWSER_PLAYWRIGHT_VERSION, BROWSER_IMAGE_PLAYWRIGHT_PATH, BROWSER_GUEST_DIR, BROWSER_MAIN, browserImageTag, browserDockerfile, browserDistDir } from "./image.js";


/** A script path as a check names it: relative, forward slashes, inside the tree. */
export function scriptPathProblem(rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes("\\") || rel.split("/").includes("..")) return "a browser script path is relative to the tree root, with forward slashes and no '..'";
  if (!rel.endsWith(".json")) return "a browser script is a .json file";
  return null;
}

export function loadScript(root: string, rel: string): { ok: true; script: BrowserScript; sha256: string } | { ok: false; reason: string } {
  const bad = scriptPathProblem(rel);
  if (bad) return { ok: false, reason: bad };
  const abs = join(root, ...rel.split("/"));
  if (!normalize(abs).startsWith(normalize(root + sep)) && normalize(abs) !== normalize(root)) return { ok: false, reason: "the script is outside the tree" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    return { ok: false, reason: `${rel} does not exist in the tree` };
  }
  let parsed;
  try {
    parsed = BrowserScriptSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return { ok: false, reason: `${rel} is not JSON` };
  }
  if (!parsed.success) return { ok: false, reason: `${rel}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const problem = browserScriptProblem(parsed.data);
  if (problem) return { ok: false, reason: `${rel}: ${problem}` };
  return { ok: true, script: parsed.data, sha256: sha(bytes) };
}

export interface BrowserCheckOptions {
  /** The tree the check runs in: the script is read from it and \`serve\` runs in it. */
  cwd: string;
  timeoutMs?: number;
  /** The script's sha256 when the plan was approved; a different file is unevaluable, never a pass. */
  expectedSha256?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: which browsers to try. */
  candidates?: BrowserCandidate[];
}

export interface BrowserCheckOutcome {
  status: GateStatus;
  reason: string;
  record: BrowserCheckRecord;
  /** Human lines for the check's stdout; never contains a secret or a query string. */
  summary: string[];
}

export async function runBrowserCheck(rel: string, options: BrowserCheckOptions): Promise<BrowserCheckOutcome> {
  const env = options.env ?? process.env;
  const record: BrowserCheckRecord = { script: rel, scriptSha256: "0".repeat(64), steps: [], blocked: [], secretsFilled: 0 };
  const summary: string[] = [];
  const done = (status: GateStatus, reason: string): BrowserCheckOutcome => ({ status, reason, record, summary: [...summary, `${status}: ${reason}`] });

  const loaded = loadScript(options.cwd, rel);
  if (!loaded.ok) return done("unevaluable", loaded.reason);
  record.scriptSha256 = loaded.sha256;
  if (options.expectedSha256 === undefined) return done("unevaluable", `${rel} has no approved hash; browser checks run only from an approved plan (approve plan records each script's sha256)`);
  if (options.expectedSha256 !== loaded.sha256) return done("unevaluable", `${rel} changed since the plan was approved (approved ${options.expectedSha256.slice(0, 12)}, now ${loaded.sha256.slice(0, 12)}); a changed check is never a pass`);
  const script = loaded.script;
  const allowed = new Set(script.allowedDomains);
  for (const s of script.steps) if (s.action === "fill_secret" && env[s.secretRef.slice(4)] === undefined) return done("unevaluable", `${s.secretRef} is not set in the environment`);

  const candidates = options.candidates ?? findBrowsers(env);
  if (candidates.length === 0) return done("unevaluable", "no browser was found (installed Chrome, Edge, or a cached Playwright Chromium); nothing is ever downloaded");

  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
  let served: PipedProcess | null = null;
  let browser: Browser | null = null;
  try {
    let baseUrl: string | undefined;
    if (script.serve) {
      const port = await freePort();
      baseUrl = script.serve.url.replace("{port}", String(port));
      const serveEnv: Record<string, string> = { PORT: String(port) };
      for (const k of SERVE_ENV) if (env[k] !== undefined) serveEnv[k] = env[k]!;
      served = await spawnPiped({ command: script.serve.command[0]!, args: script.serve.command.slice(1), cwd: options.cwd, env: serveEnv });
      served.stdout.resume();
      const readyBy = Date.now() + (script.serve.readyTimeoutMs ?? 30_000);
      let ready = false;
      let exited = false;
      void served.exited.then(() => (exited = true));
      while (!ready && !exited && Date.now() < Math.min(readyBy, deadline)) {
        try {
          const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
          ready = res.status < 500;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!ready) return done("unevaluable", `the served app did not answer at ${stripQuery(baseUrl)}${exited ? ` (it exited: ${served.stderrTail().slice(-300)})` : ""}; a tree without installed dependencies cannot serve`);
      summary.push(`served ${script.serve.command.join(" ")} at ${stripQuery(baseUrl)}`);
    }

    let lastError = "";
    for (const c of candidates) {
      try {
        browser = await chromium.launch({ executablePath: c.executablePath, headless: true });
        record.browser = { kind: c.kind, version: browser.version() };
        break;
      } catch (err: unknown) {
        lastError = (err as Error).message.split("\n")[0]!;
      }
    }
    if (!browser) return done("unevaluable", `no browser could be launched (${lastError})`);
    summary.push(`browser ${record.browser!.kind} ${record.browser!.version}`);

    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (/^(data|blob|about):/.test(url) || allowed.has(hostOf(url))) return route.continue();
      record.blocked.push({ url: stripQuery(url), kind: "request" });
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      if (allowed.has(hostOf(ws.url()))) return ws.connectToServer();
      record.blocked.push({ url: stripQuery(ws.url()), kind: "websocket" });
      await ws.close({ code: 1008, reason: "blocked by allowedDomains" });
    });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(script.stepTimeoutMs ?? 10_000);
    let secretOnPage = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) secretOnPage = false;
    });

    const poll = async (test: () => Promise<boolean>) => {
      const until = Date.now() + (script.stepTimeoutMs ?? 10_000);
      while (Date.now() < until) {
        if (await test().catch(() => false)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };

    for (let i = 0; i < script.steps.length; i++) {
      if (Date.now() > deadline) return done("unevaluable", `the check ran out of time before step ${i}`);
      const s = script.steps[i]!;
      let ok = true;
      let detail = "";
      let extracted: string | undefined;
      let shot: { sha256: string; pngBase64: string } | undefined;
      try {
        switch (s.action) {
          case "goto": {
            const target = baseUrl && !/^[a-z]+:/i.test(s.url) ? new URL(s.url, baseUrl).toString() : s.url;
            if (!allowed.has(hostOf(target))) {
              ok = false;
              detail = `${stripQuery(target)} is not in allowedDomains`;
              break;
            }
            await page.goto(target);
            detail = `opened ${stripQuery(target)}`;
            break;
          }
          case "click":
            await page.locator(s.selector).first().click();
            detail = `clicked ${s.selector}`;
            break;
          case "fill":
            await page.locator(s.selector).first().fill(s.value);
            detail = `filled ${s.selector}`;
            break;
          case "press":
            await page.locator(s.selector).first().press(s.key);
            detail = `pressed ${s.key} in ${s.selector}`;
            break;
          case "fill_secret": {
            const host = hostOf(page.url());
            if (!allowed.has(host)) {
              ok = false;
              detail = `refused: the page's host '${host}' is not in allowedDomains, so no secret is typed there`;
              break;
            }
            await page.locator(s.selector).first().fill(env[s.secretRef.slice(4)]!);
            secretOnPage = true;
            record.secretsFilled++;
            detail = `typed ${s.secretRef} into ${s.selector} (value not recorded)`;
            break;
          }
          case "expect_text": {
            const where = s.selector ? page.locator(s.selector).first() : page.locator("body");
            ok = await poll(async () => (await where.innerText()).includes(s.text));
            detail = ok ? `found the expected text${s.selector ? ` in ${s.selector}` : ""}` : `the expected text was not found${s.selector ? ` in ${s.selector}` : ""}`;
            break;
          }
          case "expect_url":
            ok = await poll(async () => page.url().includes(s.contains));
            detail = ok ? `the URL contains '${s.contains}'` : `the URL ${stripQuery(page.url())} does not contain '${s.contains}'`;
            break;
          case "extract":
            if (secretOnPage) {
              ok = false;
              detail = "refused: a secret was typed on this page, so nothing is extracted from it";
              break;
            }
            extracted = (await page.locator(s.selector).first().innerText()).slice(0, 500);
            detail = `extracted ${s.name} from ${s.selector}`;
            break;
          case "screenshot":
            if (secretOnPage) {
              detail = "skipped: a secret was typed on this page";
              break;
            }
            {
              const png = await page.screenshot({ type: "png" });
              shot = keepShot(png);
              detail = `screenshot${s.name ? ` ${s.name}` : ""}${shot.pngBase64 ? "" : ` (${png.length} bytes, over the ${SCREENSHOT_MAX_BYTES}-byte cap: hashed, not stored)`}`;
            }
            break;
        }
      } catch (err: unknown) {
        ok = false;
        // A driver error about a secret field is never echoed: nothing guarantees it omits what was typed.
        detail = s.action === "fill_secret" ? "the secret field could not be filled (selector not found or not fillable)" : (err as Error).message.split("\n")[0]!.replace(/\?[^\s'"]*/g, "");
      }
      const url = stripQuery(page.url());
      const aria = secretOnPage ? undefined : await page.ariaSnapshot().then((t) => sha(t)).catch(() => undefined);
      if (!ok && !secretOnPage && !shot) {
        const png = await page.screenshot({ type: "png" }).catch(() => null);
        if (png) shot = keepShot(png);
      }
      record.steps.push({ index: i, action: s.action, ok, detail, url, ...(aria ? { ariaSha256: aria } : {}), ...(shot ? { screenshot: shot } : {}), ...(extracted !== undefined ? { extracted } : {}) });
      summary.push(`${ok ? "ok" : "FAIL"} ${i} ${s.action}: ${detail}`);
      if (!ok) return done("unsatisfied", `step ${i} (${s.action}) failed: ${detail}`);
    }
    return done("satisfied", `${script.steps.length} step(s) passed${record.blocked.length ? `; ${record.blocked.length} request(s) to hosts outside allowedDomains were blocked` : ""}`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (served) await killTree(served);
  }
}
