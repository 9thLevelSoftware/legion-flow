import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ReviewReceiptSchema, type ReviewReceipt } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

/** Valid review receipts, oldest first. Invalid files are skipped. */
export async function listReviewReceipts(paths: LegionFlowPaths): Promise<ReviewReceipt[]> {
  let names: string[];
  try {
    names = await readdir(paths.reviewsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ReviewReceipt[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const parsed = ReviewReceiptSchema.safeParse(JSON.parse(await readFile(join(paths.reviewsDir, name), "utf8")));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // unreadable: skipped
    }
  }
  out.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return out;
}

export async function recordReviewReceipt(paths: LegionFlowPaths, receipt: ReviewReceipt, lock: HeldLock): Promise<string> {
  if (!HeldLock.isHeld(lock)) throw new TypeError("recordReviewReceipt requires a HeldLock obtained from ProcessLock.acquire()");
  const valid = ReviewReceiptSchema.parse(receipt);
  await mkdir(paths.reviewsDir, { recursive: true });
  const path = join(paths.reviewsDir, `${valid.id}.json`);
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}
