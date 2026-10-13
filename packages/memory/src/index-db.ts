/**
 * The memory index: `var/index.sqlite`, a derived cache. Everything in it is
 * rebuildable from `project/episodes/` and a fresh map run, so a schema change
 * drops and recreates it rather than migrating. Writes happen under the engine
 * lock held by the caller; reads are safe at any time.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FactRow, MapFacts, MapQueryResult } from "@9thlevelsoftware/legion-flow-schema";
import { loadSqlite } from "./sqlite.js";
import { sortFacts } from "@9thlevelsoftware/legion-flow-map";


/** Bump when the table layout changes; an index at another version is rebuilt. */
export const INDEX_SCHEMA_VERSION = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS map_modules (path TEXT PRIMARY KEY, id TEXT NOT NULL, sha256 TEXT NOT NULL, language TEXT NOT NULL, lsp_language TEXT);
CREATE TABLE IF NOT EXISTS map_symbols (id TEXT PRIMARY KEY, module TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, origin_module TEXT, origin_name TEXT, origin_via TEXT);
CREATE INDEX IF NOT EXISTS map_symbols_name ON map_symbols(name);
CREATE TABLE IF NOT EXISTS map_imports (id TEXT PRIMARY KEY, from_path TEXT NOT NULL, specifier TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL, resolved TEXT, resolved_outside TEXT, package TEXT);
CREATE INDEX IF NOT EXISTS map_imports_from ON map_imports(from_path);
CREATE INDEX IF NOT EXISTS map_imports_resolved ON map_imports(resolved);
CREATE TABLE IF NOT EXISTS map_usages (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, declared_in TEXT NOT NULL, used_by TEXT NOT NULL, via TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS map_usages_symbol ON map_usages(symbol, declared_in);
CREATE TABLE IF NOT EXISTS map_routes (id TEXT PRIMARY KEY, module TEXT NOT NULL, method TEXT NOT NULL, path TEXT, unresolved TEXT, detector TEXT NOT NULL, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, subject_ref TEXT NOT NULL, predicate TEXT NOT NULL, object_ref TEXT, object_text TEXT,
  valid_at TEXT, invalid_at TEXT, created_at TEXT NOT NULL, expired_at TEXT,
  episode_id TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('deterministic','human','llm')),
  confidence REAL, supersedes TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','proposed','rejected','superseded')),
  row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject_ref, predicate);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(subject_ref, object_text, predicate, content='facts', content_rowid='rowid');
CREATE TABLE IF NOT EXISTS map_edges (src TEXT, dst TEXT, kind TEXT, source_sha256 TEXT, extractor_version TEXT);
`;

const MAP_TABLES = ["map_modules", "map_symbols", "map_imports", "map_usages", "map_routes"];
const ALL_TABLES = [...MAP_TABLES, "facts", "fact_fts", "map_edges", "meta"];

export interface MapState {
  snapshotId: string;
  factsSha256: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

export class MemoryIndex {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed) the index at `path`; an index at another schema version is emptied and rebuilt. */
  static async open(path: string): Promise<MemoryIndex> {
    const { DatabaseSync } = await loadSqlite();
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const version = hasMeta ? (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined)?.value : undefined;
    if (hasMeta && version !== String(INDEX_SCHEMA_VERSION)) {
      for (const t of ALL_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    db.exec(DDL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(INDEX_SCHEMA_VERSION));
    return new MemoryIndex(db);
  }

  /**
   * The read path: open read-only, with no DDL and no metadata write, so a query,
   * a status check, or an MCP tool never changes the index. A missing file, or an
   * index at another schema version, is null (the caller reports it absent; only
   * `open`, under the engine lock, rebuilds).
   */
  static async openExisting(path: string): Promise<MemoryIndex | null> {
    if (!existsSync(path)) return null;
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
      const version = hasMeta ? (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined)?.value : undefined;
      if (version !== String(INDEX_SCHEMA_VERSION)) {
        db.close();
        return null;
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new MemoryIndex(db);
  }

  close(): void {
    this.db.close();
  }

  mapState(): MapState | null {
    const get = (key: string) => str((this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value);
    const snapshotId = get("map_snapshot_id");
    const factsSha256 = get("map_facts_sha256");
    return snapshotId && factsSha256 ? { snapshotId, factsSha256 } : null;
  }

  /** Replace every map row in one transaction, then record which snapshot they came from. */
  replaceMap(snapshotId: string, facts: MapFacts, factsSha256: string): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of MAP_TABLES) db.exec(`DELETE FROM ${t}`);
      const m = db.prepare("INSERT INTO map_modules (path, id, sha256, language, lsp_language) VALUES (?, ?, ?, ?, ?)");
      for (const x of facts.modules) m.run(x.path, x.id, x.sha256, x.language, x.lspLanguage ?? null);
      const s = db.prepare("INSERT INTO map_symbols (id, module, name, kind, origin_module, origin_name, origin_via) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const x of facts.symbols) s.run(x.id, x.module, x.name, x.kind, x.origin?.module ?? null, x.origin?.name ?? null, x.origin?.via ?? null);
      const i = db.prepare("INSERT INTO map_imports (id, from_path, specifier, kind, resolution, resolved, resolved_outside, package) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const x of facts.imports) i.run(x.id, x.from, x.specifier, x.kind, x.resolution, x.resolved ?? null, x.resolvedOutside ?? null, x.package ?? null);
      const u = db.prepare("INSERT INTO map_usages (id, symbol, declared_in, used_by, via) VALUES (?, ?, ?, ?, ?)");
      for (const x of facts.usages) u.run(x.id, x.symbol, x.declaredIn, x.usedBy, x.via);
      const rt = db.prepare("INSERT INTO map_routes (id, module, method, path, unresolved, detector, line) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const x of facts.routes) rt.run(x.id, x.module, x.method, x.path ?? null, x.unresolved ?? null, x.detector, x.line);
      const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      meta.run("map_snapshot_id", snapshotId);
      meta.run("map_facts_sha256", factsSha256);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The map rows read back in the extractor's order, so a caller can re-hash them against the snapshot. */
  readMapFacts(): MapFacts {
    const all = (sql: string) => this.db.prepare(sql).all() as Row[];
    return sortFacts({
      modules: all("SELECT * FROM map_modules").map((r) => ({ id: String(r.id), path: String(r.path), sha256: String(r.sha256), language: String(r.language) as MapFacts["modules"][number]["language"], ...(r.lsp_language ? { lspLanguage: String(r.lsp_language) } : {}) })),
      symbols: all("SELECT * FROM map_symbols").map((r) => ({
        id: String(r.id), module: String(r.module), name: String(r.name), kind: String(r.kind) as MapFacts["symbols"][number]["kind"],
        ...(r.origin_module ? { origin: { module: String(r.origin_module), name: String(r.origin_name), via: String(r.origin_via) as MapFacts["usages"][number]["via"] } } : {}),
      })),
      imports: all("SELECT * FROM map_imports").map((r) => ({
        id: String(r.id), from: String(r.from_path), specifier: String(r.specifier), kind: String(r.kind) as MapFacts["imports"][number]["kind"], resolution: String(r.resolution) as MapFacts["imports"][number]["resolution"],
        ...(r.resolved ? { resolved: String(r.resolved) } : {}), ...(r.resolved_outside ? { resolvedOutside: String(r.resolved_outside) } : {}), ...(r.package ? { package: String(r.package) } : {}),
      })),
      usages: all("SELECT * FROM map_usages").map((r) => ({ id: String(r.id), symbol: String(r.symbol), declaredIn: String(r.declared_in), usedBy: String(r.used_by), via: String(r.via) as MapFacts["usages"][number]["via"] })),
      routes: all("SELECT * FROM map_routes").map((r) => ({
        id: String(r.id), module: String(r.module), method: String(r.method) as MapFacts["routes"][number]["method"],
        ...(r.path !== null && r.path !== undefined ? { path: String(r.path) } : { unresolved: String(r.unresolved) }),
        detector: String(r.detector) as MapFacts["routes"][number]["detector"], line: Number(r.line),
      })),
    });
  }

  /** Replace every fact row with a replay of the episodes, and record which replay it is. */
  replaceFacts(rows: readonly FactRow[], rowsSha256: string, lastEpisodeId: string | null): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM facts");
      const ins = db.prepare("INSERT INTO facts (id, subject_ref, predicate, object_ref, object_text, valid_at, invalid_at, created_at, expired_at, episode_id, origin, confidence, supersedes, status, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)");
      for (const r of rows) {
        ins.run(r.id, r.subject, r.predicate, "ref" in r.object ? r.object.ref : null, "text" in r.object ? r.object.text : null, r.validAt, r.invalidAt ?? null, r.createdAt, r.expiredAt ?? null, r.episodeId, r.origin, r.supersedes ? JSON.stringify(r.supersedes) : null, r.status, JSON.stringify(r));
      }
      db.exec("INSERT INTO fact_fts(fact_fts) VALUES ('rebuild')");
      const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      meta.run("facts_sha256", rowsSha256);
      meta.run("facts_last_episode", lastEpisodeId ?? "");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  readFacts(): FactRow[] {
    return (this.db.prepare("SELECT row_json FROM facts ORDER BY id").all() as Row[]).map((r) => JSON.parse(String(r.row_json)) as FactRow);
  }

  factsState(): { factsSha256: string; lastEpisodeId: string } | null {
    const get = (key: string) => str((this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value);
    const sha = get("facts_sha256");
    return sha === undefined ? null : { factsSha256: sha, lastEpisodeId: get("facts_last_episode") ?? "" };
  }

  /** BM25 over fact text and predicate (FTS5), for recall. */
  /** BM25 over subject, object text, and predicate (FTS5); ids in rank order, ties broken by id. */
  searchFacts(query: string, limit = 200): string[] {
    // Split on anything that is not a letter, digit, or underscore, so "topic:payments" searches "topic" and "payments".
    const terms = [...new Set(query.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0))].map((t) => `"${t}"`);
    if (terms.length === 0) return [];
    return (this.db.prepare("SELECT facts.id AS id FROM fact_fts JOIN facts ON facts.rowid = fact_fts.rowid WHERE fact_fts MATCH ? ORDER BY bm25(fact_fts), facts.id LIMIT ?").all(terms.join(" OR "), limit) as Row[]).map((r) => String(r.id));
  }

  hasModule(path: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM map_modules WHERE path = ?").get(path));
  }

  /** What `path` depends on, breadth-first, with the distance of each module; direct external packages alongside. */
  deps(path: string, maxDepth = 32): Pick<MapQueryResult, "modules" | "external"> {
    const step = this.db.prepare("SELECT resolved, resolution FROM map_imports WHERE from_path = ? AND resolved IS NOT NULL ORDER BY resolved");
    const external = (this.db.prepare("SELECT DISTINCT package FROM map_imports WHERE from_path = ? AND resolution = 'external' AND package IS NOT NULL ORDER BY package").all(path) as Row[]).map((r) => String(r.package));
    return { modules: this.walk(path, maxDepth, (p) => (step.all(p) as Row[]).map((r) => ({ path: String(r.resolved), via: String(r.resolution) }))), external };
  }

  /** What depends on `path`, transitively. */
  impact(path: string, maxDepth = 32): Pick<MapQueryResult, "modules"> {
    const step = this.db.prepare("SELECT from_path, resolution FROM map_imports WHERE resolved = ? ORDER BY from_path");
    return { modules: this.walk(path, maxDepth, (p) => (step.all(p) as Row[]).map((r) => ({ path: String(r.from_path), via: String(r.resolution) }))) };
  }

  /**
   * Who uses a symbol. `path#name` is exact; a bare name declared in exactly one
   * module is answered, and a bare name declared in several returns the
   * candidates, never a guess.
   */
  whoUses(target: string): Pick<MapQueryResult, "usedBy" | "candidates"> {
    const hash = target.lastIndexOf("#");
    const usersOf = (module: string, name: string) => (this.db.prepare("SELECT DISTINCT used_by FROM map_usages WHERE declared_in = ? AND symbol = ? ORDER BY used_by").all(module, name) as Row[]).map((r) => String(r.used_by));
    if (hash > 0) return { usedBy: usersOf(target.slice(0, hash), target.slice(hash + 1)), candidates: [] };
    const declared = new Set<string>();
    for (const r of this.db.prepare("SELECT DISTINCT module FROM map_symbols WHERE name = ? AND kind NOT IN ('reexport', 'reexport_all')").all(target) as Row[]) declared.add(String(r.module));
    for (const r of this.db.prepare("SELECT DISTINCT declared_in FROM map_usages WHERE symbol = ?").all(target) as Row[]) declared.add(String(r.declared_in));
    const modules = [...declared].sort();
    if (modules.length === 1) return { usedBy: usersOf(modules[0]!, target), candidates: [] };
    return { usedBy: [], candidates: modules.map((m) => `${m}#${target}`) };
  }

  /**
   * Route facts (M4 slice g). `*` is every route; a target starting with `/` is a URL
   * path prefix; anything else is a module path or directory prefix.
   */
  routes(target: string): Pick<MapQueryResult, "routes"> {
    const all = this.readMapFacts().routes;
    if (target === "*") return { routes: all };
    if (target.startsWith("/")) return { routes: all.filter((r) => r.path !== undefined && r.path.startsWith(target)) };
    const dir = target.replace(/\/+$/, "");
    return { routes: all.filter((r) => r.module === dir || r.module.startsWith(dir + "/")) };
  }

  private walk(start: string, maxDepth: number, next: (path: string) => { path: string; via: string }[]): MapQueryResult["modules"] {
    const seen = new Map<string, { depth: number; via: string }>([[start, { depth: 0, via: "compiler" }]]);
    let frontier = [start];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const p of frontier) {
        for (const edge of next(p)) {
          if (seen.has(edge.path)) continue;
          seen.set(edge.path, { depth, via: edge.via });
          nextFrontier.push(edge.path);
        }
      }
      frontier = nextFrontier;
    }
    seen.delete(start);
    return [...seen.entries()]
      .map(([path, v]) => ({ path, depth: v.depth, via: v.via as MapQueryResult["modules"][number]["via"] }))
      .sort((a, b) => a.depth - b.depth || cmp(a.path, b.path));
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

