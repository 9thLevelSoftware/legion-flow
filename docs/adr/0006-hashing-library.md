# ADR-0006: Hashing with `node:crypto`, not `@noble/hashes`

**Status:** accepted (closed by ADR-0012 in M4 slice h, 2026-10-10: signing uses `node:crypto` Ed25519) · **Date:** 2026-10-08

## Context

The main report lists `@noble/hashes` for SHA-256 because legion-cli's persist package uses it alongside `@noble/ed25519` for signing. The repository today hashes the audit chain with `node:crypto` `createHash("sha256")` in `packages/persist/src/audit.ts`, which is built in, needs no dependency, and is what the M0 tests exercise. The research notes record no version or license for the noble packages. Signing (`ship --sign`) is a separate operator action planned for M3 or later; the family rule is that a signature authenticates bytes, not truth.

## Decision

Use `node:crypto` for all SHA-256 hashing (audit chain, artifact pins, fingerprints, idempotency keys). Revisit only when signing is implemented; at that point choose between `node:crypto` Ed25519 (available in Node 22) and `@noble/ed25519`, and keep hashing on `node:crypto` either way.

## Consequences

- Zero dependencies for integrity today.
- Hash outputs are byte-identical to legion-cli's for the same input, so cross-tool verification of a chain is possible.
- If a browser-side verifier (proposal P3) is ever built, `node:crypto` is unavailable there and a Web Crypto path would be needed; SHA-256 is identical across both.

## Spike

None. Closed: `ship --sign` (M4 slice h) signs with `node:crypto` Ed25519 and takes no dependency (ADR-0012).
