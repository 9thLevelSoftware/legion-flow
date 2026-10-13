# ADR-0017: Web fetching is a built-in gateway server that calls a self-hosted Firecrawl on loopback

**Status:** accepted (M4 slice z, 2026-10-12) · **Date:** 2026-10-12

## Context

Firecrawl turns a URL into clean markdown. Its server is AGPL, and its SDK, `@mendable/firecrawl-js`, was still on Zod 3. The research left Firecrawl as an Optional CALL behind an egress route. Two other shapes were possible. A hook pushes records out after a run, which does not fit fetching a page on demand. Firecrawl's own MCP server could be declared under `mcpServers`, but under `vm-docker` those servers run with `--network none`, so it could not reach Firecrawl at all.

## Decision

The tool gateway gets a second built-in server, `web`, beside `browser`. It runs in Legion's process with one tool, `scrape`, classed `network` as the browser's `goto` is. It calls the project's Firecrawl with plain HTTP, `POST /v2/scrape`, so no SDK is used.

- **Configuration.** `project.json` `web.firecrawlUrl` must be a loopback URL, the eval judge's rule: a remote Firecrawl would be egress and is refused. Legion never starts, builds, or bundles Firecrawl. A task naming `web` without it is refused as `web_unconfigured`.
- **Consent.** A task opts in with `tools: ["web"]` and a `web` block (`allowedDomains`, and optionally `allowRisk`, `deny`, `timeoutMs`, `maxBytes`). Plan approval freezes both, and that approval is the consent. `allowRisk` defaults to `["network"]`, because naming `web` is already the opt-in.
- **The boundary.** The request host must be an exact entry in `allowedDomains` before anything is sent; otherwise nothing is fetched. After the call, Firecrawl's reported final URL (`metadata.url`) must be on the list too, and content whose final URL is off the list or missing is withheld.
- **The request.** Only `url`, `formats`, `onlyMainContent`, and `timeout` are sent, never agent-supplied actions, headers, or waits. The loopback call never follows a redirect.
- **The result.** Content is wrapped as `<untrusted-content source="web" url="...">`, with any such tag inside the page stripped, and cut at `maxBytes` (48 KiB by default). Each call writes a `web_fetch` evidence record with the host, final URL, page status, byte counts, a content hash, and any refusal, next to the gateway's own `tool_call` record.

## Consequences

- **The after-check is weaker than designed.** Measured against self-hosted Firecrawl v2.11.162: its default Playwright engine reports the requested URL as `metadata.url` even after a cross-host redirect, and its source marks redirect following as a TODO. So a redirect from a listed host to an unlisted one is not detected with that engine. The check works when Firecrawl uses its plain fetch engine, which does report the final URL. Each record says `redirectCheck: "reported_url_only"`, and the agent's result says the same. The request-host check is the boundary that always holds. Closing the gap would mean Legion following the redirect chain itself, which would make Legion's own process reach the internet; that is not done.
- **Legion does not sandbox Firecrawl.** Firecrawl's containers make the fetch, so a listed name that resolves to a private address is Firecrawl's concern. Legion's own process connects only to loopback.
- **Verified live on Windows with Docker Desktop.** Against a real self-hosted stack, an allowed page returned markdown and an unlisted host was never sent. In one task run, `claude` (through an Anthropic-compatible provider, ADR-0016) on `vm-docker` called `web__scrape` through the gateway and wrote what it read. That run also verified, for the first time, that Claude Code expands `${LF_TOOLS_URL}` and the bearer header in its `--mcp-config` behind the proxy.
- **Naming.** An `mcpServers` entry named `web` is now invalid, as `browser` already was. The project config gains an optional field, so no fingerprint moves.
- **Scope.** Crawl, map, and search are not exposed. Self-hosted search needs a search backend the Firecrawl docs do not describe.
