import type { RiskTier } from "@9thlevelsoftware/legion-flow-schema";
import { GATE_IDS, requiredGates } from "./catalog.js";

export const WAIVER_MIN_REASON = 24;

export type ParsedWaiver = { ok: true; gateId: string; reason: string } | { ok: false; code: string; message: string };

/** `--waive "<gateId>: <reason>"`, split at the first colon. Validated against the catalog and the tier. */
export function parseWaiver(spec: string, tier: RiskTier, options: { architectureRules?: boolean } = {}): ParsedWaiver {
  const colon = spec.indexOf(":");
  if (colon <= 0) {
    return { ok: false, code: "waiver_malformed", message: `--waive "${spec}" must be "<gateId>: <reason>".` };
  }
  const gateId = spec.slice(0, colon).trim();
  const reason = spec.slice(colon + 1).trim();
  if (!GATE_IDS.has(gateId)) {
    return { ok: false, code: "waiver_unknown_gate", message: `--waive names unknown gate '${gateId}'. Known: ${[...GATE_IDS].join(", ")}.` };
  }
  if (!requiredGates(tier, options).includes(gateId)) {
    return { ok: false, code: "waiver_gate_not_required", message: `Gate '${gateId}' is not required at tier ${tier}; nothing to waive.` };
  }
  if (reason.length < WAIVER_MIN_REASON) {
    return { ok: false, code: "waiver_reason_too_short", message: `A waiver reason must be at least ${WAIVER_MIN_REASON} characters (got ${reason.length}).` };
  }
  return { ok: true, gateId, reason };
}
