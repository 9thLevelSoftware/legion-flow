# ADR-0016: An Anthropic-compatible provider runs the claude adapter through `adapter.http`, with the key as a bearer token set by the proxy

**Status:** accepted (M4 slice y, 2026-10-12), partly superseded by [ADR-0018](0018-codex-through-a-responses-provider.md): the provider now follows the default adapter, and codex takes one too · **Date:** 2026-10-12

## Context

The `claude` adapter's provider route was fixed to `api.anthropic.com`, with `ANTHROPIC_API_KEY` sent as `x-api-key`. Several providers serve an Anthropic-compatible API that Claude Code can drive, Xiaomi MiMo among them. Each documents an API root under a path (MiMo's sits under `/anthropic`) and a bearer token that Claude Code reads from `ANTHROPIC_AUTH_TOKEN`. `project.json` already had an `adapter.http` block with `baseUrl`, `model`, and `apiKeyEnv`. Only `model` was read. No test in this repository had ever made a model request.

## Decision

`adapter.http.baseUrl` plus `apiKeyEnv` name a provider for the `claude` adapter. `withProvider` derives the definition every verb then uses:

- **The route** goes to the provider's host, with the URL's path as a new optional route field, `basePath`. The proxy puts it in front of every forwarded path. The secret is `authorization: Bearer <value of apiKeyEnv>`, set by the proxy from its own environment.
- **The credential** is `apiKeyEnv`, so the presence check, the `credential_required` pause, and the redaction list all name it.
- **Inside the container** the placeholder rides `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` is not set. Exactly one auth header leaves the agent, and it is the one the proxy overwrites.
- **On the host tier** the real value is handed to the CLI as `ANTHROPIC_AUTH_TOKEN`, under no other name, and `ANTHROPIC_BASE_URL` points at the provider's root.
- **With a model**, `ANTHROPIC_MODEL` and the three `ANTHROPIC_DEFAULT_*_MODEL` variables are set to it, as the provider's own Claude Code guide does.
- **Cost is unknown.** The CLI prices usage at its vendor's rates, so the parsed cost is dropped and the profile cannot report cost. `costLimitUsd` is refused as unreportable, while turns and tokens still work.

One function in `cli`, `adapterFor`, builds every adapter from the project config, so `execute`, `review`, `spec --challenge`, `observe --agent`, and `--resume` cannot disagree about the route. A provider with `codex` as the default adapter is refused as `adapter_provider_unsupported`, because codex would ignore it and call its own vendor. The `fake` adapter ignores it with an info line. `baseUrl` must be https (http only on loopback), with no query, fragment, or credentials. `apiKeyEnv` must be a variable name, and is required once `baseUrl` is set.

## Consequences

- One task run on `vm-docker` against MiMo's Token Plan endpoint passed (`packages/cli/test/live-adapter.test.ts`, opt-in with `LF_LIVE_ADAPTER_TESTS=1`). The file was written and the check passed. Usage was parsed with cost unknown. Every egress line named only the provider's host. The key's value was in no file under the run's state. That verifies, for this path, that Claude Code accepts a placeholder bearer token behind the proxy, honours the proxied base URL, and runs with `bypassPermissions` as uid 1000. It does not verify the `x-api-key` path against Anthropic itself.
- On the host tier, a user-level Claude Code `settings.json` with its own `env` block can override these variables; the container has an empty home and cannot be overridden. Use `vm-docker` for runs you mean to trust.
- `basePath` is a prefix, not a confinement: the host allowlist is the boundary, and any path on that host is reachable.
- Setting `adapter.http` changes the config fingerprint, so the spec and plan need approval again.
- The provider is project-wide for every `claude` member and the reviewer. Per-member providers and codex against an OpenAI-compatible root are not built.
