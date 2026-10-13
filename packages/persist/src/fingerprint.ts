import { createHash } from "node:crypto";
import type { ProjectConfig } from "@9thlevelsoftware/legion-flow-schema";

/**
 * Canonical JSON: keys sorted recursively, no whitespace, undefined members
 * omitted (as JSON.stringify does). Two records that differ only in key order
 * or formatting produce the same bytes, so the same fingerprint.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item === undefined ? null : item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Fingerprint of a record by its canonical JSON. */
export function fingerprintRecord(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalJson(value));
}

/** Fingerprint of raw bytes (prose, source files). */
export function fingerprintBytes(data: string | Buffer): string {
  return "sha256:" + sha256Hex(data);
}

/** One fingerprint over several, order-sensitive. */
export function combineFingerprints(...fingerprints: string[]): string {
  return "sha256:" + sha256Hex(fingerprints.join("\n"));
}

/**
 * The config fingerprint approvals bind to. The `current` pointer is the one
 * mutable part of the record and is excluded, so pointing at a new plan never
 * invalidates a spec approval.
 */
export function configFingerprint(config: ProjectConfig): string {
  const { current: _current, ...bound } = config;
  return fingerprintRecord(bound);
}
