import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalSchema, type Approval, type ApprovalSubject } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

export interface ApprovalListing {
  valid: Approval[];
  /** Receipts that exist but do not parse; reported, never silently skipped. */
  invalid: { path: string; detail: string }[];
}

export async function listApprovals(paths: LegionFlowPaths): Promise<ApprovalListing> {
  let names: string[];
  try {
    names = await readdir(paths.approvalsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: [], invalid: [] };
    }
    throw err;
  }

  const listing: ApprovalListing = { valid: [], invalid: [] };
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(paths.approvalsDir, name);
    try {
      const parsed = ApprovalSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (parsed.success) {
        listing.valid.push(parsed.data);
      } else {
        listing.invalid.push({ path, detail: parsed.error.issues.map((i) => i.message).join("; ") });
      }
    } catch (err: unknown) {
      listing.invalid.push({ path, detail: (err as Error).message });
    }
  }
  listing.valid.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return listing;
}

/** All valid receipts for one subject, oldest first. */
export async function findApprovals(
  paths: LegionFlowPaths,
  subject: ApprovalSubject,
  subjectId: string
): Promise<Approval[]> {
  const { valid } = await listApprovals(paths);
  // Newest first: two receipts can match one fingerprint when only a browser script's hash changed (M4 slice e),
  // and the later approval is the one in force.
  return valid
    .filter((r) => r.subject === subject && r.subjectId === subjectId)
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : a.id < b.id ? 1 : -1));
}

/** Write a receipt once. The receipt is validated before it touches disk. */
export async function recordApproval(paths: LegionFlowPaths, receipt: Approval, lock: HeldLock): Promise<string> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("recordApproval requires a HeldLock obtained from ProcessLock.acquire()");
  }
  const valid = ApprovalSchema.parse(receipt);
  await mkdir(paths.approvalsDir, { recursive: true });
  const path = join(paths.approvalsDir, `${valid.id}.json`);
  await atomicWriteFile(path, JSON.stringify(valid, null, 2) + "\n");
  return path;
}
