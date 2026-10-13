# ADR-0007: Repair the audit chain by baseline, never by rewriting

**Status:** accepted · **Date:** 2026-10-09

## Context

`audit/events.jsonl` is hash-chained: each line carries its sequence number and the digest of the line before it, and `chain.json` indexes the committed tail. The research names a recorded rebaseline as the only repair. The first implementation only appended an event, which cannot make verification pass: a tampered or missing middle line breaks every later line's embedded previous digest, and rewriting `chain.json` changes nothing about that. Rewriting the lines themselves would be the history edit the chain exists to prevent.

## Decision

A rebaseline keeps every parseable line as an archived region pinned by the SHA-256 of its bytes, moves the first unparseable line and everything after it to `audit/events.quarantined-<ts>.jsonl`, archives the replaced index as `audit/chain.before-<ts>.json`, and appends one `audit_rebaselined` event whose sequence is `kept + 1` and whose previous digest is the region hash. `chain.json` gains `baseline { seq, byteOffset, priorBytesSha256, at, reason, operator }`, which every later append carries forward. Verification hashes the region, compares, and replays from the baseline. The repair is human-only (`doctor --rebaseline-audit --reason --approver` on a terminal), refused when the chain verifies clean, and written by one direct append because the normal append refuses exactly the state being repaired.

## Consequences

- Verification passes after a rebaseline and fails again the moment the archived region changes. History is never rewritten; the baseline is itself history.
- Inside the archived region the embedded sequence numbers and digests are void. The event records the prior verification error, the counts, and the operator, so a reader knows the region is pinned, not vouched for.
- `chain.json` written after a rebaseline carries a field older code did not know. Nothing but this code reads it.
- Rejected alternative: recompute and rewrite each line's digest. It would make the log consistent and erase the evidence that it had ever been inconsistent.

## Spike

None pending. Covered by tests for an edited middle line, a truncated log, appended garbage, and a corrupt `chain.json`.
