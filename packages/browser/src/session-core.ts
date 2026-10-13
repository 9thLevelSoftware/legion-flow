/**
 * The browser session core (M4 slices o1 and o2): the tool gateway's `browser` server.
 * The agent running a task is the model; it observes the page as an accessibility
 * snapshot with refs and acts on elements by ref. Every request outside the
 * session's allowedDomains is intercepted and aborted. A declared secret is typed
 * by host code; from then until the next navigation no snapshot, text, or
 * screenshot leaves the page. Page text reaches the agent only inside an
 * untrusted-content block.
 *
 * Dependency-free at runtime: the browser container mounts this package's dist
 * alone, with playwright-core only as a global install in the image, so the
 * launcher and the tool table are passed in and the served app is spawned with
 * node:child_process. The host wrapper is session.ts; the container entry is
 * browser-mcp-main.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { sha, keepShot, freePort, SERVE_ENV, stripQuery, hostOf } from "./common.js";

/** Text returned to the agent is capped; a snapshot of a large page is cut, and says so. */
const TEXT_MAX = 32 * 1024;

/** The session block as the core needs it (structurally the schema's BrowserSession). */
export interface CoreSession {
  allowedDomains: string[];
  startUrl?: string;
  secrets?: { name: string; ref: string }[];
  serve?: { command: string[]; url: string; readyTimeoutMs?: number };
  stepTimeoutMs?: number;
}

export interface BrowserToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskClass: string;
}

export interface CoreOptions {
  session: CoreSession;
  tools: BrowserToolDef[];
  /** The run's own tree: `serve` runs in it. */
  treeDir: string;
  env: NodeJS.ProcessEnv;
  /** Starts the browser: by executable path on the host, the image's Chromium behind the forward proxy in the container. */
  launch: () => Promise<{ browser: Browser; info: { kind: string; version: string } }>;
  /** Writes one evidence record (a `browser_step` per call, a `browser_session` at close). */
  record: (rec: Record<string, unknown>) => Promise<void>;
  runId: string;
}

export interface CoreState {
  steps: number;
  secretsFilled: number;
  blocked: { url: string; kind: "request" | "websocket" }[];
  browser?: { kind: string; version: string };
}

export type BrowserToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

export interface BrowserToolServer {
  name: "browser";
  tools: BrowserToolDef[];
  call(tool: string, args: Record<string, unknown>): Promise<BrowserToolResult>;
  close(): Promise<void>;
  state(): CoreState;
}

/** Stop the served process and what it started: its process group on Linux and macOS, its tree on Windows. */
async function stopServed(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    p.kill("SIGKILL");
  }
}

const ref = { type: "string", pattern: "^[a-z0-9]+$", description: "An element ref from the latest observe, for example e5." };
export const BROWSER_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  observe: { type: "object", properties: {}, additionalProperties: false },
  extract: { type: "object", properties: { ref }, additionalProperties: false },
  screenshot: { type: "object", properties: {}, additionalProperties: false },
  goto: { type: "object", properties: { url: { type: "string", minLength: 1 } }, required: ["url"], additionalProperties: false },
  click: { type: "object", properties: { ref }, required: ["ref"], additionalProperties: false },
  fill: { type: "object", properties: { ref, text: { type: "string", maxLength: 5000 } }, required: ["ref", "text"], additionalProperties: false },
  press: { type: "object", properties: { ref, key: { type: "string", minLength: 1, maxLength: 50 } }, required: ["ref", "key"], additionalProperties: false },
  fill_secret: { type: "object", properties: { ref, secret: { type: "string", description: "The secret's name as the plan declares it." } }, required: ["ref", "secret"], additionalProperties: false },
};

/** Page content is data, never instructions: wrapped the way memory is in the brief, with any closing tag removed. */
const untrusted = (text: string) => `<untrusted-content source="browser">\n${text.split("</untrusted-content>").join("")}\n</untrusted-content>`;
const cap = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n…[cut at ${TEXT_MAX} characters]` : text);

/** Start the browser (and the served app, when the session has one), open the start URL, and return the server. Throws with a reason when it cannot. */
export async function startBrowserSession(o: CoreOptions): Promise<BrowserToolServer> {
  const env = o.env;
  const s = o.session;
  const allowed = new Set(s.allowedDomains);
  const secretValues = new Map((s.secrets ?? []).map((x) => [x.name, env[x.ref.slice(4)]]));
  for (const [name, value] of secretValues) if (value === undefined || value === "") throw new Error(`the secret ${name} (${(s.secrets ?? []).find((x) => x.name === name)!.ref}) is not set in the environment`);
  const blocked: { url: string; kind: "request" | "websocket" }[] = [];
  let served: ChildProcess | null = null;
  let browser: Browser | null = null;
  let baseUrl: string | undefined;
  let browserInfo: { kind: string; version: string } | undefined;
  const shutdown = async () => {
    if (browser) await browser.close().catch(() => undefined);
    if (served) await stopServed(served).catch(() => undefined);
    browser = null;
    served = null;
  };
  let page: Page;
  try {
    if (s.serve) {
      const port = await freePort();
      baseUrl = s.serve.url.replace("{port}", String(port));
      const serveEnv: Record<string, string> = { PORT: String(port) };
      for (const k of SERVE_ENV) if (env[k] !== undefined) serveEnv[k] = env[k]!;
      // The served app never writes to this process's stdout (in the container that is the protocol) and inherits no secret.
      const child = spawn(s.serve.command[0]!, s.serve.command.slice(1), { cwd: o.treeDir, env: serveEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      served = child;
      child.stdout?.resume();
      child.stderr?.resume();
      let exited = false;
      child.on("exit", () => (exited = true));
      child.on("error", () => (exited = true));
      const readyBy = Date.now() + (s.serve.readyTimeoutMs ?? 30_000);
      let ready = false;
      while (!ready && !exited && Date.now() < readyBy) {
        try {
          ready = (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })).status < 500;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!ready) throw new Error(`the served app did not answer at ${stripQuery(baseUrl)}${exited ? " (it exited)" : ""}`);
    }
    const launched = await o.launch();
    browser = launched.browser;
    browserInfo = launched.info;
    const context: BrowserContext = await (browser as Browser).newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (/^(data|blob|about):/.test(url) || allowed.has(hostOf(url))) return route.continue();
      blocked.push({ url: stripQuery(url), kind: "request" });
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      if (allowed.has(hostOf(ws.url()))) return ws.connectToServer();
      blocked.push({ url: stripQuery(ws.url()), kind: "websocket" });
      await ws.close({ code: 1008, reason: "blocked by allowedDomains" });
    });
    page = await context.newPage();
    page.setDefaultTimeout(s.stepTimeoutMs ?? 10_000);
  } catch (err) {
    await shutdown();
    throw err;
  }

  // Refs are valid only for the latest observe on the current document; a secret on the page closes it to reading.
  let observedRefs: Set<string> | null = null;
  let secretOnPage = false;
  let secretsFilled = 0;
  let step = 0;
  let closed = false;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      secretOnPage = false;
      observedRefs = null;
    }
  });
  const resolveUrl = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : new URL(u, baseUrl ?? (s.startUrl && /^[a-z]+:/i.test(s.startUrl) ? s.startUrl : page.url())).toString());
  const navigate = async (target: string): Promise<string | null> => {
    if (!allowed.has(hostOf(target))) return `${stripQuery(target)} is not in this task's allowedDomains`;
    await page.goto(target);
    return null;
  };
  if (s.startUrl) {
    const bad = await navigate(resolveUrl(s.startUrl)).catch((e: Error) => e.message.split("\n")[0]!);
    if (bad) {
      await shutdown();
      throw new Error(`the start URL could not be opened: ${bad}`);
    }
  }

  const secretTexts = () => [...secretValues.values()].filter((v): v is string => Boolean(v));
  const scrub = (t: string) => secretTexts().reduce((acc, v) => acc.split(v).join("[secret]"), t);
  const locate = (r: unknown): { ok: true; loc: ReturnType<Page["getByRef"]>; ref: string } | { ok: false; why: string } => {
    if (typeof r !== "string" || !/^[a-z0-9]+$/.test(r)) return { ok: false, why: "a ref looks like e5" };
    if (!observedRefs) return { ok: false, why: "observe first: refs are valid only for the latest observe on the current page" };
    if (!observedRefs.has(r)) return { ok: false, why: `${r} is not a ref in the latest observe` };
    return { ok: true, loc: page.getByRef(r), ref: r };
  };

  const argProblem = (tool: string, args: Record<string, unknown>): string | null => {
    const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).length > 0 ? null : `${tool} needs ${k} as a non-empty string`);
    switch (tool) {
      case "goto":
        return str("url");
      case "click":
        return str("ref");
      case "fill":
        return str("ref") ?? (typeof args.text === "string" ? null : "fill needs text as a string");
      case "press":
        return str("ref") ?? str("key");
      case "fill_secret":
        return str("ref") ?? str("secret");
      case "extract":
        return args.ref === undefined ? null : str("ref");
      default:
        return null;
    }
  };

  const call: BrowserToolServer["call"] = async (tool, args) => {
    const i = step++;
    if (closed) return { content: [{ type: "text", text: "error: the browser session has ended" }], isError: true };
    let ok = true;
    let detail = "";
    let text: string | undefined;
    let image: string | undefined;
    let shot: { sha256: string; pngBase64: string } | undefined;
    let aria: string | undefined;
    const bad = argProblem(tool, args);
    try {
      if (bad) {
        ok = false;
        detail = `refused: ${bad}`;
      } else switch (tool) {
        case "observe": {
          if (secretOnPage) {
            ok = false;
            detail = "refused: a secret was typed on this page; observe again after the next navigation (refs from the observe before the secret still work)";
            break;
          }
          const snap = await page.ariaSnapshot({ mode: "ai" });
          aria = sha(snap);
          observedRefs = new Set([...snap.matchAll(/\[ref=([a-z0-9]+)\]/g)].map((m) => m[1]!));
          text = untrusted(cap(scrub(snap)));
          detail = `observed ${observedRefs.size} ref(s)`;
          break;
        }
        case "extract": {
          if (secretOnPage) {
            ok = false;
            detail = "refused: a secret was typed on this page, so nothing is read from it until the next navigation";
            break;
          }
          if (args.ref !== undefined) {
            const l = locate(args.ref);
            if (!l.ok) {
              ok = false;
              detail = l.why;
              break;
            }
            text = untrusted(cap(scrub(await l.loc.innerText())));
          } else text = untrusted(cap(scrub(await page.locator("body").innerText())));
          detail = `extracted ${args.ref ? `from ${String(args.ref)}` : "the page"}`;
          break;
        }
        case "screenshot": {
          if (secretOnPage) {
            ok = false;
            detail = "refused: a secret was typed on this page; no screenshot until the next navigation";
            break;
          }
          const png = await page.screenshot({ type: "png" });
          shot = keepShot(png);
          image = png.toString("base64");
          detail = `screenshot (${png.length} bytes)`;
          break;
        }
        case "goto": {
          if (typeof args.url !== "string") {
            ok = false;
            detail = "goto needs a url";
            break;
          }
          const target = resolveUrl(args.url);
          const bad = await navigate(target);
          if (bad) {
            ok = false;
            detail = `refused: ${bad}`;
          } else detail = `opened ${stripQuery(target)}`;
          break;
        }
        case "click":
        case "fill":
        case "press":
        case "fill_secret": {
          const l = locate(args.ref);
          if (!l.ok) {
            ok = false;
            detail = l.why;
            break;
          }
          if (tool === "click") {
            await l.loc.click();
            detail = `clicked ${l.ref}`;
          } else if (tool === "fill") {
            await l.loc.fill(args.text as string);
            detail = `filled ${l.ref}`;
          } else if (tool === "press") {
            await l.loc.press(args.key as string);
            detail = `pressed ${String(args.key)} in ${l.ref}`;
          } else {
            const name = typeof args.secret === "string" ? args.secret : "";
            const value = secretValues.get(name);
            // The element's own frame decides (M4 slice r): an iframe's field is typed only under that frame's host. A
            // srcdoc or data: frame has no host, so it is refused, a same-origin srcdoc form included.
            const owner = await (await l.loc.elementHandle().catch(() => null))?.ownerFrame();
            const host = owner ? hostOf(owner.url()) : "";
            if (value === undefined) {
              ok = false;
              detail = `refused: the plan declares no secret '${name}'`;
            } else if (!allowed.has(host)) {
              ok = false;
              detail = `refused: the field's frame host '${host || "(none)"}' is not in allowedDomains, so no secret is typed there`;
            } else {
              try {
                await l.loc.fill(value!);
              } catch {
                // A driver error about a secret field is never echoed: nothing guarantees it omits what was typed.
                throw new Error("the secret field could not be filled (ref not found or not fillable)");
              }
              secretOnPage = true;
              secretsFilled++;
              detail = `typed the secret ${name} into ${l.ref} (value not recorded)`;
            }
          }
          break;
        }
        default:
          ok = false;
          detail = `no browser tool ${tool}`;
      }
    } catch (err: unknown) {
      ok = false;
      detail = scrub((err as Error).message.split("\n")[0]!.replace(/\?[^\s'"]*/g, ""));
    }
    const url = stripQuery(page.url());
    // The snapshot hash is the observe's own: taking another snapshot here would replace the refs the agent holds.
    await o.record({ kind: "browser_step", runId: o.runId, step: i, tool, ok, detail, url, ...(aria ? { ariaSha256: aria } : {}), ...(shot ? { screenshot: shot } : {}) });
    const status = `${ok ? "ok" : "error"}: ${detail}; page ${url}`;
    if (image) return { content: [{ type: "text", text: status }, { type: "image", data: image, mimeType: "image/png" }] };
    return { content: [{ type: "text", text: text ? `${status}\n${text}` : status }], ...(ok ? {} : { isError: true }) };
  };

  return {
    name: "browser",
    tools: o.tools,
    call,
    state: () => ({ steps: step, secretsFilled, blocked: [...blocked], ...(browserInfo ? { browser: browserInfo } : {}) }),
    close: async () => {
      if (closed) return;
      closed = true;
      await o.record({ kind: "browser_session", runId: o.runId, ...(browserInfo ? { browser: browserInfo } : {}), served: s.serve ? s.serve.command.join(" ") : null, steps: step, secretsFilled, blocked }).catch(() => undefined);
      await shutdown();
    },
  };
}
