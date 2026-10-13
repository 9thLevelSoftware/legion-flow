import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { createProxyServer, evaluatePolicy, validateRoutes, secretRefs, summarizeEgress, parseEgressLog, type EgressLogLine } from "../dist/index.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("egress policy (pure)", () => {
  const routes = validateRoutes([
    { alias: "anthropic", host: "api.anthropic.com", secrets: [{ header: "x-api-key", ref: "env:ANTHROPIC_API_KEY" }] },
    { alias: "local", host: "host.docker.internal", port: 8081, scheme: "http" },
  ]);

  test("routes validate: no wildcards, no schemes, no duplicate aliases; refs are names", () => {
    assert.throws(() => validateRoutes([{ alias: "x", host: "*.example.com" }]));
    assert.throws(() => validateRoutes([{ alias: "x", host: "https://example.com" }]));
    assert.throws(() => validateRoutes([{ alias: "x", host: "a.com" }, { alias: "x", host: "b.com" }]), /egress_route_conflict/);
    assert.throws(() => validateRoutes([{ alias: "x", host: "a.com", secrets: [{ header: "k", ref: "sk-live-123" }] }]), "a value is not a ref");
    assert.deepEqual(secretRefs(routes), ["ANTHROPIC_API_KEY"]);
  });

  test("deny-all: only /<alias>/... is forwarded; CONNECT and unknown aliases are refused with a status and reason", () => {
    const allow = evaluatePolicy(routes, "POST", "/anthropic/v1/messages?beta=1");
    assert.equal(allow.kind === "allow" && allow.upstreamPath, "/v1/messages");
    assert.equal(evaluatePolicy(routes, "GET", "/anthropic").kind === "allow" && (evaluatePolicy(routes, "GET", "/anthropic") as { upstreamPath: string }).upstreamPath, "/");
    const unknown = evaluatePolicy(routes, "GET", "/openai/v1");
    assert.equal(unknown.kind === "deny" && unknown.status, 403);
    const tunnel = evaluatePolicy(routes, "CONNECT", "api.anthropic.com:443");
    assert.equal(tunnel.kind === "deny" && tunnel.status, 405);
    assert.equal(evaluatePolicy(routes, "GET", "/").kind, "deny");
  });
});

describe("egress proxy in-process against a recording upstream", () => {
  let upstream: Server;
  let upstreamPort: number;
  let proxy: Server;
  let proxyPort: number;
  const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const log: EgressLogLine[] = [];

  before(async () => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body });
        if (req.url?.startsWith("/slow")) return; // never answers
        res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
        res.end(`upstream saw ${req.method} ${req.url}`);
      });
    });
    upstreamPort = await listen(upstream);
    const routes = validateRoutes([{ alias: "up", host: "127.0.0.1", port: upstreamPort, scheme: "http", secrets: [{ header: "authorization", ref: "env:LF_TEST_KEY" }] }]);
    proxy = createProxyServer({ routes, secrets: { LF_TEST_KEY: "Bearer real-secret" }, log: (l) => log.push(l), upstreamTimeoutMs: 500 });
    proxyPort = await listen(proxy);
  });

  after(() => {
    proxy.close();
    upstream.close();
  });

  test("a routed request reaches the upstream with the secret header set from the proxy's own environment, replacing the agent's placeholder", async () => {
    const res = await call(proxyPort, "POST", "/up/v1/thing?x=1", { authorization: "Bearer placeholder", "x-custom": "kept", host: "ignored" }, '{"a":1}');
    assert.equal(res.status, 200);
    assert.equal(res.body, "upstream saw POST /v1/thing?x=1");
    assert.equal(res.headers["x-upstream"], "yes");
    const u = seen.at(-1)!;
    assert.equal(u.headers.authorization, "Bearer real-secret");
    assert.equal(u.headers["x-custom"], "kept");
    assert.equal(u.headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(u.body, '{"a":1}');
    const line = log.at(-1)!;
    assert.equal(line.alias, "up");
    assert.equal(line.path, "/up/v1/thing", "no query string in the log");
    assert.equal(line.denied, false);
    assert.equal(line.requestBytes, 7);
    assert.ok(!JSON.stringify(line).includes("real-secret") && !JSON.stringify(line).includes("placeholder"));
  });

  test("unknown alias is 403 and logged as denied; CONNECT is 405; a silent upstream is 504; healthz answers", async () => {
    const denied = await call(proxyPort, "GET", "/elsewhere/v1");
    assert.equal(denied.status, 403);
    assert.match(denied.body, /not an allowlisted route/);
    assert.equal(log.at(-1)?.denied, true);
    assert.equal(seen.length, 1, "nothing reached the upstream");

    const tunnel = await new Promise<string>((resolve) => {
      const s = connect(proxyPort, "127.0.0.1", () => s.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n"));
      let data = "";
      s.on("data", (c) => (data += c));
      s.on("close", () => resolve(data));
      s.on("error", () => resolve(data));
    });
    assert.match(tunnel, /^HTTP\/1\.1 405/);
    assert.equal(log.at(-1)?.method, "CONNECT");

    const slow = await call(proxyPort, "GET", "/up/slow");
    assert.equal(slow.status, 504);
    assert.equal(log.at(-1)?.status, 504);

    const health = await call(proxyPort, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.match(health.body, /"routes":\["up"\]/);

    const summary = summarizeEgress(parseEgressLog(log.map((l) => JSON.stringify(l)).join("\n")));
    assert.equal(summary.requests, 4);
    assert.equal(summary.denied, 2);
    assert.deepEqual(summary.hosts, ["127.0.0.1"]);
    assert.equal(summary.statuses["403"], 1);
  });
});

describe("M4 slice (o2): forward mode", () => {
  test("an absolute-URI request reaches a listed host only, logged without its query; https by URI and an unlisted host are 403", async () => {
    const upstream = createServer((req, res) => res.end(`upstream saw ${req.url} host ${req.headers.host}`));
    const upPort = await listen(upstream);
    const lines: EgressLogLine[] = [];
    const proxy = createProxyServer({ routes: [], secrets: {}, log: (l) => lines.push(l), forwardHosts: ["127.0.0.1"] });
    const port = await listen(proxy);
    try {
      const ok = await call(port, "GET", `http://127.0.0.1:${upPort}/page?token=abc`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body, `upstream saw /page?token=abc host 127.0.0.1:${upPort}`);
      const denied = await call(port, "GET", `http://localhost:${upPort}/page`);
      assert.equal(denied.status, 403);
      const tls = await call(port, "GET", `https://127.0.0.1:${upPort}/`);
      assert.equal(tls.status, 403);
      assert.deepEqual(lines.map((l) => [l.method, l.host, l.path, l.status, l.denied, l.reason ?? ""]), [
        ["GET", "127.0.0.1", "/page", 200, false, ""],
        ["GET", "localhost", "/page", 403, true, "forward_host_not_allowed"],
        ["GET", "127.0.0.1", "/", 403, true, "forward_scheme"],
      ]);
      assert.ok(!JSON.stringify(lines).includes("token=abc"), "the query string is never logged");
    } finally {
      proxy.close();
      upstream.close();
    }
  });

  test("CONNECT tunnels to a listed host and counts bytes; an unlisted host is 403", async () => {
    const { createServer: createTcp } = await import("node:net");
    const echo = createTcp((s) => s.pipe(s));
    const echoPort = await new Promise<number>((r) => echo.listen(0, "127.0.0.1", () => r((echo.address() as AddressInfo).port)));
    const lines: EgressLogLine[] = [];
    const proxy = createProxyServer({ routes: [], secrets: {}, log: (l) => lines.push(l), forwardHosts: ["127.0.0.1"] });
    const port = await listen(proxy);
    const tunnel = (target: string, payload: string) =>
      new Promise<string>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let data = "";
        let sent = false;
        s.on("data", (c) => {
          data += c.toString();
          if (!sent && data.includes("\r\n\r\n") && data.startsWith("HTTP/1.1 200")) {
            sent = true;
            s.write(payload);
          } else if (sent && data.endsWith(payload)) s.end();
        });
        s.on("close", () => resolve(data));
        s.on("error", reject);
      });
    try {
      const ok = await tunnel(`127.0.0.1:${echoPort}`, "ping-through-tunnel");
      assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nping-through-tunnel$/);
      const denied = await tunnel(`localhost:${echoPort}`, "x");
      assert.match(denied, /^HTTP\/1\.1 403 Forbidden/);
      await new Promise((r) => setTimeout(r, 50));
      const connects = lines.filter((l) => l.method === "CONNECT");
      assert.deepEqual(connects.map((l) => [l.host, l.path, l.status, l.denied]), [["127.0.0.1", `:${echoPort}`, 200, false], ["localhost", `:${echoPort}`, 403, true]]);
      assert.equal(connects[0]!.requestBytes, "ping-through-tunnel".length);
      assert.equal(connects[0]!.responseBytes, "ping-through-tunnel".length);
    } finally {
      proxy.close();
      echo.close();
    }
  });
});

describe("M4 slice (y): a route's basePath and a bearer secret", () => {
  test("validation accepts /seg and /seg/seg and refuses a trailing slash, dot segments, or a non-path; the policy joins basePath in front of the forwarded path", () => {
    assert.equal(validateRoutes([{ alias: "p", host: "api.example.com", basePath: "/anthropic" }])[0]?.basePath, "/anthropic");
    assert.equal(validateRoutes([{ alias: "p", host: "api.example.com", basePath: "/a/b-1" }])[0]?.basePath, "/a/b-1");
    for (const bad of ["/anthropic/", "anthropic", "/a/../b", "/..", "/a?x=1", "", "/a b"]) {
      assert.throws(() => validateRoutes([{ alias: "p", host: "api.example.com", basePath: bad }]), /basePath/, bad);
    }
    const routes = validateRoutes([{ alias: "p", host: "api.example.com", basePath: "/anthropic" }, { alias: "q", host: "q.example.com" }]);
    const a = evaluatePolicy(routes, "POST", "/p/v1/messages?beta=true");
    assert.equal(a.kind === "allow" && a.upstreamPath, "/anthropic/v1/messages");
    const bare = evaluatePolicy(routes, "GET", "/p");
    assert.equal(bare.kind === "allow" && bare.upstreamPath, "/anthropic/");
    const plain = evaluatePolicy(routes, "GET", "/q/v1/x");
    assert.equal(plain.kind === "allow" && plain.upstreamPath, "/v1/x", "a route without basePath is unchanged");
    assert.equal(evaluatePolicy(routes, "GET", "/healthz").kind, "deny");
  });

  test("through the proxy: the upstream sees <basePath>/<path> with the query, exactly one auth header, Bearer plus the real value, and the agent's placeholder never arrives", async () => {
    const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const upstream = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const upstreamPort = await listen(upstream);
    const routes = validateRoutes([{ alias: "anthropic", host: "127.0.0.1", port: upstreamPort, scheme: "http", basePath: "/anthropic", secrets: [{ header: "authorization", ref: "env:LF_PROVIDER_KEY", prefix: "Bearer " }] }]);
    const lines: EgressLogLine[] = [];
    const proxy = createProxyServer({ routes, secrets: { LF_PROVIDER_KEY: "tp-real-secret" }, log: (l) => lines.push(l) });
    const proxyPort = await listen(proxy);
    try {
      // What claude sends with ANTHROPIC_AUTH_TOKEN set to the placeholder and no ANTHROPIC_API_KEY.
      const res = await call(proxyPort, "POST", "/anthropic/v1/messages?beta=true", { authorization: "Bearer legion-flow-placeholder", "anthropic-version": "2023-06-01" }, "{}");
      assert.equal(res.status, 200);
      const u = seen.at(-1)!;
      assert.equal(u.url, "/anthropic/v1/messages?beta=true");
      assert.equal(u.headers.authorization, "Bearer tp-real-secret");
      assert.equal(u.headers["x-api-key"], undefined, "no second auth header");
      assert.equal(u.headers["anthropic-version"], "2023-06-01");
      assert.ok(!JSON.stringify(lines).includes("tp-real-secret"), "the log never holds the value");
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});
