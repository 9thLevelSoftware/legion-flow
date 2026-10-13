/**
 * The one way `node:sqlite` is loaded. On Node 22.x the module still prints
 * "ExperimentalWarning: SQLite is an experimental feature" when it is first
 * loaded (Node 24 does not). That single warning is dropped here, for this one
 * import, and every other warning passes through untouched (ADR-0003).
 */
type SqliteModule = typeof import("node:sqlite");

let loaded: Promise<SqliteModule> | null = null;

export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeOrOptions && typeof typeOrOptions === "object" && "type" in typeOrOptions
        ? String((typeOrOptions as { type: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : "";
  return type === "ExperimentalWarning" && message.startsWith("SQLite");
}

export function loadSqlite(): Promise<SqliteModule> {
  if (loaded) return loaded;
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  loaded = import("node:sqlite").finally(() => {
    if (process.emitWarning === (filtered as typeof process.emitWarning)) process.emitWarning = original;
  });
  return loaded;
}

/** For doctor: can the driver open a database and build an FTS5 table? */
export async function sqliteHealth(): Promise<{ ok: true; sqliteVersion: string } | { ok: false; reason: string }> {
  try {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(body); INSERT INTO probe(body) VALUES ('legion flow');");
      const hit = db.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH 'flow'").get() as { n: number };
      if (Number(hit.n) !== 1) return { ok: false, reason: "FTS5 returned no match for a known row" };
      const v = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      return { ok: true, sqliteVersion: String(v.v) };
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    return { ok: false, reason: (err as Error).message };
  }
}
