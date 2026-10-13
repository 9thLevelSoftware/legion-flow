/**
 * The map service: freshness, build, and queries over the index, plus the
 * rules check, the proposal analysis, and diagrams. It lives here, below gates
 * and cli, because the architecture_conformance gate reads it too.
 */
import { isAbsolute, relative, sep } from "node:path";
import { SCHEMA_VERSIONS, MapQueryResultSchema, type LanguageServerConfig, type MapFreshness, type MapLanguageEntry, type MapQueryKind, type MapQueryResult, type MapSnapshotEpisode } from "@9thlevelsoftware/legion-flow-schema";
import { detectTreeMode, fingerprintTree, type HeldLock, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { canonicalJson, extractMap, factsSha256, filesWithExtensions, mapInputFingerprint, selectMapInputs, sortFacts, type MapInputFile } from "@9thlevelsoftware/legion-flow-map";
import { createHash } from "node:crypto";
import { MemoryIndex } from "./index-db.js";
import type { BriefMapContext, MapFacts, MapRules, MapViolation, ProposalArchitecture, ProposalImpact } from "@9thlevelsoftware/legion-flow-schema";
import { compareViolations, contextFor, discoverWorkspacePackages, evaluateRules, impactOf, renderMapDiagram, rulesSha256, type Diagram } from "@9thlevelsoftware/legion-flow-map";

export interface MapStatus {
  freshness: MapFreshness;
  snapshot?: MapSnapshotEpisode;
  /** Why the map is not fresh, for a diagnostic. */
  reason?: string;
}

export async function latestSnapshot(ws: Workspace): Promise<MapSnapshotEpisode | undefined> {
  const episodes = await ws.episodes.list();
  for (let i = episodes.length - 1; i >= 0; i--) {
    const e = episodes[i]!;
    if (e.kind === "valid" && e.episode.kind === "map_snapshot") return e.episode;
  }
  return undefined;
}

/** What a language server run contributed; the lsp package's extraction has this shape. */
export interface LanguageServerRun {
  modules: MapFacts["modules"];
  symbols: MapFacts["symbols"];
  imports: MapFacts["imports"];
  usages: MapFacts["usages"];
  /** Language servers report no routes; absent is empty. */
  routes?: MapFacts["routes"];
  capped: string[];
  partial?: string;
  server?: { name: string; version?: string };
}

/**
 * Runs one configured language server over a directory. Supplied by cli, which
 * composes the lsp client with a sandbox session; memory never imports either.
 */
export interface LanguageServerRunner {
  run(server: LanguageServerConfig, input: { root: string; files: MapInputFile[] }): Promise<LanguageServerRun>;
  /** Start the server, read its name and version from initialize, stop it (M4 slice g). Absent means the version is unavailable. */
  version?(server: LanguageServerConfig, input: { root: string }): Promise<{ name: string; version?: string } | null>;
}

export function serversOf(config: { map?: { languageServers?: LanguageServerConfig[] } } | undefined): LanguageServerConfig[] {
  return [...(config?.map?.languageServers ?? [])].sort((a, b) => (a.language < b.language ? -1 : 1));
}

const configSha = (server: LanguageServerConfig) => createHash("sha256").update(canonicalJson(server)).digest("hex");

async function configuredServers(ws: Workspace): Promise<LanguageServerConfig[]> {
  const project = await ws.project.load();
  return project.kind === "valid" ? serversOf(project.config) : [];
}

export async function currentInputs(ws: Workspace, servers?: LanguageServerConfig[]) {
  const list = servers ?? (await configuredServers(ws));
  const mode = await detectTreeMode(ws.root);
  const tree = await fingerprintTree(ws.root, { mode });
  const inputs = selectMapInputs(tree.files, list.flatMap((s) => s.extensions));
  return { mode, inputs, fingerprint: mapInputFingerprint(inputs), servers: list };
}

/** Freshness: the index holds the latest snapshot, the checkout still fingerprints as it, and every configured language server is covered as configured. */
export async function mapStatus(ws: Workspace): Promise<MapStatus> {
  const snapshot = await latestSnapshot(ws);
  if (!snapshot) return { freshness: "absent", reason: "no map snapshot has been recorded" };
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  try {
    const state = index?.mapState();
    if (!state || state.snapshotId !== snapshot.id || state.factsSha256 !== snapshot.factsSha256) {
      return { freshness: "absent", snapshot, reason: index ? `the index does not hold snapshot ${snapshot.id}` : "the index is missing or at an older schema version; run map" };
    }
  } finally {
    index?.close();
  }
  const current = await currentInputs(ws);
  if (current.fingerprint !== snapshot.treeFingerprint || current.mode !== snapshot.treeMode) {
    return { freshness: "stale", snapshot, reason: "source files changed since the snapshot" };
  }
  const covered = new Map((snapshot.languages ?? []).map((l) => [l.language, l]));
  for (const s of current.servers) {
    const entry = covered.get(s.language);
    if (!entry || entry.configSha256 !== configSha(s)) return { freshness: "stale", snapshot, reason: `language server '${s.language}' is configured differently from the snapshot` };
  }
  if ((snapshot.languages ?? []).some((l) => !current.servers.some((s) => s.language === l.language))) {
    return { freshness: "stale", snapshot, reason: "a language server in the snapshot is no longer configured" };
  }
  const partialLanguages = (snapshot.languages ?? []).filter((l) => l.partial);
  if (snapshot.skipped.length > 0 || partialLanguages.length > 0) {
    const parts = [...(snapshot.skipped.length ? [`${snapshot.skipped.length} file(s) were skipped`] : []), ...partialLanguages.map((l) => `${l.language}: ${l.partial}`)];
    return { freshness: "partial", snapshot, reason: parts.join("; ") };
  }
  return { freshness: "fresh", snapshot };
}

export type BuildOutcome = { kind: "built" | "unchanged" | "reindexed"; snapshot: MapSnapshotEpisode; ms: number; languages: MapLanguageEntry[] };

function factsOfLanguage(facts: MapFacts, language: string): MapFacts {
  const modules = facts.modules.filter((m) => m.lspLanguage === language);
  const paths = new Set(modules.map((m) => m.path));
  return {
    modules,
    symbols: facts.symbols.filter((s) => paths.has(s.module)),
    imports: facts.imports.filter((i) => i.resolution === "lsp" && paths.has(i.from)),
    usages: facts.usages.filter((u) => u.via === "lsp" && paths.has(u.usedBy)),
    routes: [],
  };
}

const mergeFacts = (parts: MapFacts[]): MapFacts =>
  sortFacts({ modules: parts.flatMap((p) => p.modules), symbols: parts.flatMap((p) => p.symbols), imports: parts.flatMap((p) => p.imports), usages: parts.flatMap((p) => p.usages), routes: parts.flatMap((p) => p.routes) });

/** Run (or reuse) every configured language server over `root`. */
async function languageFacts(
  root: string,
  inputs: MapInputFile[],
  servers: LanguageServerConfig[],
  options: { runner?: LanguageServerRunner; rebuild?: boolean; previous?: MapSnapshotEpisode; previousFacts?: MapFacts | null }
): Promise<{ facts: MapFacts[]; entries: MapLanguageEntry[]; capped: string[] }> {
  const facts: MapFacts[] = [];
  const entries: MapLanguageEntry[] = [];
  const capped: string[] = [];
  for (const server of servers) {
    const files = filesWithExtensions(inputs, server.extensions);
    const inputFingerprint = mapInputFingerprint(files);
    const cfg = configSha(server);
    const prev = options.previous?.languages?.find((l) => l.language === server.language);
    const base = { language: server.language, extensions: [...server.extensions], inputFingerprint, configSha256: cfg };
    let versionCheck: NonNullable<MapLanguageEntry["versionCheck"]> = "skipped";
    if (!options.rebuild && prev && !prev.partial && prev.inputFingerprint === inputFingerprint && prev.configSha256 === cfg && options.previousFacts) {
      const carried = factsOfLanguage(options.previousFacts, server.language);
      if (carried.modules.length === files.length) {
        // The handshake: an upgraded server may answer differently for the same files, so reuse only on the same reported version.
        let now: { name: string; version?: string } | null = null;
        if (options.runner?.version) {
          try {
            now = await options.runner.version(server, { root });
          } catch {
            now = null;
          }
        }
        versionCheck = !now?.version || !prev.server?.version ? "unavailable" : now.name === prev.server.name && now.version === prev.server.version ? "same" : "changed";
        // With no runner there is nothing better than the carried facts, so they stay, marked unavailable.
        if (versionCheck === "same" || !options.runner) {
          facts.push(carried);
          entries.push({ ...base, ...(prev.server ? { server: prev.server } : {}), modules: files.length, reused: true, versionCheck });
          continue;
        }
      }
    }
    if (files.length === 0) {
      entries.push({ ...base, modules: 0, reused: false, versionCheck });
      continue;
    }
    const modulesOnly: MapFacts = { modules: files.map((f) => ({ id: createHash("sha256").update(`module\0${f.path}`).digest("hex"), path: f.path, sha256: f.sha256, language: "lsp" as const, lspLanguage: server.language })), symbols: [], imports: [], usages: [], routes: [] };
    if (!options.runner) {
      facts.push(modulesOnly);
      entries.push({ ...base, modules: files.length, partial: "no language server runner was available for this build", reused: false, versionCheck });
      continue;
    }
    try {
      const run = await options.runner.run(server, { root, files });
      facts.push({ modules: run.modules, symbols: run.symbols, imports: run.imports, usages: run.usages, routes: run.routes ?? [] });
      capped.push(...run.capped);
      entries.push({ ...base, ...(run.server ? { server: run.server } : {}), modules: run.modules.length, ...(run.partial ? { partial: run.partial } : {}), reused: false, versionCheck });
    } catch (err: unknown) {
      facts.push(modulesOnly);
      entries.push({ ...base, modules: files.length, partial: `the server could not run: ${(err as Error).message}`, reused: false, versionCheck });
    }
  }
  return { facts, entries, capped };
}

/**
 * Extract, merge configured language servers' facts (reusing a language whose
 * files and configuration did not change), compare with the latest snapshot,
 * and record a new one only when the facts changed.
 */
export async function buildMap(ws: Workspace, held: HeldLock, now: Date = new Date(), options: { runner?: LanguageServerRunner; rebuild?: boolean } = {}): Promise<BuildOutcome> {
  const t0 = performance.now();
  const current = await currentInputs(ws);
  const extraction = extractMap(ws.root, current.inputs);
  const latest = await latestSnapshot(ws);
  let previousFacts: MapFacts | null = null;
  if (current.servers.length > 0) {
    const existing = await MemoryIndex.openExisting(ws.paths.indexSqlite);
    if (existing) {
      try {
        if (existing.mapState()?.snapshotId === latest?.id) previousFacts = existing.readMapFacts();
      } finally {
        existing.close();
      }
    }
  }
  const lang = await languageFacts(ws.root, current.inputs, current.servers, { ...options, ...(latest ? { previous: latest } : {}), previousFacts });
  const facts = mergeFacts([extraction.facts, ...lang.facts]);
  const skipped = [...extraction.skipped, ...lang.capped.map((path) => ({ path, reason: "reference_cap" as const }))].sort((a, b) => (a.path < b.path ? -1 : 1));
  const sha = factsSha256(facts);
  let snapshot: MapSnapshotEpisode;
  let kind: BuildOutcome["kind"];
  // The server name and version count, so an upgrade that changes no fact still records the version the next handshake compares against.
  const sameLanguages = canonicalJson((latest?.languages ?? []).map((l) => [l.language, l.configSha256, l.inputFingerprint, l.partial ?? null, l.server?.name ?? null, l.server?.version ?? null])) === canonicalJson(lang.entries.map((l) => [l.language, l.configSha256, l.inputFingerprint, l.partial ?? null, l.server?.name ?? null, l.server?.version ?? null]));
  if (latest && latest.factsSha256 === sha && latest.treeFingerprint === current.fingerprint && latest.extractorVersion === extraction.extractorVersion && latest.treeMode === current.mode && sameLanguages) {
    snapshot = latest;
    kind = "unchanged";
  } else {
    const recorded = await ws.episodes.record(
      {
        schema: SCHEMA_VERSIONS.EPISODE,
        kind: "map_snapshot",
        createdAt: now.toISOString(),
        treeFingerprint: current.fingerprint,
        treeMode: current.mode,
        extractorVersion: extraction.extractorVersion,
        counts: { modules: facts.modules.length, symbols: facts.symbols.length, imports: facts.imports.length, usages: facts.usages.length, routes: facts.routes.length },
        skipped,
        factsSha256: sha,
        ...(lang.entries.length ? { languages: lang.entries } : {}),
      },
      held
    );
    snapshot = recorded.episode as MapSnapshotEpisode;
    kind = "built";
  }
  const index = await MemoryIndex.open(ws.paths.indexSqlite);
  try {
    const state = index.mapState();
    if (kind === "built" || !state || state.snapshotId !== snapshot.id || state.factsSha256 !== sha) {
      index.replaceMap(snapshot.id, facts, sha);
      if (kind === "unchanged") kind = "reindexed";
    }
    // The round trip is the proof: what the index returns must hash to the snapshot.
    const readBack = factsSha256(index.readMapFacts());
    if (readBack !== sha) throw new Error(`map_index_mismatch: the index read back as ${readBack}, the snapshot says ${sha}`);
  } finally {
    index.close();
  }
  if (kind === "built") {
    await ws.audit.append({ type: "map_built", episodeId: snapshot.id, treeFingerprint: snapshot.treeFingerprint, factsSha256: sha, extractorVersion: snapshot.extractorVersion, counts: snapshot.counts, languages: lang.entries.map((l) => ({ language: l.language, reused: l.reused, partial: l.partial ?? null })) }, held);
  }
  return { kind, snapshot, ms: Math.round(performance.now() - t0), languages: lang.entries };
}

/** A path as the map stores it: workspace-relative, forward slashes, no leading ./ */
export function normalizeTarget(root: string, target: string): string {
  let t = target.trim();
  if (isAbsolute(t)) t = relative(root, t);
  t = t.split(sep).join("/").replace(/\\/g, "/");
  while (t.startsWith("./")) t = t.slice(2);
  return t;
}

export type QueryOutcome =
  | { kind: "answered"; result: MapQueryResult; status: MapStatus }
  | { kind: "no_index"; status: MapStatus }
  | { kind: "unknown_target"; status: MapStatus; target: string };

/** Answer one question from the index; never writes. */
export async function runMapQuery(ws: Workspace, query: MapQueryKind, rawTarget: string): Promise<QueryOutcome> {
  const status = await mapStatus(ws);
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  if (!index || !index.mapState()) {
    index?.close();
    return { kind: "no_index", status };
  }
  try {
    const target = query === "routes" ? (rawTarget.trim().startsWith("/") || rawTarget.trim() === "*" ? rawTarget.trim() : normalizeTarget(ws.root, rawTarget)) : query === "who_uses" ? rawTarget.trim().replace(/\\/g, "/").replace(/^\.\//, "") : normalizeTarget(ws.root, rawTarget);
    if (query !== "who_uses" && query !== "routes" && !index.hasModule(target)) return { kind: "unknown_target", status, target };
    const answer = query === "deps" ? index.deps(target) : query === "impact" ? index.impact(target) : query === "routes" ? index.routes(target) : index.whoUses(target);
    const result = MapQueryResultSchema.parse({
      schema: SCHEMA_VERSIONS.MAP_QUERY,
      query: { kind: query, target },
      ...(index.mapState() ? { snapshotId: index.mapState()!.snapshotId } : {}),
      freshness: status.freshness,
      ...answer,
    });
    return { kind: "answered", result, status };
  } finally {
    index.close();
  }
}


// ---- rules, proposals, briefs, diagrams (M4 slice a2) ----


export function rulesOf(config: { map?: { rules?: MapRules } }): MapRules | undefined {
  return config.map?.rules;
}

export type ArchitectureCheck =
  | { kind: "not_fresh"; status: MapStatus }
  | { kind: "checked"; status: MapStatus; rulesSha256: string; violations: MapViolation[]; snapshotId: string; factsSha256: string };

/** Judge the indexed map against the rules. With `requireFresh`, anything but a fresh map is not judged (the gate's stance). */
export async function checkArchitecture(ws: Workspace, rules: MapRules, options: { requireFresh: boolean }): Promise<ArchitectureCheck> {
  const status = await mapStatus(ws);
  if (options.requireFresh && status.freshness !== "fresh") return { kind: "not_fresh", status };
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  const state = index?.mapState();
  if (!index || !state) {
    index?.close();
    return { kind: "not_fresh", status };
  }
  try {
    return { kind: "checked", status, rulesSha256: rulesSha256(rules), violations: evaluateRules(index.readMapFacts(), rules), snapshotId: state.snapshotId, factsSha256: state.factsSha256 };
  } finally {
    index.close();
  }
}

async function factsOfTree(root: string, mode: "fs" | "git"): Promise<MapFacts> {
  const tree = await fingerprintTree(root, { mode });
  return extractMap(root, selectMapInputs(tree.files)).facts;
}

/**
 * A proposal's architecture and blast radius: the corrected candidate tree is
 * mapped and compared with the checkout. Both are extracted the same way and
 * workspace imports resolve by manifest, so a tree with no edits compares equal.
 */
export async function analyzeCandidate(input: { checkoutRoot: string; treeDir: string; changedPaths: readonly string[]; rules?: MapRules; servers?: LanguageServerConfig[]; runner?: LanguageServerRunner; indexPath?: string }): Promise<{ architecture?: ProposalArchitecture; impact: ProposalImpact }> {
  const servers = input.servers ?? [];
  const extensions = servers.flatMap((s) => s.extensions);
  const candidateTree = await fingerprintTree(input.treeDir, { mode: "fs" });
  const candidateInputs = selectMapInputs(candidateTree.files, extensions);
  let candidate = extractMap(input.treeDir, candidateInputs).facts;
  let checkoutLsp: MapFacts = { modules: [], symbols: [], imports: [], usages: [], routes: [] };
  if (servers.length > 0) {
    // Language facts for the checkout come from the index the run refreshed; a language the proposal touched is run again on the candidate.
    const index = input.indexPath ? await MemoryIndex.openExisting(input.indexPath) : null;
    if (!index) throw new Error("language servers are configured but there is no map index to compare against");
    try {
      const indexed = index.readMapFacts();
      checkoutLsp = mergeFacts(servers.map((sv) => factsOfLanguage(indexed, sv.language)));
    } finally {
      index.close();
    }
    const parts: MapFacts[] = [candidate];
    for (const server of servers) {
      const touched = input.changedPaths.some((p) => server.extensions.some((e) => p.endsWith(e)));
      // Without rules nothing is judged, so a server is never started for a proposal: the blast radius
      // of changed files in this language comes from the indexed facts (who depended on what changed).
      if (!touched || !input.rules) {
        parts.push(factsOfLanguage(checkoutLsp, server.language));
        continue;
      }
      if (!input.runner) throw new Error(`the proposal changes ${server.language} files and no language server runner is available`);
      const run = await input.runner.run(server, { root: input.treeDir, files: filesWithExtensions(candidateInputs, server.extensions) });
      if (run.partial) throw new Error(`the ${server.language} server did not finish on the candidate: ${run.partial}`);
      parts.push({ modules: run.modules, symbols: run.symbols, imports: run.imports, usages: run.usages, routes: [] });
    }
    candidate = mergeFacts(parts);
  }
  const impact = impactOf(candidate, input.changedPaths);
  if (!input.rules) return { impact };
  const checkoutTs = await factsOfTree(input.checkoutRoot, await detectTreeMode(input.checkoutRoot));
  const checkout = mergeFacts([checkoutTs, checkoutLsp]);
  const diff = compareViolations(evaluateRules(checkout, input.rules), evaluateRules(candidate, input.rules));
  return { impact, architecture: { rulesSha256: rulesSha256(input.rules), ...diff } };
}

/** The map's view of a task's files for its brief; an absent index gives an empty, honest context. */
export async function briefContext(ws: Workspace, matches: (path: string) => boolean): Promise<BriefMapContext> {
  const status = await mapStatus(ws);
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  if (!index || !index.mapState()) {
    index?.close();
    return { freshness: status.freshness, files: [], truncated: false };
  }
  try {
    return contextFor(index.readMapFacts(), matches, status.freshness, index.mapState()!.snapshotId);
  } finally {
    index.close();
  }
}

/** Group by workspace package name (deepest package directory wins), else by top-level directory. */
export async function packageGrouper(ws: Workspace): Promise<(path: string) => string> {
  const current = await currentInputs(ws);
  const manifests = current.inputs.map((f) => f.path).filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const pkgs = discoverWorkspacePackages(ws.root, manifests).filter((p) => p.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  return (path: string) => pkgs.find((p) => path.startsWith(p.dir + "/"))?.name ?? (path.includes("/") ? path.split("/")[0]! + "/" : "(root)");
}

export type DiagramOutcome = { kind: "no_index"; status: MapStatus } | { kind: "drawn"; status: MapStatus; diagram: Diagram; violations: MapViolation[] };

export async function mapDiagram(ws: Workspace, options: { scope?: string; rules?: MapRules; maxNodes?: number }): Promise<DiagramOutcome> {
  const status = await mapStatus(ws);
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  if (!index || !index.mapState()) {
    index?.close();
    return { kind: "no_index", status };
  }
  let facts: MapFacts;
  try {
    facts = index.readMapFacts();
  } finally {
    index.close();
  }
  const violations = options.rules ? evaluateRules(facts, options.rules) : [];
  const diagram = renderMapDiagram(facts, { groupOf: await packageGrouper(ws), ...(options.scope !== undefined ? { scope: options.scope } : {}), ...(options.rules ? { rules: options.rules } : {}), violations, ...(options.maxNodes ? { maxNodes: options.maxNodes } : {}) });
  return { kind: "drawn", status, diagram, violations };
}
