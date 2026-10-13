# ADR-0012: Ship bundles are plain directories with a canonical manifest, signed as DSSE over an in-toto statement

**Status:** accepted (M4 slice h, 2026-10-10) · **Date:** 2026-10-10

## Context

`ship --bundle` and `--sign` were in the report's verb table from the start, and proposal P3 asked for a verifier that needs no Legion state. Three things had to be decided together: the container (an archive or a directory), what a signature covers, and the signature's format. The sibling legion-cli already ships a working answer (a directory, a canonical manifest, Ed25519 through `node:crypto`, a DSSE envelope over an in-toto Statement v1), and a reviewer who reads both tools gains from one shape.

## Decision

A bundle is a plain directory: the files one ship evaluation rested on, at their `.legion-flow/project/`-relative paths, plus `manifest.json` (`legion-flow-bundle/v1`: run, release, readiness, tier, fingerprints, required gates, and every member's path, size, and sha256, sorted by path), whose bytes are its canonical JSON with no trailing newline. It is staged beside the destination and renamed into place, and never written inside `.legion-flow/` or inside the workspace tree unless git ignores the spot. A signature is `signature.dsse.json`: one Ed25519 signature, made with `node:crypto`, over the DSSE pre-authentication encoding of a canonical in-toto Statement v1 whose single subject is `manifest.json` by sha256 and whose predicate (`https://9thlevelsoftware.dev/legion-flow/bundle/v1`) names the run, the release, readiness, the signer, and the time. The key id is the sha256 of the SPKI DER public key. Signing keys are PKCS8 PEM files outside the workspace; a verifier's public key always comes from outside the bundle. This closes ADR-0006 on `node:crypto` Ed25519.

## Consequences

- No archive dependency and no archive parser in the verifier; an operator who wants one file zips the directory, and the verifier works on the unzipped tree.
- The signed payload is a published format other tools can parse, and the same as the sibling's apart from the predicate type.
- A signature authenticates bytes, not truth: it says who vouched for this manifest, not that the gates were right.
- The bundle's copy of the audit chain ends before the `bundle_written` and `bundle_signed` events that record making it, so the act of bundling is verifiable only from the originating project.
- Gate verdicts cite the audit chain at its evaluation-time hash, which the grown chain no longer matches; the verifier replays the whole bundled chain instead and accepts that citation without its hash.

## Rejected

- A tar or zip container: needs a dependency or a hand-written parser that the verifier would then have to trust.
- A home-grown `{keyId, sig}` over the manifest hash: smaller, but a format no other tool reads.
- `@noble/ed25519`: unnecessary on Node 22 and later, where `node:crypto` signs and verifies Ed25519.
