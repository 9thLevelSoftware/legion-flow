/**
 * The browser container (M4 slice o2): under vm-docker the gateway's `browser`
 * server runs inside a locally built image, as an MCP server on stdio, on a
 * per-run internal network whose only way out is a forward proxy that reaches
 * the session's allowedDomains and nothing else (ADR-0014). `serve` runs there
 * too, from the run's tree mounted read-only, so code the agent wrote never runs
 * on the host. Secret values reach this container by name, never the agent's.
 * Each tool result's `_meta` carries the step records, which are written as
 * evidence here and stripped before the agent sees the result. Loaded by dynamic
 * import.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { BrowserSession } from "@9thlevelsoftware/legion-flow-schema";
import { BROWSER_GUEST_DIR, BROWSER_MAIN, browserDistDir, browserToolDefs, SCREENSHOT_MAX_BYTES, type BrowserToolResult, type BrowserToolServer, type CoreState } from "@9thlevelsoftware/legion-flow-browser";
import { dockerSession, startEgress, type DockerCli, type DockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { PipedTransport } from "./mcp-client.js";

/** Loopback names mean the browser container itself (the served app); they are never forwarded. */
const CONTAINER_LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ContainerBrowserOptions {
  session: BrowserSession;
  treeDir: string;
  runId: string;
  record: (rec: Record<string, unknown>) => Promise<void>;
  docker: DockerCli;
  /** The browser image's settings: the hardening limits with the browser image. */
  browserSettings: DockerSettings;
  /** The proxy's settings (the plain node image). */
  proxySettings: DockerSettings;
  varDir: string;
  egressDistDir: string;
  clientVersion: string;
  env?: NodeJS.ProcessEnv;
}

export async function containerBrowserServer(o: ContainerBrowserOptions): Promise<BrowserToolServer> {
  const env = o.env ?? process.env;
  const s = o.session;
  const forwardHosts = s.allowedDomains.filter((h) => !CONTAINER_LOCAL.has(h));
  const egressRunId = `${o.runId}-browser`;
  const egressDir = join(o.varDir, "egress", egressRunId);
  const egress = await startEgress({ docker: o.docker, settings: o.proxySettings, runId: egressRunId, runDir: egressDir, egressDistDir: o.egressDistDir, routes: [], secrets: {}, forwardHosts });
  const tools = browserToolDefs();
  const sessionEnv: Record<string, string> = {
    LF_BROWSER_CONFIG: JSON.stringify({ session: s, tools, runId: o.runId, treeDir: "/work" }),
    LF_BROWSER_PROXY: egress.url,
  };
  for (const sec of s.secrets ?? []) {
    const name = sec.ref.slice(4);
    if (env[name]) sessionEnv[name] = env[name]!;
  }
  let session: Awaited<ReturnType<ReturnType<typeof dockerSession>>> | null = null;
  let client: Client | null = null;
  let state: CoreState = { steps: 0, secretsFilled: 0, blocked: [] };
  let closed = false;
  const stepTimeout = s.stepTimeoutMs ?? 10_000;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client?.close().catch(() => undefined);
    await session?.kill().catch(() => undefined);
    const stopped = await egress.stop().catch(() => ({ logPath: null, summary: null }));
    const logSha256 = stopped.logPath ? createHash("sha256").update(await readFile(stopped.logPath).catch(() => Buffer.alloc(0))).digest("hex") : null;
    await o.record({ kind: "browser_session", runId: o.runId, container: true, ...(state.browser ? { browser: state.browser } : {}), served: s.serve ? s.serve.command.join(" ") : null, steps: state.steps, secretsFilled: state.secretsFilled, blocked: state.blocked, egress: { proxy: egress.proxyName, forwardHosts, summary: stopped.summary, logSha256 } }).catch(() => undefined);
  };
  try {
    const open = dockerSession(o.docker, o.browserSettings, `lf-browser-${o.runId}`, { network: egress.networkName });
    session = await open({ command: "node", args: [`${BROWSER_GUEST_DIR}/${BROWSER_MAIN}`], root: o.treeDir, env: sessionEnv, extraMounts: [{ host: browserDistDir(), guest: BROWSER_GUEST_DIR, readonly: true }] });
    client = new Client({ name: "legion-flow-browser-host", version: o.clientVersion });
    // Connect waits for the browser (and the served app) to start inside the container.
    await client.connect(new PipedTransport(session), { timeout: (s.serve?.readyTimeoutMs ?? 30_000) + 60_000 });
  } catch (err) {
    await close();
    throw new Error(`the browser container could not start: ${(err as Error).message.split("\n")[0]!.slice(0, 300)}`);
  }

  return {
    name: "browser",
    tools,
    state: () => state,
    close,
    async call(tool, args) {
      if (closed || !client) return { content: [{ type: "text", text: "error: the browser session has ended" }], isError: true };
      // A page load plus the step's own wait; a slow page is a refused step inside, not a relay failure out here.
      const raw = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: stepTimeout * 3 + 30_000 })) as BrowserToolResult & { _meta?: Record<string, unknown> };
      const meta = raw._meta ?? {};
      if (meta["legion-flow/state"]) state = meta["legion-flow/state"] as CoreState;
      const image = raw.content.find((c) => c.type === "image") as { data: string } | undefined;
      for (const rec of (meta["legion-flow/records"] as Record<string, unknown>[] | undefined) ?? []) {
        const shot = rec.screenshot as { sha256: string } | undefined;
        const png = shot && image ? Buffer.from(image.data, "base64") : null;
        await o.record(shot ? { ...rec, screenshot: { sha256: shot.sha256, pngBase64: png && png.length <= SCREENSHOT_MAX_BYTES ? image!.data : "" } } : rec);
      }
      return { content: raw.content, ...(raw.isError ? { isError: true } : {}) };
    },
  };
}
