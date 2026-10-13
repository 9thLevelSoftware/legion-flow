# ADR-0011: Parallel tasks integrate through a merge queue that rebases and reverifies

**Status:** accepted (M4 slice d, 2026-10-09) · **Date:** 2026-10-09

## Context

`execute --jobs` runs several tasks at once. Until then apply refused `source_changed` whenever the checkout no longer fingerprinted as it did when the task materialized, so the second of two parallel tasks could never apply, even with disjoint files. Disjoint files are also not independence: one task's untouched code may call a function another just changed. Three shapes were considered: a merge queue (applies one at a time, each later proposal reverified on the current checkout), a batch (all proposals combined, verified once, one human decision), and parallel agents only at R0 with apply unchanged.

## Decision

A merge queue. Agents materialize, spawn, and propose in parallel; applies are serialized per checkout, in the order runs reach the apply node. A proposal whose checkout moved is rebased only when every changed path since its materialization was applied by another run after that moment and none is one of its own files; the current checkout is copied, the proposal written into the copy, and the task's checks, the receipt checks, and the architecture analysis run again there. It applies only if they pass, and the `rebase` evidence record names the base, the peers, the absorbed paths, and the results. A human's edit, or anything else not attributable to a peer apply, still refuses `source_changed`.

## Consequences

- The same-tree rule holds: checks always run on exactly what apply will write.
- The `source_changed` guard is narrowed by design, to peer applies only; it is not removed.
- Each rebased apply costs a check run and an architecture analysis; a batch of n pays that up to n - 1 times.
- Each run keeps its own interrupt at R1 and above: n decisions, not one. A batch decision remains possible later as a different strategy.
- The rebase copy, like the propose tree, has no `node_modules`, so check commands that need installed dependencies cannot run there either.
