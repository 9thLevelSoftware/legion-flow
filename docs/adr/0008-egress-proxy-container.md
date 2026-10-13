# ADR-0008: The egress proxy is a per-run container on an internal network

**Status:** accepted · **Date:** 2026-10-08

## Context

The research draws the egress proxy as a loopback process on the host that the sandboxed agent reaches through a socket or a host-gateway route. On this platform that shape does not exist: a container started with `--network none` reaches nothing, including the host's loopback, and Docker Desktop on Windows offers no unix socket a container can share with the host. Verified on this machine: a container on a Docker network created with `--internal` reaches a container on the same network by name and times out against the host and the internet; a container attached to that network and to a second, ordinary network reaches both.

## Decision

Each run gets an internal network `lf-net-<runId>` with no gateway, a proxy container `lf-proxy-<runId>` running this repository's own dependency-free proxy from the run's own resolved image (the agent image for `claude` and `codex`, otherwise the configured or default `node:22-alpine`), attached to the internal network and to its own outbound network `lf-out-<runId>` (never the shared default bridge), and the agent container joins the internal network only. Deny-all is therefore structural rather than a rule: the only reachable name is the proxy. Secrets reach the proxy as `-e NAME` with the value in the Docker client's environment; the agent holds a placeholder and a base URL pointing at `/<alias>/` on the proxy. The proxy sets the configured header, forwards over HTTPS, logs one line per request to a directory outside every agent mount, and refuses `CONNECT`.

## Consequences

- A run with any route starts a second container and two networks, torn down when the run ends and by the next preflight's stale sweep; preflight carries a label-based cleanup.
- No `CONNECT` means no raw TLS egress (the browser's separate proxy is the one exception, in forward mode with a host allowlist: ADR-0014): tools without a base-URL override cannot run in the hardened tier. The allowlist is a host rule, not a request rule.
- The proxy is trusted code in a container that does have egress; a secret is visible to anyone with `docker inspect` rights on the host for the run's duration.
- The container-side proxy code must stay dependency-free: its directory is bind-mounted alone, and an import of any package crashes it before it reports ready.
- Rejected alternatives: a host loopback process (unreachable from `--network none`); a bridge network with firewall rules inside the agent container (needs capabilities the hardening set drops); the shared default bridge for the proxy (neighbours could borrow the key).

## Spike

A vendor CLI through this path has not been exercised: no model call has been made. The fake adapter proves the route, the header, the denial, and the log.
