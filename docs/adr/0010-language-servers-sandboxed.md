# ADR-0010: Language servers run in their own hardened container, through an in-package client

**Status:** accepted (M4 slice a3, 2026-10-09) · **Date:** 2026-10-09

## Context

The code map covers TypeScript and JavaScript with the compiler's own parser. Other languages need their own tooling, and the Language Server Protocol is the one interface every major language already ships. Two things make a language server unlike a parser: some servers execute project code while indexing (rust-analyzer runs build scripts and procedural macros; gopls runs `go list`), and the usual clients are `vscode-jsonrpc` and `vscode-languageserver`, which this project would take as runtime dependencies.

## Decision

Servers run in the `vm-docker` tier by default: `docker run -i` with the same hardening set as an agent run, no network, the tree mounted read-only at `/work`, and an image the operator names per server. Running a server on the host needs `--sandbox unhardened --allow-no-sandbox` on a terminal, as `execute` does. The client is written in the `lsp` package over the base protocol, depending on `schema` only, and `cli` composes it with a sandbox session, so `gates` and `memory` never load protocol code.

## Consequences

- A project with servers configured must provide an image per server, or accept the host escape on a terminal; `map` refuses before anything starts otherwise, and `doctor` says which.
- The read-only tree and no-network container limit what a server can do: one that writes caches beside the source, or fetches dependencies, gets less, by design.
- The client is small and owned here: about 400 lines across the client and the JSON-RPC connection, tested against a deterministic fake server on every gate and against rust-analyzer where it is installed.
- ~~A server version change with the same configuration is not detected.~~ Reversed in M4 slice (g): before reusing a language, the runner starts its server for `initialize` alone and compares `serverInfo` name and version with the snapshot's; a different or missing version runs the language again. That is one server start per refresh for each unchanged language. `map --rebuild` still reruns every server.
- `map` holds the engine lock for the whole server run, which can be tens of seconds cold, so other commands refuse with `engine_lock_held` meanwhile.
