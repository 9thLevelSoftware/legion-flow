import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SpecSchema, SCHEMA_VERSIONS, type Spec } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile } from "./atomic-write.js";
import { combineFingerprints, fingerprintBytes, fingerprintRecord } from "./fingerprint.js";
import { newId } from "./ids.js";
import { HeldLock } from "./lock.js";
import type { LegionFlowPaths } from "./layout.js";

export type SpecInvalidCause = "unreadable" | "malformed_json" | "schema";

export type LoadSpecResult =
  | { kind: "absent"; id: string; dir: string }
  | { kind: "invalid"; id: string; dir: string; cause: SpecInvalidCause; detail: string }
  | { kind: "valid"; id: string; dir: string; spec: Spec; markdown: string; fingerprint: string };

export interface CreatedSpec {
  spec: Spec;
  dir: string;
  fingerprint: string;
}

export function specDir(paths: LegionFlowPaths, id: string): string {
  return join(paths.specsDir, id);
}

/**
 * One fingerprint over both halves: the parsed record's canonical JSON (so
 * reformatting spec.json changes nothing) and the raw bytes of SPEC.md (prose
 * is bytes). Editing either half changes it, and a matching approval stops matching.
 */
export function specFingerprint(spec: Spec, markdown: string | Buffer): string {
  return combineFingerprints(fingerprintRecord(spec), fingerprintBytes(markdown));
}

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
}

export async function loadSpec(paths: LegionFlowPaths, id: string): Promise<LoadSpecResult> {
  const dir = specDir(paths, id);
  const jsonPath = join(dir, "spec.json");
  const mdPath = join(dir, "SPEC.md");

  let rawJson: string;
  try {
    rawJson = await readFile(jsonPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", id, dir };
    }
    return { kind: "invalid", id, dir, cause: "unreadable", detail: (err as Error).message };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawJson);
  } catch (err: unknown) {
    return { kind: "invalid", id, dir, cause: "malformed_json", detail: (err as Error).message };
  }

  const parsed = SpecSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", id, dir, cause: "schema", detail: formatIssues(parsed.error.issues) };
  }
  if (parsed.data.id !== id) {
    return { kind: "invalid", id, dir, cause: "schema", detail: `id: record says ${parsed.data.id}, directory says ${id}` };
  }

  let markdown: Buffer;
  try {
    markdown = await readFile(mdPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      markdown = Buffer.alloc(0);
    } else {
      return { kind: "invalid", id, dir, cause: "unreadable", detail: (err as Error).message };
    }
  }

  return {
    kind: "valid",
    id,
    dir,
    spec: parsed.data,
    markdown: markdown.toString("utf8"),
    fingerprint: specFingerprint(parsed.data, markdown),
  };
}

/** The scaffold's placeholder intent: still present means nobody wrote one (M4 slice j3's lint reads it). */
export const SPEC_SCAFFOLD_INTENT = "What this change is for, in a paragraph a reviewer can hold in their head.";

function specMarkdownTemplate(spec: Spec): string {
  return [
    `# ${spec.title}`,
    "",
    `Specification \`${spec.id}\`. This file is the prose half; \`spec.json\` beside it is the typed half.`,
    "Both are fingerprinted together: editing either after approval invalidates the approval.",
    "",
    "## Intent",
    "",
    SPEC_SCAFFOLD_INTENT,
    "",
    "## Acceptance criteria",
    "",
    "Add each criterion to `acceptanceCriteria` in `spec.json` as",
    '`{ "id": "AC-01", "statement": "...", "kind": "behavior" | "test" | "rubric", "surface": "unit" | "integration" | "real_interface" | "end_to_end", "priority": "P0" | "P1" | "P2" }`,',
    "then describe it here in words. `approve spec` refuses a spec with no criteria.",
    "",
    "## Out of scope",
    "",
    "What this spec deliberately does not cover.",
    "",
  ].join("\n");
}

/** Create a draft spec directory under the engine lock. Refuses nothing itself; the caller decides whether a current spec may be replaced. */
export async function createSpec(paths: LegionFlowPaths, title: string, lock: HeldLock): Promise<CreatedSpec> {
  if (!HeldLock.isHeld(lock)) {
    throw new TypeError("createSpec requires a HeldLock obtained from ProcessLock.acquire()");
  }
  const spec = SpecSchema.parse({
    schema: SCHEMA_VERSIONS.SPEC,
    id: newId("spc"),
    title,
    createdAt: new Date().toISOString(),
  });
  const dir = specDir(paths, spec.id);
  await mkdir(dir, { recursive: true });
  const markdown = specMarkdownTemplate(spec);
  await atomicWriteFile(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  await atomicWriteFile(join(dir, "SPEC.md"), markdown);
  return { spec, dir, fingerprint: specFingerprint(spec, markdown) };
}
