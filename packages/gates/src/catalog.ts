
/**
 * The gate catalog. Every gate has an id, a human title, and the milestone that
 * can produce evidence for it. A gate required by the tier but not producible
 * yet reports `unevaluable`: absence of evidence blocks, by design.
 */
export interface GateDefinition {
  id: string;
  title: string;
  /** The milestone whose code can evaluate this gate. */
  evaluableFrom: "M1" | "M3" | "M4";
}

export const GATE_CATALOG: readonly GateDefinition[] = [
  { id: "approved_spec", title: "A decision owner approved the current spec at its current fingerprint", evaluableFrom: "M1" },
  { id: "approved_plan", title: "A decision owner approved the current plan against the frozen spec", evaluableFrom: "M1" },
  { id: "deterministic_verification", title: "Every task check and every receipt check exits 0, run without a shell", evaluableFrom: "M1" },
  { id: "acceptance_coverage", title: "Every acceptance criterion is covered by at least one task", evaluableFrom: "M1" },
  { id: "audit_chain_intact", title: "The audit chain replays and matches its index", evaluableFrom: "M1" },
  { id: "independent_review", title: "An independent reviewer run passed and a decision owner accepted it", evaluableFrom: "M3" },
  { id: "eval_goldens", title: "Golden evaluations pass per metric with a judge distinct from the executor", evaluableFrom: "M3" },
  { id: "architecture_conformance", title: "The code map at the checkout breaks none of the project's architecture rules", evaluableFrom: "M4" },
];

export const GATE_IDS = new Set(GATE_CATALOG.map((g) => g.id));

/** The tier table lives in schema so phase derivation and evaluation read one table. */
export { TIER_GATES, requiredGates, ARCHITECTURE_GATE } from "@9thlevelsoftware/legion-flow-schema";
