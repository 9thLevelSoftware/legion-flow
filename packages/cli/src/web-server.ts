/**
 * The tool gateway's built-in `web` server (M4 slice z, ADR-0017): one tool, `scrape`, backed by the project's
 * self-hosted Firecrawl on loopback. It runs in Legion's process, so under vm-docker the agent reaches it through
 * the gateway and its proxy like any gateway tool; Legion's own process only ever connects to loopback.
 *
 * The boundary is the task's frozen allowlist, checked twice: the request host before the call, and Firecrawl's
 * final URL (`metadata.url`, the engine's URL after redirects) after it. A final URL off the list, or none at all,
 * withholds the content. Only `url`, `formats`, `onlyMainContent`, and `timeout` are sent: never agent-supplied
 * actions, headers, or waits. Firecrawl's own containers make the fetch and Legion does not sandbox their network.
 *
 * Measured against self-hosted Firecrawl v2.11.162: its default Playwright engine reports the requested URL as
 * `metadata.url` even after a cross-host redirect (its source marks redirect following as a TODO), so the after-check
 * catches a redirect only when Firecrawl uses its fetch engine. The request-host check is the boundary that always holds.
 */
import { createHash } from "node:crypto";
import { WEB_TOOLS, type WebSession } from "@9thlevelsoftware/legion-flow-schema";

export const WEB_DEFAULT_TIMEOUT_MS = 60_000;
export const WEB_DEFAULT_MAX_BYTES = 48 * 1024;

export interface WebServer {
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; riskClass: string }[];
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Pages are the most hostile input this system handles: wrapped as untrusted, any tag that could close the block stripped. */
const untrusted = (url: string, text: string) =>
  `<untrusted-content source="web" url="${url.replace(/["<>]/g, "")}">\n${text.replace(/<\/?untrusted-content[^>]*>/gi, "")}\n</untrusted-content>`;

const refusal = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

/** Host as the allowlist spells it: lower case, IPv6 in brackets. */
function hostOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    return h === "::1" ? "[::1]" : h;
  } catch {
    return null;
  }
}

/** Cut at a byte budget without splitting a UTF-8 character. */
function truncateBytes(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function webToolServer(o: {
  session: WebSession;
  firecrawlUrl: string;
  runId: string;
  record: (rec: Record<string, unknown>) => Promise<void>;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}): WebServer {
  const doFetch = o.fetchImpl ?? fetch;
  const allowed = new Set(o.session.allowedDomains);
  const timeoutMs = o.session.timeoutMs ?? WEB_DEFAULT_TIMEOUT_MS;
  const maxBytes = o.session.maxBytes ?? WEB_DEFAULT_MAX_BYTES;
  const endpoint = new URL("v2/scrape", o.firecrawlUrl.endsWith("/") ? o.firecrawlUrl : `${o.firecrawlUrl}/`).toString();

  const scrape = async (args: Record<string, unknown>) => {
    const url = typeof args.url === "string" ? args.url : "";
    const host = hostOf(url);
    const base = { kind: "web_fetch", runId: o.runId, tool: "scrape", url: url.slice(0, 2048) };
    if (!host) {
      await o.record({ ...base, refused: "not_a_url" });
      return refusal(`'${url.slice(0, 200)}' is not an http(s) URL.`);
    }
    if (!allowed.has(host)) {
      await o.record({ ...base, host, refused: "host_not_allowed" });
      return refusal(`The host '${host}' is not in this task's allowedDomains (${[...allowed].join(", ")}); nothing was fetched.`);
    }
    let res: Response;
    try {
      // The loopback call never follows a redirect: Firecrawl answers JSON, and a redirect would send Legion's process elsewhere.
      res = await doFetch(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: args.onlyMainContent !== false, timeout: timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 15_000),
      });
    } catch (err: unknown) {
      const reason = (err as Error).name === "TimeoutError" ? `no answer within ${timeoutMs + 15_000} ms` : (err as Error).message.slice(0, 200);
      await o.record({ ...base, host, refused: "firecrawl_unreachable", reason });
      return refusal(`Firecrawl did not answer (${reason}); nothing was returned.`);
    }
    let body: { success?: boolean; error?: string; code?: string; data?: { markdown?: string; metadata?: { url?: string; sourceURL?: string; statusCode?: number; title?: string } } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      await o.record({ ...base, host, refused: "firecrawl_bad_response", status: res.status });
      return refusal(`Firecrawl answered HTTP ${res.status} without a JSON body.`);
    }
    if (!res.ok || body.success !== true || !body.data) {
      const reason = `${body.code ?? `HTTP ${res.status}`}${body.error ? `: ${String(body.error).slice(0, 200)}` : ""}`;
      await o.record({ ...base, host, refused: "firecrawl_failed", status: res.status, reason });
      return refusal(`Firecrawl could not fetch the page (${reason}).`);
    }
    const meta = body.data.metadata ?? {};
    const finalUrl = typeof meta.url === "string" ? meta.url : null;
    const finalHost = finalUrl ? hostOf(finalUrl) : null;
    if (!finalHost || !allowed.has(finalHost)) {
      await o.record({ ...base, host, finalUrl: finalUrl?.slice(0, 2048) ?? null, refused: finalUrl ? "redirected_off_allowlist" : "final_url_unknown", pageStatus: meta.statusCode ?? null });
      return refusal(finalUrl ? `The page redirected to '${finalHost ?? finalUrl.slice(0, 200)}', which is not in allowedDomains; the content was withheld.` : "Firecrawl did not report the final URL, so whether the page stayed on the allowlist is unknown; the content was withheld.");
    }
    const markdown = typeof body.data.markdown === "string" ? body.data.markdown : "";
    const cut = truncateBytes(markdown, maxBytes);
    await o.record({
      ...base,
      host,
      finalUrl: finalUrl!.slice(0, 2048),
      pageStatus: meta.statusCode ?? null,
      bytes: Buffer.byteLength(markdown, "utf8"),
      sha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
      returnedBytes: Buffer.byteLength(cut.text, "utf8"),
      truncated: cut.truncated,
      redirectCheck: "reported_url_only",
    });
    const header = `${finalUrl}${meta.statusCode ? ` (HTTP ${meta.statusCode})` : ""}${cut.truncated ? `, truncated to ${maxBytes} bytes` : ""} (the final URL as Firecrawl reports it; its default engine does not report redirects)`;
    return { content: [{ type: "text", text: `${header}\n${untrusted(finalUrl!, cut.text)}` }] };
  };

  return {
    tools: [
      {
        name: "scrape",
        description: WEB_TOOLS.scrape.description,
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "An absolute http(s) URL whose host is in allowedDomains." }, onlyMainContent: { type: "boolean", description: "Drop navigation and footers (default true)." } },
          required: ["url"],
          additionalProperties: false,
        },
        riskClass: WEB_TOOLS.scrape.riskClass,
      },
    ],
    async call(tool, args) {
      if (tool !== "scrape") return refusal(`The web server has no tool '${tool}'.`);
      return scrape(args);
    },
    async close() {},
  };
}
