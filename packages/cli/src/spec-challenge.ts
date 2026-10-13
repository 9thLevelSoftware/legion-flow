/**
 * `spec --challenge` (M4 slice j3): questions about a draft spec before a human
 * approves it. Five deterministic lint rules always run; a challenge agent may
 * add up to three concerns. A decision owner resolves each concern on a
 * terminal. Legion never rewrites the spec; any edit makes the round stale.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSIONS, SpecChallengeSchema, type ChallengeConcern, type ChallengeRound, type Spec, type SpecChallenge } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, SPEC_SCAFFOLD_INTENT, type HeldLock } from "@9thlevelsoftware/legion-flow-persist";
import { normalizeStatementText } from "@9thlevelsoftware/legion-flow-memory";

/** Words that promise a quality without saying how anyone would see it. English and fixed. */
export const UNMEASURABLE_WORDS: readonly string[] = ["fast", "quick", "quickly", "secure", "easy", "simple", "intuitive", "robust", "scalable", "user-friendly", "efficient", "seamless", "seamlessly"];
/** Verbs that name something observable; with one of them (or a number) the statement is checkable. */
export const OBSERVABLE_VERBS: readonly string[] = ["returns", "shows", "exits", "writes", "refuses", "logs", "rejects", "displays", "responds", "creates", "deletes", "emits", "prints"];
/** Wording that describes a failure or an edge case. */
export const FAILURE_WORDS: readonly string[] = ["fail", "fails", "failure", "error", "errors", "invalid", "missing", "refuse", "refuses", "reject", "rejects", "timeout", "times out", "empty", "denied", "unavailable", "malformed", "edge case", "cannot", "never"];

type LintConcern = Omit<ChallengeConcern, "id">;
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
const hasPhrase = (s: string, phrase: string) => (phrase.includes(" ") ? s.toLowerCase().includes(phrase) : words(s).includes(phrase));

/**
 * The five rules, in this order, each naming the criterion it is about:
 * a P0 criterion of kind rubric (a must-have only opinion can decide); an
 * unmeasurable criterion; no criterion that describes a failure or an edge case;
 * two criteria saying the same thing; SPEC.md still the scaffold, or with no prose.
 */
export function lintSpec(spec: Spec, markdown: string): LintConcern[] {
  const out: LintConcern[] = [];
  const criteria = [...spec.acceptanceCriteria].sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
  for (const c of criteria) {
    if (c.priority === "P0" && c.kind === "rubric") out.push({ source: "lint", rule: "p0_rubric", criterionId: c.id, question: `${c.id} is a P0 criterion judged by rubric; what observable result would show it is met?`, why: "The most important criteria are the ones a check should decide, not an opinion.", evidence: [] });
  }
  for (const c of criteria) {
    const vague = UNMEASURABLE_WORDS.filter((w) => hasPhrase(c.statement, w));
    if (vague.length && !/[0-9]/.test(c.statement) && !OBSERVABLE_VERBS.some((v) => hasPhrase(c.statement, v))) {
      out.push({ source: "lint", rule: "unmeasurable", criterionId: c.id, question: `${c.id} says "${vague.join(", ")}" with no number and nothing observable; how will anyone know it holds?`, why: "A criterion that cannot be measured cannot be verified, so its gate can only be argued.", evidence: [] });
    }
  }
  if (criteria.length > 0 && !criteria.some((c) => FAILURE_WORDS.some((w) => hasPhrase(c.statement, w)))) {
    out.push({ source: "lint", rule: "no_failure_case", question: "No criterion describes what happens when something goes wrong; which failure or edge case must this handle?", why: "Specs that only describe the happy path leave the failure behavior to whoever writes the code.", evidence: [] });
  }
  const seen = new Map<string, string>();
  for (const c of criteria) {
    const key = normalizeStatementText(c.statement);
    const first = seen.get(key);
    if (first) out.push({ source: "lint", rule: "duplicate", criterionId: c.id, question: `${c.id} says the same as ${first}; is one of them meant to say something else?`, why: "Two identical criteria usually hide a missing one.", evidence: [] });
    else seen.set(key, c.id);
  }
  const prose = markdown.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (markdown.includes(SPEC_SCAFFOLD_INTENT) || prose.length === 0) {
    out.push({ source: "lint", rule: "scaffold_prose", question: "SPEC.md still has the scaffold's placeholder intent, or no prose at all; what is this change for?", why: "The prose half is fingerprinted with the criteria; a reviewer needs the intent to judge them.", evidence: [] });
  }
  return out;
}

export const challengePath = (specDir: string) => join(specDir, "challenge.json");

export async function readChallenge(specDir: string): Promise<SpecChallenge | null> {
  try {
    return SpecChallengeSchema.parse(JSON.parse(await readFile(challengePath(specDir), "utf8")));
  } catch {
    return null;
  }
}

export async function writeChallenge(specDir: string, record: SpecChallenge, held: HeldLock): Promise<string> {
  void held;
  const path = challengePath(specDir);
  await atomicWriteFile(path, JSON.stringify(SpecChallengeSchema.parse(record), null, 2) + "\n");
  return path;
}

/** A new round: lint concerns first (fixed rule order, then criterion id), then agent concerns in their order, numbered C-1 onward. */
export function newRound(previous: SpecChallenge | null, specId: string, specFingerprint: string, lint: LintConcern[], agent: { ran: boolean; runId?: string; note?: ChallengeRound["agent"]["note"]; dropped: number; concerns: Omit<ChallengeConcern, "id" | "source">[] }, now: Date): SpecChallenge {
  const concerns: ChallengeConcern[] = [...lint, ...agent.concerns.map((c) => ({ ...c, source: "agent" as const }))].map((c, i) => ({ id: `C-${i + 1}`, ...c }));
  const round: ChallengeRound = { round: (previous?.rounds.length ?? 0) + 1, specFingerprint, createdAt: now.toISOString(), agent: { ran: agent.ran, ...(agent.runId ? { runId: agent.runId } : {}), ...(agent.note ? { note: agent.note } : {}), dropped: agent.dropped }, concerns };
  return { schema: SCHEMA_VERSIONS.SPEC_CHALLENGE, specId, rounds: [...(previous?.rounds ?? []), round] };
}
