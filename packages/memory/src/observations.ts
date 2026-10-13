/**
 * Observations (M4 slice i), after Zep's: facts that share a statement key
 * (subject, predicate, and object) across two or more episodes are linked, and
 * each connected component becomes a candidate. The grouping is deterministic;
 * a template only names what the algorithm found, and a human commits it on
 * `decide`. Committed observations are replayed from episodes like facts: a
 * later commit that overlaps an earlier one retires it, and one whose members
 * are no longer all active is stale.
 */
import { createHash } from "node:crypto";
import {
  OBSERVATION_NAME_MAX,
  OBSERVATION_SUMMARY_MAX,
  type Episode,
  type Fact,
  type FactRow,
  type ObservationCandidate,
  type ObservationEpisode,
} from "@9thlevelsoftware/legion-flow-schema";

/** Text as the statement key compares it: NFC, lowercase, whitespace collapsed, trimmed. */
export function normalizeStatementText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A fact's statement key; a ref and a text with the same spelling never share one. */
export function statementKey(f: Pick<Fact, "subject" | "predicate" | "object">): string {
  return `${f.subject}\0${f.predicate}\0${"ref" in f.object ? `ref:${f.object.ref}` : `text:${normalizeStatementText(f.object.text)}`}`;
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + "…");
const objectOf = (f: FactRow) => ("ref" in f.object ? f.object.ref : JSON.stringify(f.object.text));

/**
 * Candidates over the facts active now. A key counts as a link only when it occurs
 * in two or more distinct episodes; a candidate holds only those kept keys and the
 * facts that carry them, so one duplicated retro fact never drags in the rest.
 */
/** A mention: one active fact in one episode, its own or a corroboration's. */
type Mention = { fact: FactRow; episodeId: string; origin: FactRow["origin"] };

/** The corroboration links in a list of episodes. */
export function corroborationsOf(episodes: readonly Episode[]): { episodeId: string; factId: string; origin: FactRow["origin"] }[] {
  return episodes.flatMap((e) => (e.kind === "corroboration" ? [{ episodeId: e.id, factId: e.factId, origin: e.origin }] : []));
}

export function clusterObservations(rows: readonly FactRow[], corroborations: readonly { episodeId: string; factId: string; origin: FactRow["origin"] }[] = []): ObservationCandidate[] {
  const active = rows.filter((r) => r.status === "active");
  const byId = new Map(active.map((r) => [r.id, r]));
  const mentions: Mention[] = [...active.map((r) => ({ fact: r, episodeId: r.episodeId, origin: r.origin })), ...corroborations.flatMap((c) => (byId.has(c.factId) ? [{ fact: byId.get(c.factId)!, episodeId: c.episodeId, origin: c.origin }] : []))];
  const byKey = new Map<string, Mention[]>();
  for (const m of mentions) (byKey.get(statementKey(m.fact)) ?? byKey.set(statementKey(m.fact), []).get(statementKey(m.fact))!).push(m);
  const kept = [...byKey.entries()].filter(([, ms]) => new Set(ms.map((m) => m.episodeId)).size >= 2).sort(([a], [b]) => (a < b ? -1 : 1));

  // Union-find over episodes, joined by every kept key.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c)! !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const [, ms] of kept) for (const m of ms) if (!parent.has(m.episodeId)) parent.set(m.episodeId, m.episodeId);
  for (const [, ms] of kept) for (const m of ms.slice(1)) union(ms[0]!.episodeId, m.episodeId);

  const components = new Map<string, { keys: string[]; mentions: Mention[] }>();
  for (const [key, ms] of kept) {
    const root = find(ms[0]!.episodeId);
    const c = components.get(root) ?? components.set(root, { keys: [], mentions: [] }).get(root)!;
    c.keys.push(key);
    c.mentions.push(...ms);
  }
  const out: ObservationCandidate[] = [];
  for (const c of components.values()) {
    const keys = [...c.keys].sort();
    const facts = [...new Map(c.mentions.map((m) => [m.fact.id, m.fact])).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const subjects = [...new Set(facts.map((f) => f.subject))].sort();
    const episodes = [...new Set(c.mentions.map((m) => m.episodeId))].sort();
    const validAts = facts.map((f) => f.validAt).sort();
    const origins = { deterministic: 0, human: 0, llm: 0 };
    for (const m of c.mentions) origins[m.origin]++;
    const first = facts[0]!;
    const name = keys.length === 1 ? clip(`${first.predicate} ${objectOf(first)}`, OBSERVATION_NAME_MAX) : clip(`${keys.length} related statements about ${subjects.slice(0, 3).join(", ")}${subjects.length > 3 ? ` and ${subjects.length - 3} more` : ""}`, OBSERVATION_NAME_MAX);
    const originText = (["deterministic", "human", "llm"] as const).filter((o) => origins[o]).map((o) => `${origins[o]} ${o === "llm" ? "recorded by agents (unverified)" : o}`).join(", ");
    const summary = clip(`${c.mentions.length} mentions (${facts.length} fact${facts.length === 1 ? "" : "s"}) across ${episodes.length} episodes state ${keys.length === 1 ? `that ${first.subject} ${first.predicate} ${objectOf(first)}` : `${keys.length} statements about ${subjects.join(", ")}`}, valid from ${validAts[0]} to ${validAts[validAts.length - 1]}; ${originText}.`, OBSERVATION_SUMMARY_MAX);
    out.push({
      id: `obc_${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 12)}`,
      name,
      summary,
      keys,
      subjects,
      factIds: facts.map((f) => f.id),
      episodeIds: episodes,
      origins,
      firstValidAt: validAts[0]!,
      lastValidAt: validAts[validAts.length - 1]!,
    });
  }
  return out.sort((a, b) => b.factIds.length - a.factIds.length || (a.id < b.id ? -1 : 1));
}

export interface ObservationRow {
  episode: ObservationEpisode;
  status: "active" | "retired";
  retiredAt?: string;
  retiredBy?: string;
  /** Why its members no longer hold, when one is not active now. */
  stale?: string;
}

/** Committed observations in episode order; a later one that shares a key or a fact retires every earlier active one. */
export function replayObservations(episodes: readonly Episode[], rows: readonly FactRow[]): ObservationRow[] {
  const out: ObservationRow[] = [];
  const status = new Map(rows.map((r) => [r.id, r.status]));
  for (const e of [...episodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (e.kind !== "observation") continue;
    const keys = new Set(e.keys);
    const facts = new Set(e.factIds);
    for (const o of out) {
      if (o.status === "active" && (o.episode.keys.some((k) => keys.has(k)) || o.episode.factIds.some((f) => facts.has(f)))) {
        o.status = "retired";
        o.retiredAt = e.createdAt;
        o.retiredBy = e.id;
      }
    }
    const notActive = e.factIds.find((f) => status.get(f) !== "active");
    out.push({ episode: e, status: "active", ...(notActive ? { stale: `member ${notActive} is ${status.get(notActive) ?? "missing"}` } : {}) });
  }
  return out;
}
