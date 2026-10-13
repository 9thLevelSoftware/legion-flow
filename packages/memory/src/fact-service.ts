/**
 * The fact service: replay every episode into the index facts tables (under
 * the engine lock), and read facts back. The replay is the truth; the index is
 * accepted only when its rows hash to a fresh replay.
 */
import type { Episode, FactRow } from "@9thlevelsoftware/legion-flow-schema";
import type { HeldLock, Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { MemoryIndex } from "./index-db.js";
import { factRowsSha256, replayFacts } from "./facts.js";

export async function validEpisodes(ws: Workspace): Promise<Episode[]> {
  return (await ws.episodes.list()).flatMap((e) => (e.kind === "valid" ? [e.episode] : []));
}

/** Replay and write the facts tables; returns the rows. The caller holds the engine lock. */
export async function syncFacts(ws: Workspace, held: HeldLock): Promise<FactRow[]> {
  void held;
  const episodes = await validEpisodes(ws);
  const rows = replayFacts(episodes);
  const sha = factRowsSha256(rows);
  const index = await MemoryIndex.open(ws.paths.indexSqlite);
  try {
    const state = index.factsState();
    if (!state || state.factsSha256 !== sha) index.replaceFacts(rows, sha, episodes.length ? episodes[episodes.length - 1]!.id : null);
    const back = factRowsSha256(index.readFacts());
    if (back !== sha) throw new Error(`facts_index_mismatch: the index read back as ${back}, the replay says ${sha}`);
  } finally {
    index.close();
  }
  return rows;
}

/** Facts for reading: the index when it matches a fresh replay, else the replay itself (never writes). */
export async function currentFacts(ws: Workspace): Promise<{ rows: FactRow[]; indexed: boolean }> {
  const rows = replayFacts(await validEpisodes(ws));
  const sha = factRowsSha256(rows);
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  try {
    return { rows, indexed: index?.factsState()?.factsSha256 === sha };
  } finally {
    index?.close();
  }
}
