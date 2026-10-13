# ADR-0003: SQLite driver for `var/index.sqlite`

**Status:** accepted (M4 slice a1, 2026-10-09) · **Date:** 2026-10-08

## Context

The memory and map packages (M4) need SQLite with FTS5 for the bi-temporal `facts` table and `fact_fts` virtual table. The main report assumes `better-sqlite3` because legion-cli already uses it, and the research notes record that `node:sqlite` "was not researched". `better-sqlite3` is a native module that needs prebuilt binaries or a build toolchain at install time, which is a real cost on a Windows-primary host. `node:sqlite` is built into Node, was unflagged in 22.13.0 (the repository's floor), and during preparation of the architecture document it loaded with no experimental warning on Node 24.19.0 and created an FTS5 virtual table successfully.

## Decision

Accepted: `node:sqlite`, with `better-sqlite3` as the named fallback if the API changes under us. The spike's third step said to fall back on any experimental warning on 22.x, and 22.x does warn. The project overrode that step on purpose. The warning is the Node project's stability label, not a failure; the index is a rebuildable cache, so a later driver switch loses nothing; and a native module is a real install cost on a Windows-primary host. The one warning is dropped at the single import site (`packages/memory/src/sqlite.ts`), matched by type `ExperimentalWarning` and a message starting with "SQLite", in both `emitWarning` shapes, and every other warning passes through.

## Consequences

- Zero native dependencies in the default install if `node:sqlite` is chosen; `pnpm install` never compiles anything.
- The derived-cache rule is unchanged either way: `index.sqlite` is rebuildable from `project/episodes/` and the map, so a driver change never loses state.
- `sqlite-vec` (used optionally by legion-cli) may not load as an extension under `node:sqlite`; an embedding column is optional in the design, so this is acceptable until measured.

## Spike results (2026-10-09, Windows 11)

| Node | facts, fact_fts (FTS5), map_edges, 10,000 rows, as-of and BM25 queries | stderr |
|---|---|---|
| 24.19.0 (SQLite 3.53.3) | pass, 35 ms | nothing |
| 22.23.2 (SQLite 3.51.3) | pass, 46 ms | `ExperimentalWarning: SQLite is an experimental feature`, then nothing once the filter is in place (a child-process test asserts empty stderr; it was run on 22.23.2 by hand, and on 24 it passes either way) |

Node 22.13.0 exactly was not run; no copy is installed, and the warning behaviour is the same across the 22.x line. Linux native was not run.

## Spike as planned

1. On Node 22.13.0 exactly (CI), load `node:sqlite`, create the `facts`, `fact_fts` (FTS5), and `map_edges` tables from section 7 of the architecture document, insert 10,000 rows, and run the as-of query and an FTS5 BM25 query. Record any warning on stderr.
2. Repeat on Windows native and Linux native.
3. If any step fails or emits an experimental warning on 22.x, fall back to `better-sqlite3` and record the reason here.
