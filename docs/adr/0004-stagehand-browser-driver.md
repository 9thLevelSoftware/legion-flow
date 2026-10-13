# ADR-0004: Browser driver, Playwright baseline with Stagehand ADOPT-after-spike

**Status:** proposed · **Date:** 2026-10-08

## Context

The main report's `browser` package reimplements Browser Use's observation and action-registry patterns on Playwright (BORROW), because Browser Use's core is Python and its TypeScript agent is cloud-first with telemetry on. The addendum found Stagehand 4.1.0: MIT, TypeScript-first, Node `>=22.18`, local Chromium via `localBrowser.launch` or `connect({ cdpUrl })`, model calls direct to the provider when an API key is supplied, no analytics dependency, only OpenTelemetry trace-context propagation. It is the only library in the addendum that could move from BORROW to ADOPT. Costs if adopted: an exact `zod@4.4.3` pin that may give the workspace two Zod copies, a Node floor of 22.18 (ADR-0001), no per-step evidence or success verification out of the box, and "there is no base URL option", so the egress proxy applies only through the bring-your-own-model callback.

## Decision

Proposed: Playwright with reimplemented patterns remains the design baseline. Stagehand becomes ADOPT if the three-step spike passes. Regardless of outcome, two Stagehand patterns are borrowed: credentials are typed by host code into an observed selector so the model never sees a placeholder, and observe-then-act is the proposal seam for a typed interrupt.

## Consequences

- The `browser` package design does not freeze until the spike runs (M4 entry).
- If adopted, the parallel-stacks cost returns: Stagehand drives CDP through an in-browser extension and is not Playwright, so screenshot and evidence capture need their own path.
- If not adopted, the DOM-serializer reimplementation effort remains unquantified and must be sized before M4.

## Status note (M4 slice e, 2026-10-09)

The Playwright baseline was built as scripted browser checks on `playwright-core` 1.64.0. Steps 1 and 3 below need a model key; none exists on this machine, so they were not run and the decision stays proposed. Step 2 was not attempted either, since adopting Stagehand depends on all three.

## Spike

1. `localBrowser.launch` plus `Stagehand.create({ model: { apiKey } })` under network capture: zero egress to any host other than the model provider.
2. `localBrowser.connect({ cdpUrl })` against a Playwright-launched Chromium: the extension loads and `observe()` returns selectors.
3. Bring-your-own-model callback routed through Legion's adapter registry so the loopback proxy, not the process, holds the key.
4. (Evidence only, does not gate the verdict) screenshot and observation hashes obtainable from the Stagehand page object per step.

Steps 1 to 3 pass: ADOPT. Any fails: BORROW stands; record what failed here.
