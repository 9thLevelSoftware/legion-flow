import { readFile, readdir, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { GoldenDatasetSchema, SCHEMA_VERSIONS, type GoldenDataset } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { fingerprintRecord } from "./fingerprint.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

export type LoadedDatasetVersion =
  | { kind: "valid"; version: number; path: string; dataset: GoldenDataset; fingerprint: string }
  | { kind: "invalid"; version: number; path: string; detail: string };

export interface DatasetListing {
  id: string;
  /** Ascending by version. */
  versions: LoadedDatasetVersion[];
}

const VERSION_FILE = /^v([1-9][0-9]*)\.json$/;

/** Every dataset under project/evals/<id>/v<N>.json, versions parsed; a file whose version field disagrees with its name is invalid. */
export async function listDatasets(paths: LegionFlowPaths): Promise<DatasetListing[]> {
  let ids: string[];
  try {
    ids = await readdir(paths.evalsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DatasetListing[] = [];
  for (const id of ids.sort()) {
    let names: string[];
    try {
      names = await readdir(join(paths.evalsDir, id));
    } catch {
      continue;
    }
    const versions: LoadedDatasetVersion[] = [];
    for (const name of names) {
      const m = VERSION_FILE.exec(name);
      if (!m) continue;
      const version = Number(m[1]);
      const path = join(paths.evalsDir, id, name);
      try {
        const parsed = GoldenDatasetSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (!parsed.success) {
          versions.push({ kind: "invalid", version, path, detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        } else if (parsed.data.version !== version || parsed.data.id !== id) {
          versions.push({ kind: "invalid", version, path, detail: `file v${version}.json under ${id}/ declares id '${parsed.data.id}' version ${parsed.data.version}` });
        } else {
          versions.push({ kind: "valid", version, path, dataset: parsed.data, fingerprint: fingerprintRecord(parsed.data) });
        }
      } catch (err: unknown) {
        versions.push({ kind: "invalid", version, path, detail: `unreadable: ${(err as Error).message}` });
      }
    }
    versions.sort((a, b) => a.version - b.version);
    out.push({ id, versions });
  }
  return out;
}

/** Scaffold v1 of a new dataset. Refuses to overwrite. */
export async function createDataset(paths: LegionFlowPaths, id: string, lock: HeldLock): Promise<{ kind: "created"; path: string } | { kind: "exists"; path: string }> {
  if (!HeldLock.isHeld(lock)) throw new TypeError("createDataset requires a HeldLock obtained from ProcessLock.acquire()");
  const dir = join(paths.evalsDir, id);
  const path = join(dir, "v1.json");
  try {
    await access(dir);
    return { kind: "exists", path };
  } catch {
    // new
  }
  const dataset = GoldenDatasetSchema.parse({
    schema: SCHEMA_VERSIONS.GOLDEN_DATASET,
    id,
    version: 1,
    description: "Edit the cases, then run legion-flow eval --dataset " + id + ". The first run freezes this version.",
    cases: [
      {
        id: "example",
        acceptanceIds: [],
        argv: "node -e \"console.log('hello')\"",
        expected: { stdout: "hello", exitCode: 0 },
        metrics: [
          { metric: "output_matches", scorer: "exact", threshold: 1 },
          { metric: "exits_cleanly", scorer: "exit_code", threshold: 1 },
        ],
      },
    ],
  });
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(path, JSON.stringify(dataset, null, 2) + "\n");
  return { kind: "created", path };
}
