# ADR-0009: A proposal that breaks an architecture rule is never auto-applied

**Status:** accepted (M4 slice a2, 2026-10-09) · **Date:** 2026-10-09

## Context

At risk tier R0 an `execute` proposal is applied to the checkout without a human, with an audit record. M4 slice (a2) adds architecture rules (`project.json` `map.rules`) and an `architecture_conformance` gate at ship. Without anything more, an R0 run could land a forbidden import in the checkout and the human would learn of it only when `ship` reports the gate unsatisfied, after later tasks may already build on it.

## Decision

`execute` maps the corrected candidate tree and compares its violations with the checkout's, by an id that ignores how an edge was resolved. A proposal that introduces at least one violation pauses at R0 with the same apply interrupt R1 uses; the violations are in the proposal, the `decide` payload, and warnings on the envelope. A proposal whose architecture check could not run pauses as well: an unknown is not a pass. A proposal that only resolves violations, or touches none, applies as before.

## Consequences

- R0 is no longer "always automatic". The tier table is unchanged; the exception is a property of the proposal, not of the tier.
- Projects without rules are unaffected: no rules, no comparison, no pause.
- Every proposal maps the candidate tree for its blast radius (about a second on a 140-module repository), at every tier. With rules present the checkout is mapped as well, so two trees.
- A human can still approve the violating proposal; the gate at `ship` then reports it, and only a recorded waiver lets the release through.
