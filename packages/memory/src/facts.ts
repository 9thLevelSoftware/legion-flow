/**
 * Facts as a pure replay of episodes, in id order: learn adds a fact (active or
 * proposed), retro adds deterministic facts, and a supersession decision either
 * activates the new fact and retires the old ones the Graphiti way (invalidAt =
 * the new fact's validAt, expiredAt = when it was decided, never deleted) or
 * marks the proposal rejected. The index tables are this replay, so they can
 * always be rebuilt from project/.
 */
import { createHash } from "node:crypto";
import type { Episode, Fact, FactRow } from "@9thlevelsoftware/legion-flow-schema";
import { canonicalJson } from "@9thlevelsoftware/legion-flow-map";

export function replayFacts(episodes: readonly Episode[]): FactRow[] {
  const rows = new Map<string, FactRow>();
  for (const e of [...episodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (e.kind === "learn") {
      rows.set(e.fact.id, { ...e.fact, status: e.status, episodeId: e.id, ...(e.status === "active" ? { activatedAt: e.fact.createdAt } : {}) });
    } else if (e.kind === "retro") {
      for (const f of e.facts) rows.set(f.id, { ...f, status: "active", episodeId: e.id, activatedAt: f.createdAt });
    } else if (e.kind === "supersession") {
      const next = rows.get(e.newFactId);
      if (!next) continue;
      if (e.outcome !== "approved") {
        rows.set(next.id, { ...next, status: "rejected" });
        continue;
      }
      rows.set(next.id, { ...next, status: "active", activatedAt: e.createdAt });
      for (const oldId of e.oldFactIds) {
        const old = rows.get(oldId);
        if (old && old.status === "active") rows.set(oldId, { ...old, status: "superseded", invalidAt: next.validAt, expiredAt: e.createdAt });
      }
    }
  }
  return [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function factRowsSha256(rows: readonly FactRow[]): string {
  return createHash("sha256").update(canonicalJson(rows)).digest("hex");
}

const sameObject = (a: Fact["object"], b: Fact["object"]) => canonicalJson(a) === canonicalJson(b);

/**
 * The active facts a new fact would replace: those it names with --supersedes,
 * and, for a predicate declared single-valued, every active fact on the same
 * subject and predicate whose object differs. Everything else coexists.
 */
export function conflictsFor(rows: readonly FactRow[], fact: Pick<Fact, "subject" | "predicate" | "object" | "supersedes">, singleValued: readonly string[]): FactRow[] {
  const out = new Map<string, FactRow>();
  for (const id of fact.supersedes ?? []) {
    const r = rows.find((x) => x.id === id && x.status === "active");
    if (r) out.set(r.id, r);
  }
  if (singleValued.includes(fact.predicate)) {
    for (const r of rows) {
      if (r.status === "active" && r.subject === fact.subject && r.predicate === fact.predicate && !sameObject(r.object, fact.object)) out.set(r.id, r);
    }
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** True at time t: valid by then, not yet invalidated, and active or superseded (a superseded fact was true before its invalidAt). */
export function trueAsOf(row: FactRow, t: string): boolean {
  if (row.status !== "active" && row.status !== "superseded") return false;
  return row.validAt <= t && (!row.invalidAt || t < row.invalidAt);
}
