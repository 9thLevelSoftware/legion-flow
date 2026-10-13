import { randomBytes } from "node:crypto";

/**
 * A typed id: prefix, base36 timestamp, eight random base36 characters so two ids in one millisecond differ. Four
 * characters (about 1.7 million values) collided among 50 ids in one millisecond in a gate run; eight is about 2.8e12.
 */
export function newId(prefix: "spc" | "apv" | "pln" | "run" | "int" | "rel" | "rvw" | "ep" | "fct" | "bcs" | "hkc"): string {
  const random = (randomBytes(6).readUIntBE(0, 6) % 36 ** 8).toString(36).padStart(8, "0");
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
