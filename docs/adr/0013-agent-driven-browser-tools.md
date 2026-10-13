# ADR-0013: Model-driven browsing is a built-in tool gateway server, driven by the task's own agent

**Status:** accepted (M4 slice o1, 2026-10-10) · **Date:** 2026-10-10

## Context

Section 6.4 describes model-driven browsing (observe, then act) and slice (e) built only deterministic browser checks, because the design seemed to need a model call from Legion and a tool channel into the sandbox. Slice (k) built that channel: the tool gateway, with a per-run token, a risk policy, a step budget, and `tool_call` evidence. ADR-0004 (Stagehand) assumes Legion runs its own observe-and-act loop against a model; that spike still needs a key and has not been run.

## Decision

The agent already running the task is the model. The browser is a built-in, in-process downstream of the tool gateway named `browser` (the name is reserved in `mcpServers`). A plan task opts in with `tools: ["browser"]` and a `browser` block (`allowedDomains`, `startUrl`, `secrets` by `env:NAME`, `serve`, `allowRisk`, `deny`, `maxSteps`, `stepTimeoutMs`), which the plan fingerprint covers, so approval freezes it and a run cannot widen its own allowlist. The tools are `observe` (Playwright's public `ariaSnapshot({ mode: "ai" })`, whose `[ref=eN]` refs `page.getByRef` resolves), `extract`, `screenshot` (read), `goto` (network), and `click`, `fill`, `press`, `fill_secret` (edit). There is no `evaluate` and no `upload_file`. Refs are valid only for the latest `observe` on the current document. `fill_secret` types a declared secret by name from Legion's own code (on the host, or in the browser container); until the next navigation, `observe`, `extract`, and `screenshot` are refused. Page text reaches the agent only inside `<untrusted-content source="browser">`. On the unhardened tier the browser runs on the host, as checks do; under `vm-docker` it runs in its own container (ADR-0014).

## Consequences

Legion makes no model call of its own for browsing, so the whole path is tested with the `fake` agent and no key. The gateway's `Downstream` is now `{ name, allowRisk, deny, tools, call, close }` plus an optional `failed` marker, so a server may be an SDK client or in-process. As first built, under `vm-docker` the agent was contained but the browser was not; slice (o2) moved the browser into its own container behind a forward-mode proxy (ADR-0014), and the host browser remains for the unhardened tier. ADR-0004 stays proposed: Stagehand would be a different driver behind the same tools, not a different design.
