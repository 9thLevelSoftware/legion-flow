/**
 * The host-side browser server (M4 slice o1): the session core launched with an
 * installed browser found by path. Used on the unhardened tier; under vm-docker
 * the same core runs inside the browser container (slice o2). Nothing here
 * downloads a browser.
 */
import { chromium } from "playwright-core";
import { BROWSER_TOOLS, type BrowserSession, type BrowserToolName } from "@9thlevelsoftware/legion-flow-schema";
import { findBrowsers, type BrowserCandidate } from "./common.js";
import { startBrowserSession, BROWSER_TOOL_SCHEMAS, type BrowserToolDef, type BrowserToolServer } from "./session-core.js";

export type { BrowserToolServer, BrowserToolDef, BrowserToolResult, CoreState } from "./session-core.js";

/** The tool table, built from the schema's registry; sent to the container in its config so schema stays the one source. */
export function browserToolDefs(): BrowserToolDef[] {
  return (Object.keys(BROWSER_TOOLS) as BrowserToolName[]).map((name) => ({ name, description: BROWSER_TOOLS[name].description, inputSchema: BROWSER_TOOL_SCHEMAS[name]!, riskClass: BROWSER_TOOLS[name].riskClass }));
}

export interface BrowserToolServerOptions {
  session: BrowserSession;
  /** The run's own tree: `serve` runs in it. */
  treeDir: string;
  env?: NodeJS.ProcessEnv;
  /** Writes one evidence record (a `browser_step` per call, a `browser_session` at close). */
  record: (rec: Record<string, unknown>) => Promise<void>;
  runId: string;
  candidates?: BrowserCandidate[];
}

/** Start the browser on the host (and the served app, when the session has one), open the start URL, and return the server. */
export async function browserToolServer(o: BrowserToolServerOptions): Promise<BrowserToolServer> {
  const env = o.env ?? process.env;
  const candidates = o.candidates ?? findBrowsers(env);
  if (candidates.length === 0) throw new Error("no browser was found (installed Chrome, Edge, or a cached Playwright Chromium); nothing is ever downloaded");
  return startBrowserSession({
    session: o.session,
    tools: browserToolDefs(),
    treeDir: o.treeDir,
    env,
    record: o.record,
    runId: o.runId,
    launch: async () => {
      let lastError = "";
      for (const c of candidates) {
        try {
          const browser = await chromium.launch({ executablePath: c.executablePath, headless: true });
          return { browser, info: { kind: c.kind, version: browser.version() } };
        } catch (err: unknown) {
          lastError = (err as Error).message.split("\n")[0]!;
        }
      }
      throw new Error(`no browser could be launched (${lastError})`);
    },
  });
}
