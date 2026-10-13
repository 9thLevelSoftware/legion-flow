import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HookConsentSchema, type HookConsent } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

/** Valid hook consent receipts, oldest first. Invalid files are skipped. */
export async function listConsents(paths: LegionFlowPaths): Promise<HookConsent[]> {
  let names: string[];
  try {
    names = await readdir(paths.consentsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: HookConsent[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const parsed = HookConsentSchema.safeParse(JSON.parse(await readFile(join(paths.consentsDir, name), "utf8")));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // unreadable: skipped
    }
  }
  out.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || (a.id < b.id ? -1 : 1));
  return out;
}

export async function recordConsent(paths: LegionFlowPaths, consent: HookConsent, lock: HeldLock): Promise<string> {
  if (!HeldLock.isHeld(lock)) throw new TypeError("recordConsent requires a HeldLock obtained from ProcessLock.acquire()");
  const valid = HookConsentSchema.parse(consent);
  await mkdir(paths.consentsDir, { recursive: true });
  const path = join(paths.consentsDir, `${valid.id}.json`);
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}
