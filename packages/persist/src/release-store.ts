import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseSchema, type Release } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

/** Valid releases, oldest first. Invalid files are skipped here and surfaced by doctor in a later slice. */
export async function listReleases(paths: LegionFlowPaths): Promise<Release[]> {
  let names: string[];
  try {
    names = await readdir(paths.releasesDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const releases: Release[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const parsed = ReleaseSchema.safeParse(JSON.parse(await readFile(join(paths.releasesDir, name), "utf8")));
      if (parsed.success) releases.push(parsed.data);
    } catch {
      // unreadable: skipped
    }
  }
  releases.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return releases;
}

export async function recordRelease(paths: LegionFlowPaths, release: Release, lock: HeldLock): Promise<string> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("recordRelease requires a HeldLock obtained from ProcessLock.acquire()");
  }
  const valid = ReleaseSchema.parse(release);
  await mkdir(paths.releasesDir, { recursive: true });
  const path = join(paths.releasesDir, `${valid.id}.json`);
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}
