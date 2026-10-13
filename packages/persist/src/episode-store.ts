import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EpisodeSchema, type Episode } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import { newId } from "./ids.js";
import type { LegionFlowPaths } from "./layout.js";

/** Omit over each member of a union, so a draft keeps its kind's own fields. */
export type EpisodeDraft = Episode extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;

export type LoadedEpisode = { kind: "valid"; path: string; episode: Episode } | { kind: "invalid"; path: string; detail: string };

/** Every episode under project/episodes/, oldest first (ids sort by time). */
export async function listEpisodes(paths: LegionFlowPaths): Promise<LoadedEpisode[]> {
  let names: string[];
  try {
    names = await readdir(paths.episodesDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LoadedEpisode[] = [];
  for (const name of names.filter((n) => /^ep_[0-9a-z]+\.json$/.test(n)).sort()) {
    const path = join(paths.episodesDir, name);
    try {
      const parsed = EpisodeSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (!parsed.success) out.push({ kind: "invalid", path, detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      else if (`${parsed.data.id}.json` !== name) out.push({ kind: "invalid", path, detail: `file ${name} declares id ${parsed.data.id}` });
      else out.push({ kind: "valid", path, episode: parsed.data });
    } catch (err: unknown) {
      out.push({ kind: "invalid", path, detail: `unreadable: ${(err as Error).message}` });
    }
  }
  return out;
}

/** Record an episode; the id is minted here and a file is never overwritten. */
export async function recordEpisode(paths: LegionFlowPaths, draft: EpisodeDraft, lock: HeldLock): Promise<{ episode: Episode; path: string }> {
  if (!HeldLock.isHeld(lock)) throw new TypeError("recordEpisode requires a HeldLock obtained from ProcessLock.acquire()");
  const episode = EpisodeSchema.parse({ ...draft, id: newId("ep") });
  await mkdir(paths.episodesDir, { recursive: true });
  const path = join(paths.episodesDir, `${episode.id}.json`);
  await atomicWriteFile(path, JSON.stringify(episode, null, 2) + "\n");
  return { episode, path };
}
