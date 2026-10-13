# ADR-0002: pnpm pinned at 9.15.9, not the report's >= 11

**Status:** accepted-provisional · **Date:** 2026-10-08

## Context

The siblings disagree on the package manager: legion-cli pins pnpm 9.15.9, legion-ascended requires `>=11.4.0 <12`, and the main report recommends `>=11` to match legion-ascended and Mastra. The repository today pins `pnpm@9.15.9` through the `packageManager` field, matching legion-cli, whose persist and CLI patterns this tool copies most directly. When this was decided the workspace had five dependencies and a 60-line lockfile; by M4 the graph carries the MCP SDK, four OpenTelemetry packages, `playwright-core`, `typescript`, and `zod` in a lockfile of about 1,100 lines, and still nothing in it needs a pnpm 11 feature.

## Decision

Keep `packageManager: pnpm@9.15.9` and lockfile version 9.0. The planned M2 revisit, when the dependency graph grew (OpenTelemetry, MCP SDK, Playwright), found no reason to move: the pin is unchanged through M4.

## Consequences

- Contributors coming from legion-cli need no second pnpm.
- Contributors coming from legion-ascended must use Corepack or a version manager to run 9.15.9; `doctor` should report a pnpm mismatch when it gains toolchain checks.
- A later move to pnpm 11 regenerates the lockfile once and is done in its own commit.

## Spike

None. Decision is reversible at M2 with a single lockfile regeneration.
