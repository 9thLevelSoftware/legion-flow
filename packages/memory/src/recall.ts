/**
 * Recall: what memory and the map say about a question, in authority order
 * (the deterministic map, deterministic facts, human facts, model facts, then
 * agent-written run summaries as an unverified transcript block), each
 * block on its own token budget. Read-only: it never takes the lock and never
 * writes the index; when the facts index does not match a fresh replay it
 * answers from the replay and says so.
 *
 * Time is bi-temporal. World time (`asOf`): a fact is true when validAt <= t <
 * invalidAt; expiry is ignored, as in Graphiti. Record time (`knownAt`): a fact
 * was known when it had been activated by then and not yet retired, and an
 * invalidation recorded after that moment does not count yet. Proposed and
 * rejected facts are never returned. Every ranking ends in an id tie-break, and
 * the score is a reciprocal-rank position, never a confidence.
 */
import { SCHEMA_VERSIONS, FACT_REF_PATTERN, RecallDocSchema, type BriefMemoryContext, type FactRow, type RecallBlock, type RecallDoc, type RecallItem, type RecallSource } from "@9thlevelsoftware/legion-flow-schema";
import { sha256Hex, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIndex } from "./index-db.js";
import { currentFacts, validEpisodes } from "./fact-service.js";
import { replayObservations } from "./observations.js";
import { mapStatus } from "./map-service.js";

export interface RecallQuery {
  text?: string;
  subject?: string;
  predicate?: string;
  asOf?: string;
  knownAt?: string;
  /** Estimated tokens per block (characters / 4). Default 800. */
  budget?: number;
}

const RRF_K = 60;
const ITEM_CHARS = 600;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The one visibility rule for both time axes; see the module comment. */
export function visibleAt(row: FactRow, opts: { asOf?: string; knownAt?: string; now: string }): boolean {
  if (row.status !== "active" && row.status !== "superseded") return false;
  const world = opts.asOf ?? opts.knownAt ?? opts.now;
  if (opts.knownAt) {
    const activated = row.activatedAt ?? row.createdAt;
    if (activated > opts.knownAt) return false;
    if (row.expiredAt && row.expiredAt <= opts.knownAt) return false;
  }
  // An invalidation recorded after the record-time moment was not known yet.
  const invalidAt = opts.knownAt && row.expiredAt && row.expiredAt > opts.knownAt ? undefined : row.invalidAt;
  return row.validAt <= world && (!invalidAt || world < invalidAt);
}

/** `--subject`: exact, or a prefix when it ends in / or #; a module subject also covers that module's symbols. */
export function subjectMatches(filter: string, subject: string): boolean {
  const prefix = filter.endsWith("/") || filter.endsWith("#");
  const symbolForm = filter.startsWith("module:") ? "symbol:" + filter.slice("module:".length) : null;
  if (prefix) return subject.startsWith(filter) || (symbolForm !== null && subject.startsWith(symbolForm));
  return subject === filter || (symbolForm !== null && subject.startsWith(symbolForm + "#"));
}

const objectText = (r: FactRow) => ("ref" in r.object ? r.object.ref : r.object.text);
const terms = (s: string) => [...new Set(s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0))];

/** Typed references and path-like tokens a query names. */
function refsIn(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set(text.split(/\s+/).map((t) => t.replace(/^[("'`]+|[)"'`.,;]+$/g, "")).filter((t) => FACT_REF_PATTERN.test(t)))].sort();
}
const pathTokens = (text: string | undefined) => (text ? [...new Set(text.split(/\s+/).map((t) => t.replace(/^[("'`]+|[)"'`.,;]+$/g, "")).filter((t) => t.includes("/") && !t.includes(":")))] : []);

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= ITEM_CHARS) return { text, truncated: false };
  const cut = text.slice(0, ITEM_CHARS);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return { text: (at > ITEM_CHARS / 3 ? cut.slice(0, at + 1) : cut) + " [truncated]", truncated: true };
}

function budgeted(source: RecallSource, ranked: Omit<RecallItem, "truncated">[], limit: number, empty: string, answerFor: (n: number) => string): RecallBlock {
  const items: RecallItem[] = [];
  let used = 0;
  let truncatedCount = 0;
  let dropped = 0;
  for (const r of ranked) {
    const t = truncate(r.text);
    const cost = Math.ceil(t.text.length / 4);
    if (used + cost > limit) {
      dropped++;
      continue;
    }
    used += cost;
    if (t.truncated) truncatedCount++;
    items.push({ ...r, text: t.text, truncated: t.truncated });
  }
  const missing = [...(items.length === 0 ? [empty] : []), ...(dropped ? [`${dropped} lower-ranked item(s) dropped over the ${limit}-token budget (tokens estimated as characters / 4)`] : [])];
  return { source, status: items.length ? "OK" : "INSUFFICIENT_CONTEXT", answer: items.length ? answerFor(items.length) : empty, items, missing, budget: { limit, used, dropped, truncated: truncatedCount } };
}

export async function recall(ws: Workspace, q: RecallQuery, now: Date = new Date()): Promise<RecallDoc> {
  const limit = q.budget ?? 800;
  const { rows, indexed } = await currentFacts(ws);
  const status = await mapStatus(ws);
  const nowIso = now.toISOString();
  const timeOpts = { ...(q.asOf ? { asOf: new Date(q.asOf).toISOString() } : {}), ...(q.knownAt ? { knownAt: new Date(q.knownAt).toISOString() } : {}), now: nowIso };
  const candidates = rows.filter((r) => visibleAt(r, timeOpts) && (!q.subject || subjectMatches(q.subject, r.subject)) && (!q.predicate || r.predicate === q.predicate));
  const candidateIds = new Set(candidates.map((r) => r.id));

  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  try {
    // List 1: text, by BM25 when the index matches the replay, else by term count over the replay.
    const lists: string[][] = [];
    if (q.text) {
      if (indexed && index) {
        lists.push(index.searchFacts(q.text).filter((id) => candidateIds.has(id)));
      } else {
        const want = terms(q.text);
        lists.push(
          candidates
            .map((r) => ({ id: r.id, n: terms(`${r.subject} ${r.predicate} ${objectText(r)}`).filter((t) => want.includes(t)).length }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))
            .map((x) => x.id)
        );
      }
    }
    // List 2: subjects the query names (typed references in the text, or --subject).
    const named = [...refsIn(q.text), ...(q.subject ? [q.subject] : [])];
    if (named.length) {
      lists.push(candidates.filter((r) => named.some((n) => subjectMatches(n, r.subject))).sort((a, b) => (a.validAt > b.validAt ? -1 : a.validAt < b.validAt ? 1 : byId(a, b))).map((r) => r.id));
    }
    // The modules the query is about, for the map block and the adjacency list.
    const modules = new Set<string>();
    const symbols = new Set<string>();
    if (index?.mapState()) {
      const facts = index.readMapFacts();
      const known = new Set(facts.modules.map((m) => m.path));
      for (const n of named) {
        const m = /^(module|symbol):([^#]+)(?:#(.+))?$/.exec(n);
        if (!m) continue;
        if (m[2]!.endsWith("/")) for (const p of [...known].filter((p) => p.startsWith(m[2]!)).sort().slice(0, 10)) modules.add(p);
        else if (known.has(m[2]!)) {
          modules.add(m[2]!);
          if (m[1] === "symbol" && m[3]) symbols.add(`${m[2]}#${m[3]}`);
        }
      }
      for (const p of pathTokens(q.text)) if (known.has(p)) modules.add(p);
      // A bare name counts only at three characters or more and declared in exactly one module.
      for (const t of terms(q.text ?? "").filter((t) => t.length >= 3)) {
        const declared = facts.symbols.filter((s) => s.name.toLowerCase() === t && s.kind !== "reexport" && s.kind !== "reexport_all");
        if (declared.length === 1) symbols.add(`${declared[0]!.module}#${declared[0]!.name}`);
      }
      // List 3: facts about modules one import away.
      const neighbors = new Set<string>();
      for (const m of modules) for (const x of [...index.deps(m, 1).modules, ...index.impact(m, 1).modules]) if (!modules.has(x.path)) neighbors.add(x.path);
      if (neighbors.size) {
        lists.push(candidates.filter((r) => [...neighbors].some((n) => subjectMatches(`module:${n}`, r.subject))).sort((a, b) => (a.validAt > b.validAt ? -1 : a.validAt < b.validAt ? 1 : byId(a, b))).map((r) => r.id));
      }
    }
    if (lists.length === 0) lists.push([...candidates].sort((a, b) => (a.validAt > b.validAt ? -1 : a.validAt < b.validAt ? 1 : byId(a, b))).map((r) => r.id));

    // Reciprocal rank fusion, then a total order.
    const score = new Map<string, number>();
    for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    const byIdMap = new Map(candidates.map((r) => [r.id, r]));
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, s]) => ({ row: byIdMap.get(id)!, rank: Number(s.toFixed(6)) }));
    const factItem = (r: FactRow, rank: number): Omit<RecallItem, "truncated"> => ({
      id: r.id,
      text: `${r.subject} ${r.predicate} ${objectText(r)} (true from ${r.validAt}${r.invalidAt ? ` until ${r.invalidAt}` : ""})`,
      rank,
      citations: [{ label: "fact", locator: r.id }, { label: "episode", locator: r.episodeId }],
      fact: { subject: r.subject, predicate: r.predicate, origin: r.origin, status: r.status, validAt: r.validAt, ...(r.invalidAt ? { invalidAt: r.invalidAt } : {}), createdAt: r.createdAt, ...(r.expiredAt ? { expiredAt: r.expiredAt } : {}) },
    });
    const factBlock = (source: "deterministic" | "human" | "llm", label: string) =>
      budgeted(source, ranked.filter((x) => x.row.origin === source).map((x) => factItem(x.row, x.rank)), limit, `no ${label} fact matched`, (n) => `${n} ${label} fact(s)${source === "llm" ? ", recorded by an agent and unverified" : ""}`);

    // Committed observations ride in the human block (a human committed them), ranked at their best member's
    // rank, or after the facts when only their name matches. They are record-time objects: --known-at filters them;
    // --as-of applies to their members, not to them.
    const at = timeOpts.knownAt ?? nowIso;
    const rankOf = new Map(ranked.map((x) => [x.row.id, x.rank]));
    const want = q.text ? terms(q.text) : [];
    const observationItems: Omit<RecallItem, "truncated">[] = [];
    for (const o of replayObservations(await validEpisodes(ws), rows)) {
      const e = o.episode;
      if (e.createdAt > at || (o.retiredAt !== undefined && o.retiredAt <= at)) continue;
      const best = Math.max(0, ...e.factIds.map((id) => rankOf.get(id) ?? 0));
      const named = want.length > 0 && terms(e.name).some((t) => want.includes(t));
      if (best === 0 && !named) continue;
      observationItems.push({
        id: e.id,
        // Whose words they are (M4 slice p): a model's wording is labelled, so it never reads as plain human authority.
        text: `observation: ${e.name}: ${e.summary}${o.stale ? ` [stale: ${o.stale}]` : ""} (committed ${e.createdAt} by ${e.decidedBy}; worded by ${e.wording?.by === "agent" ? `agent ${e.wording.adapter ?? "unknown"}${e.wording.model ? ` ${e.wording.model}` : ""}${e.edited ? ", edited by a decision owner" : ""}` : e.wording?.by === "human" || (!e.wording && e.edited) ? "a decision owner" : `the template${e.edited ? ", edited by a decision owner" : ""}`}; --as-of does not apply to an observation)`,
        rank: best || Number((1 / (RRF_K + ranked.length + 1)).toFixed(6)),
        citations: [{ label: "observation", locator: e.id }, ...e.factIds.map((id) => ({ label: "fact", locator: id }))],
      });
    }
    const humanItems = [...ranked.filter((x) => x.row.origin === "human").map((x) => factItem(x.row, x.rank)), ...observationItems].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const humanBlock = budgeted("human", humanItems, limit, "no human fact or observation matched", (n) => `${n} human fact(s) and committed observation(s)`);

    // The map block: the current snapshot only.
    let mapBlock: RecallBlock;
    try {
      if (!index?.mapState()) mapBlock = budgeted("map", [], limit, "there is no map index; run legion-flow map", () => "");
      else {
        const facts = index.readMapFacts();
        const items: Omit<RecallItem, "truncated">[] = [];
        let i = 0;
        const routeText = (r: (typeof facts.routes)[number]) => `${r.method.toUpperCase()} ${r.path ?? `(unresolved: ${r.unresolved})`}`;
        for (const m of [...modules].sort()) {
          const deps = index.deps(m, 1).modules.map((x) => x.path);
          const by = index.impact(m, 1).modules.map((x) => x.path);
          const exports = facts.symbols.filter((s) => s.module === m).map((s) => s.name).sort();
          const serves = facts.routes.filter((r) => r.module === m).map(routeText);
          items.push({ id: m, text: `${m}: imports ${deps.join(", ") || "nothing mapped"}; imported by ${by.join(", ") || "nothing mapped"}; exports ${exports.join(", ") || "nothing"}${serves.length ? `; serves ${serves.join(", ")}` : ""}`, rank: Number((1 / (RRF_K + ++i)).toFixed(6)), citations: [{ label: "map snapshot", locator: index.mapState()!.snapshotId }, { label: "module", locator: m }] });
        }
        for (const s of [...symbols].sort()) {
          const users = index.whoUses(s).usedBy;
          items.push({ id: s, text: `${s} is used by ${users.join(", ") || "no mapped module"}`, rank: Number((1 / (RRF_K + ++i)).toFixed(6)), citations: [{ label: "map snapshot", locator: index.mapState()!.snapshotId }, { label: "symbol", locator: s }] });
        }
        // URL paths the query names (a token starting with /): the routes found by syntax that serve them.
        const urls = (q.text ?? "").split(/\s+/).map((t) => t.replace(/^[("'`]+|[)"'`.,;]+$/g, "")).filter((t) => t.startsWith("/") && t.length > 1);
        for (const r of facts.routes.filter((r) => r.path !== undefined && urls.some((u) => r.path === u || r.path!.startsWith(u.endsWith("/") ? u : u + "/")))) {
          items.push({ id: `route:${r.method} ${r.path}`, text: `${routeText(r)} is declared in ${r.module}:${r.line} (${r.detector}, found by syntax)`, rank: Number((1 / (RRF_K + ++i)).toFixed(6)), citations: [{ label: "map snapshot", locator: index.mapState()!.snapshotId }, { label: "route", locator: `${r.module}:${r.line}` }] });
        }
        mapBlock = budgeted("map", items, limit, "the query names no module, symbol, or route in the map", (n) => `${n} map item(s) from the current snapshot (${status.freshness}); --as-of does not apply to the map`);
      }
    } catch (err: unknown) {
      mapBlock = { source: "map", status: "ERROR", answer: `the map could not be read: ${(err as Error).message}`, items: [], missing: ["the map block"], budget: { limit, used: 0, dropped: 0, truncated: 0 } };
    }

    return RecallDocSchema.parse({
      schema: SCHEMA_VERSIONS.RECALL,
      query: { ...(q.text ? { text: q.text } : {}), ...(q.subject ? { subject: q.subject } : {}), ...(q.predicate ? { predicate: q.predicate } : {}), ...(q.asOf ? { asOf: timeOpts.asOf } : {}), ...(q.knownAt ? { knownAt: timeOpts.knownAt } : {}) },
      factsIndexed: Boolean(indexed && index),
      mapFreshness: status.freshness,
      tokenEstimate: "chars/4",
      blocks: [mapBlock, factBlock("deterministic", "deterministic"), humanBlock, factBlock("llm", "model-recorded"), await transcriptBlock(ws, q.text, timeOpts.knownAt ?? timeOpts.asOf ?? nowIso, limit)],
    });
  } finally {
    index?.close();
  }
}

/**
 * The transcript block (M4 slice g): agent-written run summaries (`agent_summary`
 * evidence), unverified, ranked by how many query terms each contains. Only runs
 * started by the time asked about count; every file is re-hashed against the run's
 * evidence index, and a drifted one is left out and named.
 */
async function transcriptBlock(ws: Workspace, text: string | undefined, at: string, limit: number): Promise<RecallBlock> {
  if (!text) return budgeted("transcript", [], limit, "the transcript block answers a text query", () => "");
  try {
    const want = terms(text);
    const found: { item: Omit<RecallItem, "truncated">; n: number }[] = [];
    const drifted: string[] = [];
    for (const loaded of await ws.runs.list()) {
      if (loaded.run.startedAt > at) continue;
      for (const entry of loaded.evidenceIndex.filter((e) => e.producedBy === "spawn")) {
        const bytes = await readFile(join(ws.paths.project, ...entry.path.split("/"))).catch(() => null);
        if (!bytes) continue;
        if (sha256Hex(bytes) !== entry.sha256) {
          drifted.push(entry.path);
          continue;
        }
        const record = JSON.parse(bytes.toString("utf8")) as { kind?: string; text?: string; taskId?: string };
        if (record.kind !== "agent_summary" || typeof record.text !== "string") continue;
        const n = terms(record.text).filter((t) => want.includes(t)).length;
        if (n === 0) continue;
        found.push({ n, item: { id: loaded.run.id, text: `${loaded.run.id}${record.taskId ? ` (${record.taskId})` : ""}: ${record.text.replace(/\s+/g, " ").trim()}`, rank: 0, citations: [{ label: "run", locator: loaded.run.id }, { label: "evidence", locator: entry.path }] } });
      }
    }
    found.sort((a, b) => b.n - a.n || byId(a.item, b.item));
    const block = budgeted("transcript", found.map((f, i) => ({ ...f.item, rank: Number((1 / (RRF_K + i + 1)).toFixed(6)) })), limit, "no agent summary matched the query", (n) => `${n} agent summary(ies), written by agents and unverified`);
    if (drifted.length) block.missing.push(`${drifted.length} evidence file(s) no longer match their hash and were left out: ${drifted.slice(0, 3).join(", ")}`);
    return block;
  } catch (err: unknown) {
    return { source: "transcript", status: "ERROR", answer: `the run summaries could not be read: ${(err as Error).message}`, items: [], missing: ["the transcript block"], budget: { limit, used: 0, dropped: 0, truncated: 0 } };
  }
}

/** Facts about the files a task may touch, for its brief: true now, most authoritative first, within the budget. */
export async function memoryContextFor(ws: Workspace, matches: (path: string) => boolean, budget = 800, now: Date = new Date()): Promise<BriefMemoryContext> {
  const { rows, indexed } = await currentFacts(ws);
  const order = { deterministic: 0, human: 1, llm: 2 } as const;
  const relevant = rows
    .filter((r) => visibleAt(r, { now: now.toISOString() }))
    .filter((r) => {
      const m = /^(?:module|symbol):([^#]+)/.exec(r.subject);
      return Boolean(m && matches(m[1]!));
    })
    .sort((a, b) => order[a.origin] - order[b.origin] || (a.validAt > b.validAt ? -1 : a.validAt < b.validAt ? 1 : byId(a, b)));
  const facts: BriefMemoryContext["facts"] = [];
  let used = 0;
  let dropped = 0;
  for (const r of relevant) {
    const object = truncate(objectText(r)).text;
    const cost = Math.ceil((r.subject.length + r.predicate.length + object.length) / 4);
    if (used + cost > budget) {
      dropped++;
      continue;
    }
    used += cost;
    facts.push({ id: r.id, subject: r.subject, predicate: r.predicate, object, origin: r.origin, validAt: r.validAt });
  }
  return { facts, dropped, indexed };
}
