# ADR-0005: Outbound MCP client (Legion spawning stdio servers as tool providers)

**Status:** accepted for spawning and probing (M4 slice f, 2026-10-09) and for agent tool calls through the tool gateway (M4 slice k, 2026-10-10) · **Date:** 2026-10-08

## Context

The main report settled the inbound side: a read-only MCP surface over which host agents observe the engine. The addendum shows that the interesting direction for a workflow engine is outbound, where Legion spawns stdio MCP servers as tool providers and inherits every problem the tutorials exhibit: plaintext keys in `env` blocks, `npx`-launched servers that need a global npm, `.cmd` shims on Windows that break when spawned with `shell: true`, per-server stderr as the only diagnostic channel. The official TypeScript SDK exists in two lines (v1 `@modelcontextprotocol/sdk` 1.32.x, MIT mid-transition to Apache-2.0; v2 split `@modelcontextprotocol/{core,client,server}` 2.3.x, Apache-2.0); its `cross-spawn` dependency suggests shim-safe spawning but this is inferred, not read from source. `mcp-use` is excluded (hard-coded PostHog telemetry, Node `>=22.22`).

## Spike result (M4 slice f, 2026-10-09)

Servers are declared in `project.json` `mcpServers` (not `config.yaml`, which nothing reads), with an optional image. Spawning goes through Legion's own session code, not the SDK's: `spawnPiped` on the host resolves a `.cmd` shim and runs it through `cmd.exe` with our quoting, and `docker run -i` runs a server in its image under `vm-docker` (the default, per ADR-0010). The SDK v1 `Client` (1.32.1, MIT per npm) speaks over those pipes through an in-package newline-JSON transport that captures the negotiated protocol version. Verified on Windows 11: a dependency-free fake server on the host, through a local `.cmd` shim launched by absolute path, and inside `node:22-alpine`. Not run: any real third-party server, and `npx` (it downloads). The `tools` verb probes and never calls a tool; the negotiated version is recorded in the probe record, and since the loose-ends slice after M4 slice (aa) also in a run's `tool_server` evidence record, one per server the gateway starts, with the server's reported name and version. Since M4 slice (k) agents call tools through the tool gateway, which lists and calls only the tools the approved plan names for the task and refuses past `toolPolicy.maxSteps` (`refused_budget`).

## Decision (original)

Proposed in two parts. Part 1 (M1, schema only): add `mcpServers` to `config.yaml` as `{ name, command, args[], envKeys[] }` under the same frozen-argv and env-allowlist discipline as agent CLIs, with `envKeys` holding variable names only; refuse shell strings; record the negotiated protocol version in run evidence beside `graphFingerprint`. Part 2 (M2, spawn path): decided by the spike. Tool `destructiveHint` and `openWorldHint` map onto `mutating` and `riskClass`; every MCP-driven loop carries a mandatory `max_steps`. Installing an `npx`-fetched server package is egress and the egress policy decides it. The SDK line (v1 or v2) is chosen at spike time and pinned to the exact audited version.

## Consequences

- Part 1 costs nothing at runtime and lets `doctor` validate server declarations early.
- Part 2 adds the MCP SDK to the runtime graph for the cli package (adapters never spawn and import no SDK); the v1 package pulls Express 5 and Hono even for client-only use, which argues for the v2 client package if its telemetry audit is clean.
- Secrets never reach a spawned server directly: the egress proxy injects them, matching the agent-CLI design.

## Spike

1. On Windows, spawn an `npx.cmd`-launched reference server over stdio without `shell: true` using the chosen SDK; confirm `APPDATA` passthrough and a global npm are sufficient; capture stderr to `var/`.
2. Confirm which protocol versions the pinned SDK negotiates and that the version appears in evidence.
3. Audit the chosen package's dependency list for telemetry; pin the exact version whose LICENSE was read.
4. Confirm a server declared with a shell string is refused by `doctor`.
