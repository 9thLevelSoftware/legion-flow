import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";

/**
 * Browser checks (M4 slice e): a deterministic script of typed actions run as a
 * verification check, no model involved. The registry declares each action's
 * parameters, whether it mutates the page, its risk class, and whether a
 * failure ends the sequence (every failure does; the flag says which steps are
 * assertions). `evaluate` and `upload_file` are deliberately absent.
 */
export const BROWSER_ACTIONS = {
  goto: { mutating: false, riskClass: "network", assertion: false },
  click: { mutating: true, riskClass: "edit", assertion: false },
  fill: { mutating: true, riskClass: "edit", assertion: false },
  press: { mutating: true, riskClass: "edit", assertion: false },
  fill_secret: { mutating: true, riskClass: "retention", assertion: false },
  expect_text: { mutating: false, riskClass: "read", assertion: true },
  expect_url: { mutating: false, riskClass: "read", assertion: true },
  extract: { mutating: false, riskClass: "read", assertion: false },
  screenshot: { mutating: false, riskClass: "read", assertion: false },
} as const;
export type BrowserActionName = keyof typeof BROWSER_ACTIONS;

const Selector = z.string().min(1).max(500);
/** Exact hostnames only, as in the egress rule: one wildcard would allow every subdomain. Ports are not part of a host. */
/** An exact hostname: no wildcards, no scheme, no port. Shared with the web session (M4 slice z). */
export const HostSchema = z.string().regex(/^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/, "an exact hostname (no wildcards, no scheme, no port)");
const Host = HostSchema;

export const BrowserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().min(1) }).strict(),
  z.object({ action: z.literal("click"), selector: Selector }).strict(),
  z.object({ action: z.literal("fill"), selector: Selector, value: z.string().max(5000) }).strict(),
  z.object({ action: z.literal("press"), selector: Selector, key: z.string().min(1).max(50) }).strict(),
  z.object({ action: z.literal("fill_secret"), selector: Selector, secretRef: z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/, "env:NAME, never a value") }).strict(),
  z.object({ action: z.literal("expect_text"), text: z.string().min(1), selector: Selector.optional() }).strict(),
  z.object({ action: z.literal("expect_url"), contains: z.string().min(1) }).strict(),
  z.object({ action: z.literal("extract"), selector: Selector, name: z.string().regex(/^[a-z][a-z0-9_]*$/) }).strict(),
  z.object({ action: z.literal("screenshot"), name: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional() }).strict(),
]);
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const BrowserScriptSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.BROWSER_SCRIPT),
  description: z.string().optional(),
  /** The only hosts the page may reach; every other request is aborted and logged. Required, never empty. */
  allowedDomains: z.array(Host).min(1),
  /**
   * The app under test, started from the tree being verified (the same-tree rule): an argv run without a shell,
   * given a free port as PORT; \`{port}\` in \`url\` is replaced with it. The url's host must be in allowedDomains.
   */
  serve: z.object({ command: z.array(z.string().min(1)).min(1), url: z.string().min(1), readyTimeoutMs: z.number().int().min(1000).max(300_000).optional() }).strict().optional(),
  stepTimeoutMs: z.number().int().min(500).max(120_000).optional(),
  steps: z.array(BrowserStepSchema).min(1).max(200),
}).strict();
export type BrowserScript = z.infer<typeof BrowserScriptSchema>;

/**
 * Why a script may not run at all, before any browser starts. The exit-evidence rule: a script that fills a
 * secret must name its hosts, and a wildcard is never a host.
 */
export function browserScriptProblem(script: BrowserScript): string | null {
  const secrets = script.steps.some((s) => s.action === "fill_secret");
  if (secrets && (script.allowedDomains.length === 0 || script.allowedDomains.some((d) => d.includes("*")))) return "a script that fills a secret must list exact allowedDomains";
  if (script.serve) {
    let host: string;
    try {
      host = new URL(script.serve.url.replace("{port}", "1")).hostname;
    } catch {
      return `serve.url '${script.serve.url}' is not a URL`;
    }
    if (!script.allowedDomains.includes(host === "::1" ? "[::1]" : host)) return `serve.url host '${host}' is not in allowedDomains`;
  }
  return null;
}

/**
 * Model-driven browsing (M4 slice o1): the agent running a task drives a browser through the tool gateway's
 * built-in `browser` server. Each tool's risk class is the gateway's (fill_secret is `edit` here, where a
 * check's registry says `retention`: the gateway's policy has no retention class, and typing a declared secret
 * into a listed host is an edit of that page). There is no `evaluate` and no `upload_file`.
 */
export const BROWSER_TOOLS = {
  observe: { riskClass: "read", description: "List the page's elements as an accessibility snapshot; each interactive element carries [ref=eN]. Refs are valid until the next navigation or the next observe." },
  extract: { riskClass: "read", description: "The visible text of the page, or of one element by ref." },
  screenshot: { riskClass: "read", description: "A PNG of the viewport." },
  goto: { riskClass: "network", description: "Open a URL whose host is in the task's allowedDomains; a path is resolved against the served app or the start URL." },
  click: { riskClass: "edit", description: "Click an element by its ref from the latest observe." },
  fill: { riskClass: "edit", description: "Type text into an element by its ref." },
  press: { riskClass: "edit", description: "Press a key (for example Enter) in an element by its ref." },
  fill_secret: { riskClass: "edit", description: "Type a secret the plan declares, by its name, into an element by its ref. You never see the value." },
} as const;
export type BrowserToolName = keyof typeof BROWSER_TOOLS;
export const BROWSER_SERVER_NAME = "browser";

/** A plan task's browser session: frozen by plan approval (the plan fingerprint covers it), so a run cannot widen its own allowlist. */
export const BrowserSessionSchema = z.object({
  allowedDomains: z.array(Host).min(1),
  /** Opened before the agent starts: an absolute URL, or a path against the served app. */
  startUrl: z.string().min(1).optional(),
  /** Secrets the agent may type by name; the value is read from the environment by host code and never recorded. */
  secrets: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), ref: z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/, "env:NAME, never a value") }).strict()).max(10).optional(),
  /** The app under test, started from the run's own tree. Runs code the agent wrote on the host, so only the unhardened tier allows it. */
  serve: z.object({ command: z.array(z.string().min(1)).min(1), url: z.string().min(1), readyTimeoutMs: z.number().int().min(1000).max(300_000).optional() }).strict().optional(),
  /** Risk classes the agent may call; ["read"] when unset, as for any gateway server. */
  allowRisk: z.array(z.enum(["read", "edit", "network"])).optional(),
  deny: z.array(z.enum(Object.keys(BROWSER_TOOLS) as [BrowserToolName, ...BrowserToolName[]])).optional(),
  /** The run's tool budget when this task browses; the project's toolPolicy.maxSteps (else 20) when unset. */
  maxSteps: z.number().int().min(1).max(200).optional(),
  stepTimeoutMs: z.number().int().min(500).max(120_000).optional(),
}).strict();
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

/** Why a session may not run, judged at approve plan before any browser starts: the same host rules as a check script. */
export function browserSessionProblem(s: BrowserSession): string | null {
  const hostIn = (u: string, what: string) => {
    let host: string;
    try {
      host = new URL(u.replace("{port}", "1")).hostname;
    } catch {
      return `${what} '${u}' is not a URL`;
    }
    return s.allowedDomains.includes(host === "::1" ? "[::1]" : host) ? null : `${what} host '${host}' is not in allowedDomains`;
  };
  if (s.serve) {
    const bad = hostIn(s.serve.url, "serve.url");
    if (bad) return bad;
  }
  if (s.startUrl && /^[a-z][a-z0-9+.-]*:/i.test(s.startUrl)) {
    const bad = hostIn(s.startUrl, "startUrl");
    if (bad) return bad;
  } else if (s.startUrl && !s.serve) return "a relative startUrl needs serve";
  const names = (s.secrets ?? []).map((x) => x.name);
  if (new Set(names).size !== names.length) return "a secret name is declared twice";
  // M4 slice r: the served app is the agent's own code, running beside the process that holds the secret values.
  // A check script (browserScriptProblem) may still serve and type a secret: a human wrote it, and it runs as checks do.
  if (s.serve && names.length) return "a session that serves the agent's own code may not also type secrets: the served app would run beside the process that holds them";
  return null;
}

/** The browser record attached to a check's evidence. Screenshots are stored inline; URLs are recorded without their query string. */
export const BrowserCheckRecordSchema = z.object({
  script: z.string(),
  scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  browser: z.object({ kind: z.enum(["chrome", "msedge", "chromium"]), version: z.string() }).strict().optional(),
  steps: z.array(z.object({
    index: z.number().int().min(0),
    action: z.string(),
    ok: z.boolean(),
    detail: z.string(),
    url: z.string().optional(),
    ariaSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    screenshot: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), pngBase64: z.string() }).strict().optional(),
    extracted: z.string().optional(),
  }).strict()),
  blocked: z.array(z.object({ url: z.string(), kind: z.enum(["request", "websocket"]) }).strict()),
  secretsFilled: z.number().int().min(0),
}).strict();
export type BrowserCheckRecord = z.infer<typeof BrowserCheckRecordSchema>;
