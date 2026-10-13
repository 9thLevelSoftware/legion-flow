import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";
import { evaluatePolicy, upstreamOrigin } from "./policy.js";

/** One line per request. No headers, no bodies, no query string. */
export interface EgressLogLine {
  at: string;
  method: string;
  alias: string | null;
  host: string | null;
  path: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  denied: boolean;
  reason?: string;
  durationMs: number;
}

export interface ProxyOptions {
  routes: readonly EgressRoute[];
  /** Resolved secret values by variable name. Read once; never logged. */
  secrets: Readonly<Record<string, string>>;
  log: (line: EgressLogLine) => void;
  upstreamTimeoutMs?: number;
  /**
   * Forward mode (M4 slice o2, ADR-0014): exact hostnames a client may reach as a forward proxy, by
   * `CONNECT host:port` (tunneled without TLS interception) or an absolute-URI request. Anything else is 403.
   * Unset, the proxy is reverse-only and refuses CONNECT with 405, as before.
   */
  forwardHosts?: readonly string[];
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade", "host"]);

function pathOnly(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

/**
 * The reverse proxy. The same code runs in the proxy container and in-process
 * in tests. Every configured secret header is set from `secrets`, overwriting
 * whatever the agent sent, so a placeholder in the agent's environment is all
 * the agent ever holds.
 */
export function createProxyServer(options: ProxyOptions): Server {
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;

  const forward = options.forwardHosts ? new Set(options.forwardHosts) : null;

  /** An absolute-URI request: forwarded to a listed host only. The query string is never logged. */
  const handleForward = (req: IncomingMessage, res: ServerResponse, target: URL, started: number) => {
    const method = req.method ?? "GET";
    let requestBytes = 0;
    let responseBytes = 0;
    const host = target.hostname;
    const log = (status: number, denied: boolean, reason?: string) => options.log({ at: new Date(started).toISOString(), method, alias: null, host, path: target.pathname, status, requestBytes, responseBytes, denied, ...(reason ? { reason } : {}), durationMs: Date.now() - started });
    if (target.protocol !== "http:" || !forward!.has(host)) {
      req.resume();
      res.writeHead(403, { "content-type": "text/plain" }).end("forward denied: host not allowed\n");
      log(403, true, target.protocol !== "http:" ? "forward_scheme" : "forward_host_not_allowed");
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    headers.host = target.host;
    const up = httpRequest(target, { method, headers, timeout: timeoutMs }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.on("data", (c: Buffer) => (responseBytes += c.length));
      upRes.pipe(res);
      upRes.on("end", () => log(upRes.statusCode ?? 502, false));
    });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", (err) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain" }).end(`${err.message}\n`);
      log(502, false, err.message);
    });
    req.on("data", (c: Buffer) => (requestBytes += c.length));
    req.pipe(up);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    if (forward && /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      let target: URL | null = null;
      try {
        target = new URL(url);
      } catch {
        target = null;
      }
      if (target) return handleForward(req, res, target, started);
    }
    let requestBytes = 0;
    let responseBytes = 0;
    const decision = evaluatePolicy(options.routes, method, url);

    const finishLog = (status: number, alias: string | null, host: string | null, denied: boolean, reason?: string) => {
      options.log({ at: new Date(started).toISOString(), method, alias, host, path: pathOnly(url), status, requestBytes, responseBytes, denied, ...(reason ? { reason } : {}), durationMs: Date.now() - started });
    };

    if (decision.kind === "deny") {
      if (decision.status === 200) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, routes: options.routes.map((r) => r.alias) }));
        return;
      }
      req.resume();
      res.writeHead(decision.status, { "content-type": "application/json" });
      const body = JSON.stringify({ denied: true, reason: decision.reason });
      responseBytes = Buffer.byteLength(body);
      res.end(body);
      finishLog(decision.status, null, null, true, decision.reason);
      return;
    }

    const { route, upstreamPath } = decision;
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    for (const s of route.secrets) {
      const value = options.secrets[s.ref.slice("env:".length)];
      if (value !== undefined) headers[s.header.toLowerCase()] = (s.prefix ?? "") + value;
    }
    const q = url.indexOf("?");
    const target = new URL(upstreamPath + (q >= 0 ? url.slice(q) : ""), upstreamOrigin(route));
    const upstreamRequest = route.scheme === "https" ? httpsRequest : httpRequest;
    const up = upstreamRequest(target, { method, headers, timeout: timeoutMs }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
      });
      upRes.pipe(res);
      upRes.on("end", () => finishLog(upRes.statusCode ?? 502, route.alias, route.host, false));
    });
    up.on("timeout", () => {
      up.destroy(new Error("upstream timeout"));
    });
    up.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        const status = err.message === "upstream timeout" ? 504 : 502;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      finishLog(err.message === "upstream timeout" ? 504 : 502, route.alias, route.host, false, err.message);
    });
    req.on("data", (chunk: Buffer) => {
      requestBytes += chunk.length;
    });
    req.pipe(up);
  };

  const server = createServer(handle);
  // CONNECT arrives as an event, not a request. In forward mode a listed host is tunneled; otherwise it is refused.
  server.on("connect", (req, socket, head) => {
    if (forward) {
      const started = Date.now();
      const target = req.url ?? "";
      const at = target.lastIndexOf(":");
      const host = (at > 0 ? target.slice(0, at) : target).replace(/^\[|\]$/g, "");
      const port = at > 0 ? Number.parseInt(target.slice(at + 1), 10) : 443;
      let up = 0;
      let down = 0;
      let logged = false;
      const log = (status: number, denied: boolean, reason?: string) => {
        if (logged) return;
        logged = true;
        options.log({ at: new Date(started).toISOString(), method: "CONNECT", alias: null, host, path: `:${port}`, status, requestBytes: up, responseBytes: down, denied, ...(reason ? { reason } : {}), durationMs: Date.now() - started });
      };
      if (!forward.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
        socket.write("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nforward denied: host not allowed\n");
        socket.destroy();
        log(403, true, "forward_host_not_allowed");
        return;
      }
      const upstream = netConnect({ host, port, timeout: timeoutMs }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        // Counted only once the tunnel is open: a data listener attached earlier would drop bytes before the pipe.
        socket.on("data", (c: Buffer) => (up += c.length));
        upstream.on("data", (c: Buffer) => (down += c.length));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
      upstream.on("error", (err) => {
        if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
        log(502, false, err.message);
      });
      socket.on("error", () => upstream.destroy());
      const done = () => {
        upstream.destroy();
        socket.destroy();
        log(200, false);
      };
      socket.on("close", done);
      upstream.on("close", done);
      return;
    }
    const decision = evaluatePolicy(options.routes, "CONNECT", req.url ?? "");
    const reason = decision.kind === "deny" ? decision.reason : "refused";
    socket.write(`HTTP/1.1 405 Method Not Allowed\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}\n`);
    socket.destroy();
    options.log({ at: new Date().toISOString(), method: "CONNECT", alias: null, host: null, path: req.url ?? "", status: 405, requestBytes: 0, responseBytes: 0, denied: true, reason, durationMs: 0 });
  });
  return server;
}

export interface EgressSummary {
  requests: number;
  denied: number;
  requestBytes: number;
  responseBytes: number;
  hosts: string[];
  statuses: Record<string, number>;
}

export function summarizeEgress(lines: readonly EgressLogLine[]): EgressSummary {
  const summary: EgressSummary = { requests: lines.length, denied: 0, requestBytes: 0, responseBytes: 0, hosts: [], statuses: {} };
  for (const l of lines) {
    if (l.denied) summary.denied += 1;
    summary.requestBytes += l.requestBytes;
    summary.responseBytes += l.responseBytes;
    if (l.host && !summary.hosts.includes(l.host)) summary.hosts.push(l.host);
    summary.statuses[String(l.status)] = (summary.statuses[String(l.status)] ?? 0) + 1;
  }
  summary.hosts.sort();
  return summary;
}

export function parseEgressLog(text: string): EgressLogLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as EgressLogLine];
      } catch {
        return [];
      }
    });
}
