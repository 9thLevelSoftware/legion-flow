# ADR-0014: The browser runs in its own container behind a forward-mode proxy that tunnels only to listed hosts

**Status:** accepted (M4 slice o2, 2026-10-10) · **Date:** 2026-10-10

## Context

ADR-0008's egress proxy is a reverse proxy: the agent reaches `/<alias>/...` and nothing else, and `CONNECT` answers 405, because an agent's provider traffic can always be pointed at a base URL. A browser cannot be: pages name their own hosts, over HTTPS, and need `CONNECT`. Slice (o1) ran the agent-driven browser on the host, with request interception inside the browser as the only boundary, and refused `serve` under `vm-docker` because serving runs code the agent wrote.

## Decision

Under `vm-docker` the gateway's `browser` server runs inside a locally built image (`legion-flow-browser:playwright-<version>`, Chromium's headless shell installed by the same `playwright-core` version Legion depends on, written as a Dockerfile under `var/images/browser/` and never built or pulled by `execute`), as an MCP server on stdio, with the usual hardening set and the run's tree mounted read-only. It sits on its own per-run internal network (`lf-net-<runId>-browser`) whose only way out is a second proxy started in **forward mode**: `CONNECT host:port` is tunneled, without TLS interception, only to a host in the session's `allowedDomains`; an absolute-URI plain-HTTP request is forwarded only to a listed host; anything else is 403, and every request is logged with its host and byte counts (never a query string). Loopback names mean the browser container itself and are never forwarded, so `serve` runs there. The agent's own proxy is unchanged and separate, so the agent container cannot borrow the browser's tunnel. Secret values reach the browser container by name; the agent container never holds them.

## Consequences

The browser's reachable network is now the Docker engine's internal network plus a host allowlist enforced outside the browser, with interception inside the browser kept as a second layer. This is a property of the Docker engine (tested under Docker Desktop on Windows), not of the Windows host. A `serve` command is the agent's code running in the browser container, as the same user as the process that holds the secret values and on the browser's network: it inherits no secret, but it could read the server's environment through the process table. Since M4 slice (r) a session may therefore serve or type secrets, not both (`plan_browser_session_unsafe` at `approve plan`); a check script keeps both, because a human wrote it. A served app can still reach every listed host through the tunnel. Forward mode does not inspect TLS: a listed host is reachable on any port and path. The image is about 1.2 GB on disk. The container-side code (`browser-mcp-main.js`, `session-core.js`, `common.js`) must import only Node built-ins and each other, since the package's dist is mounted alone; a test enforces it.
