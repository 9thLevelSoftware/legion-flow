# ADR-0001: Node.js floor stays at 22.13.0

**Status:** accepted-provisional · **Date:** 2026-10-08

## Context

The main report recommends Node `>=22.13.0` as the floor that satisfies every dependency it keeps (legion-cli `>=22`, Mastra `>=22.13.0`, the OpenTelemetry JS SDK `^18.19.0 || >=20.6.0`, E2B `>=20.18.1 <21 || >=22`) while staying inside legion-ascended's supported range on Node 24. The addendum introduces a tension: Stagehand 4.1.0, the only conditional ADOPT candidate, requires `>=22.18.0`. Two excluded packages have higher floors (mcp-use `>=22.22.2`, OpenClaw `>=24.16`) but are not dependencies. `node:sqlite` was unflagged in 22.13.0, which makes the floor a natural match for ADR-0003.

## Decision

Keep `engines.node >= 22.13.0` in every `package.json`, and the same floor in `doctor`'s `NODE_FLOOR` check. Tests have been verified on Node 24; no CI configuration exists in this repository yet. Raise the floor to `22.18.0` only if, and when, the Stagehand spike in ADR-0004 passes and the package is adopted. Record the mismatch in the tech stack table until then.

## Consequences

- No user on a 22.13 to 22.17 Node is excluded today.
- If Stagehand is adopted, the raise is a documented, one-line change with a changelog entry, not a silent drift.
- Nothing yet guards the floor against accidental use of newer built-ins: a job on exactly 22.13.0 belongs in the CI matrix when one is set up. `engines` and `NODE_FLOOR` only refuse a lower version.

## Spike

None for the floor itself. Linked to the ADR-0004 spike outcome.
