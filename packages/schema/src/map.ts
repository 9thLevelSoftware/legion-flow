import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { CorroborationEpisodeSchema, LearnEpisodeSchema, ObservationEpisodeSchema, RetroEpisodeSchema, SupersessionEpisodeSchema } from "./memory.js";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RelPath = z.string().min(1).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), "a forward-slash path relative to the workspace root");

/** Built-in languages, plus `lsp` for a module a configured language server mapped (its language id is on the module). */
export const MAP_LANGUAGES = ["ts", "tsx", "dts", "js", "jsx", "lsp"] as const;
export const MAP_SYMBOL_KINDS = ["function", "class", "const", "let", "var", "type", "interface", "enum", "namespace", "default", "reexport", "reexport_all"] as const;
/** `reference` is an edge derived from a language server's references: the source uses a symbol the target declares. */
export const MAP_IMPORT_KINDS = ["static", "type", "dynamic", "require", "reexport", "reference"] as const;
/**
 * How an import was resolved: `compiler` is the TypeScript resolver landing on a
 * file in the tree; `workspace` is a workspace package found by its manifest name,
 * its entry mapped to source through that package's tsconfig rootDir and outDir
 * (independent of whether the package is built); `heuristic_src` is built output
 * mapped back to source by name (a guess, tagged so a gate can tell); `external`
 * is a package outside the tree; `unresolved` found nothing; `lsp` is an edge a
 * configured language server reported (M4 slice a3).
 */
export const MAP_RESOLUTIONS = ["compiler", "workspace", "heuristic_src", "lsp", "external", "unresolved"] as const;
export const MAP_VIAS = ["compiler", "workspace", "heuristic_src", "lsp"] as const;
export const MAP_FRESHNESS = ["fresh", "stale", "partial", "absent"] as const;
export type MapFreshness = (typeof MAP_FRESHNESS)[number];

export const MapModuleSchema = z.object({
  id: Sha256Hex,
  path: RelPath,
  sha256: Sha256Hex,
  language: z.enum(MAP_LANGUAGES),
  /** For language `lsp`: the configured language this module belongs to. */
  lspLanguage: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
}).strict();
export type MapModule = z.infer<typeof MapModuleSchema>;

export const MapSymbolSchema = z.object({
  id: Sha256Hex,
  module: RelPath,
  name: z.string().min(1),
  kind: z.enum(MAP_SYMBOL_KINDS),
  /** For a re-export: where the symbol is really declared, when the compiler could follow it. */
  origin: z.object({ module: RelPath, name: z.string().min(1), via: z.enum(MAP_VIAS) }).strict().optional(),
}).strict();
export type MapSymbol = z.infer<typeof MapSymbolSchema>;

export const MapImportSchema = z.object({
  id: Sha256Hex,
  from: RelPath,
  specifier: z.string().min(1),
  kind: z.enum(MAP_IMPORT_KINDS),
  resolution: z.enum(MAP_RESOLUTIONS),
  /** The module in the tree it lands on (compiler or heuristic_src). */
  resolved: RelPath.optional(),
  /** What the resolver really found when that is outside the tree (a built file), kept so a guess is never mistaken for a fact. */
  resolvedOutside: z.string().optional(),
  /** Package name for an external import. */
  package: z.string().optional(),
}).strict();
export type MapImport = z.infer<typeof MapImportSchema>;

/** One module's use of one exported symbol, by import binding, followed through re-exports to the declaration. */
export const MapUsageSchema = z.object({
  id: Sha256Hex,
  symbol: z.string().min(1),
  declaredIn: RelPath,
  usedBy: RelPath,
  /** heuristic_src when the declaration was found in built output and mapped back to source by name. */
  via: z.enum(MAP_VIAS),
}).strict();
export type MapUsage = z.infer<typeof MapUsageSchema>;

/** HTTP methods a route fact can carry; `all` is Express `app.all`, `any` is a Next.js pages/api handler that serves every method. */
export const MAP_ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all", "any"] as const;
/** Which syntactic pattern found a route (M4 slice g). */
export const MAP_ROUTE_DETECTORS = ["express_call", "fastify_route", "next_app", "next_pages"] as const;

/**
 * One HTTP route declared in source, found by syntax alone (M4 slice g). A path that
 * is not a string literal is recorded as unresolved with its expression text, never
 * guessed. Identity is module, method, and path (or the expression).
 */
export const MapRouteSchema = z.object({
  id: Sha256Hex,
  module: RelPath,
  method: z.enum(MAP_ROUTE_METHODS),
  /** The literal path; absent when the path is not a literal. */
  path: z.string().optional(),
  /** The path expression's source text (at most 200 characters) when it is not a literal. */
  unresolved: z.string().optional(),
  detector: z.enum(MAP_ROUTE_DETECTORS),
  line: z.number().int().min(1),
}).strict();
export type MapRoute = z.infer<typeof MapRouteSchema>;

export const MapSkipSchema = z.object({ path: RelPath, reason: z.enum(["too_large", "parse_errors", "unreadable", "reference_cap"]) }).strict();

/** What one configured language server contributed to a snapshot, so the next build can reuse it and freshness can tell it is covered. */
export const MapLanguageEntrySchema = z.object({
  language: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  extensions: z.array(z.string()),
  /** sha256: over this language's files only. */
  inputFingerprint: Fingerprint,
  /** sha256 of the server's configuration entry. */
  configSha256: Sha256Hex,
  /** From the server's initialize answer, when it gave one. */
  server: z.object({ name: z.string(), version: z.string().optional() }).strict().optional(),
  modules: z.number().int().min(0),
  /** Why this language's facts are incomplete (a timeout, a crash, a budget), when they are. */
  partial: z.string().optional(),
  /** True when the facts were carried over from the previous snapshot because nothing changed. */
  reused: z.boolean(),
  /**
   * The server-version handshake before reuse (M4 slice g): `same` reused, `changed` re-ran
   * because the server reports another version, `unavailable` re-ran because the version
   * could not be read, `skipped` when no reuse was possible anyway. Absent on older snapshots.
   */
  versionCheck: z.enum(["same", "changed", "unavailable", "skipped"]).optional(),
}).strict();
export type MapLanguageEntry = z.infer<typeof MapLanguageEntrySchema>;

export const MapFactsSchema = z.object({
  modules: z.array(MapModuleSchema),
  symbols: z.array(MapSymbolSchema),
  imports: z.array(MapImportSchema),
  usages: z.array(MapUsageSchema),
  /** HTTP routes found by syntax (M4 slice g). */
  routes: z.array(MapRouteSchema),
}).strict();
export type MapFacts = z.infer<typeof MapFactsSchema>;

/** Episodes are the durable inputs to memory; slice (a1) writes map snapshots, later slices add kinds. */
export const MapSnapshotEpisodeSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.EPISODE),
  id: z.string().regex(/^ep_[0-9a-z]+$/),
  kind: z.literal("map_snapshot"),
  createdAt: z.string().datetime(),
  treeFingerprint: Fingerprint,
  treeMode: z.enum(["fs", "git"]),
  extractorVersion: z.string().min(1),
  counts: z.object({ modules: z.number().int().min(0), symbols: z.number().int().min(0), imports: z.number().int().min(0), usages: z.number().int().min(0), routes: z.number().int().min(0).optional() }).strict(),
  skipped: z.array(MapSkipSchema),
  /** sha256 over the canonical JSON of the fact list: a rebuilt index must hash the same. */
  factsSha256: Sha256Hex,
  /** Configured language servers and what each contributed (M4 slice a3); absent when none are configured. */
  languages: z.array(MapLanguageEntrySchema).optional(),
}).strict();
export type MapSnapshotEpisode = z.infer<typeof MapSnapshotEpisodeSchema>;

export const EpisodeSchema = z.discriminatedUnion("kind", [MapSnapshotEpisodeSchema, LearnEpisodeSchema, SupersessionEpisodeSchema, RetroEpisodeSchema, ObservationEpisodeSchema, CorroborationEpisodeSchema]);
export type Episode = z.infer<typeof EpisodeSchema>;

export const MAP_QUERY_KINDS = ["deps", "impact", "who_uses", "check", "routes"] as const;
export type MapQueryKind = (typeof MAP_QUERY_KINDS)[number];

export const MapQueryResultSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.MAP_QUERY),
  query: z.object({ kind: z.enum(MAP_QUERY_KINDS), target: z.string().min(1) }).strict(),
  snapshotId: z.string().optional(),
  freshness: z.enum(MAP_FRESHNESS),
  /** deps and impact: modules with their distance from the target (1 = direct). */
  modules: z.array(z.object({ path: RelPath, depth: z.number().int().min(1), via: z.enum(MAP_RESOLUTIONS).optional() }).strict()).default([]),
  /** who_uses: the modules using the symbol. */
  usedBy: z.array(RelPath).default([]),
  /** who_uses with a bare name declared in more than one module: the candidates, never a guess. */
  candidates: z.array(z.string()).default([]),
  external: z.array(z.string()).default([]),
  /** check: every rule violation in the indexed map. */
  violations: z.array(z.lazy(() => MapViolationSchema)).default([]),
  /** routes: the route facts, filtered by a path prefix when the target is not `*`. */
  routes: z.array(MapRouteSchema).default([]),
}).strict();
export type MapQueryResult = z.infer<typeof MapQueryResultSchema>;

// ---- rules (M4 slice a2) ----

const LayerName = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const PathPattern = z.string().min(1).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), "a forward-slash pattern relative to the workspace root");

/**
 * Architecture rules in project.json `map.rules`. No schema defaults (an absent
 * field means its documented default), so adding a field to this schema never
 * shifts an existing project's config fingerprint.
 */
export const MapRulesSchema = z.object({
  /** Named groups of files; a module belongs to the first layer whose patterns match it. */
  layers: z.array(z.object({ name: LayerName, paths: z.array(PathPattern).min(1) }).strict()).min(1),
  /** For each layer, the layers it may import ("*" for any). A layer may always import itself; anything unlisted is forbidden. */
  allow: z.record(LayerName, z.array(z.union([LayerName, z.literal("*")]))).optional(),
  /** Specific forbidden edges between file patterns, whatever the layers say. */
  forbid: z.array(z.object({ from: PathPattern, to: PathPattern, reason: z.string().min(1).optional() }).strict()).optional(),
  /** For a listed layer, the only outside packages it may import (patterns use the path matcher, e.g. "@opentelemetry/*", "node:*"). */
  externalAllow: z.record(LayerName, z.array(z.string().min(1))).optional(),
  /** Outside packages no module may import, e.g. a framework the project reimplements rather than depends on. */
  externalForbid: z.array(z.string().min(1)).optional(),
  /** Forbid import cycles between modules. Default false. */
  noCycles: z.boolean().optional(),
  /** A module in no layer: ignored (default) or a violation. */
  unlayered: z.enum(["ignore", "violation"]).optional(),
  /** Leave type-only imports out of every rule. Default false: they count. */
  ignoreTypeOnly: z.boolean().optional(),
}).strict().superRefine((r, ctx) => {
  const names = r.layers.map((l) => l.name);
  const declared = new Set(names);
  if (declared.size !== names.length) ctx.addIssue({ code: "custom", message: "layer names must be unique", path: ["layers"] });
  for (const [from, tos] of Object.entries(r.allow ?? {})) {
    if (!declared.has(from)) ctx.addIssue({ code: "custom", message: `allow names unknown layer '${from}'`, path: ["allow", from] });
    for (const to of tos) if (to !== "*" && !declared.has(to)) ctx.addIssue({ code: "custom", message: `allow.${from} names unknown layer '${to}'`, path: ["allow", from] });
  }
  for (const layer of Object.keys(r.externalAllow ?? {})) if (!declared.has(layer)) ctx.addIssue({ code: "custom", message: `externalAllow names unknown layer '${layer}'`, path: ["externalAllow", layer] });
});
export type MapRules = z.infer<typeof MapRulesSchema>;

export const MAP_RULE_KINDS = ["layer", "forbid", "external_allow", "external_forbid", "cycle", "unlayered"] as const;

/** One broken rule. The id covers (rule, from, to or specifier, or the cycle's members) and never the resolution, so the same edge is the same violation in any tree. */
export const MapViolationSchema = z.object({
  id: Sha256Hex,
  rule: z.enum(MAP_RULE_KINDS),
  from: RelPath,
  to: RelPath.optional(),
  specifier: z.string().optional(),
  fromLayer: z.string().optional(),
  toLayer: z.string().optional(),
  members: z.array(RelPath).optional(),
  resolution: z.enum(MAP_RESOLUTIONS).optional(),
  detail: z.string().min(1),
}).strict();
export type MapViolation = z.infer<typeof MapViolationSchema>;

/** What a proposal does to the architecture rules: violations it introduces and resolves, compared with the checkout. */
export const ProposalArchitectureSchema = z.object({
  rulesSha256: Sha256Hex,
  introduced: z.array(MapViolationSchema),
  resolved: z.array(MapViolationSchema),
  unchanged: z.number().int().min(0),
}).strict();
export type ProposalArchitecture = z.infer<typeof ProposalArchitectureSchema>;

/** A proposal's blast radius in the candidate tree. */
export const ProposalImpactSchema = z.object({
  changedModules: z.array(RelPath),
  dependents: z.array(z.object({ path: RelPath, depth: z.number().int().min(1) }).strict()),
  dependentsCapped: z.boolean(),
  usedSymbols: z.array(z.object({ module: RelPath, name: z.string().min(1), usedBy: z.number().int().min(1) }).strict()),
}).strict();
export type ProposalImpact = z.infer<typeof ProposalImpactSchema>;

/** The map's view of a task's files, written into the task brief. */
export const BriefMapContextSchema = z.object({
  freshness: z.enum(MAP_FRESHNESS),
  snapshotId: z.string().optional(),
  files: z.array(z.object({ path: RelPath, imports: z.array(RelPath), importedBy: z.array(RelPath), exports: z.array(z.string()) }).strict()),
  truncated: z.boolean(),
}).strict();
export type BriefMapContext = z.infer<typeof BriefMapContextSchema>;

// ---- language servers (M4 slice a3) ----

const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const BUILT_IN_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * One language server in project.json `map.languageServers`. The command is an
 * argv (never a shell string); environment variables travel by name only.
 * No schema defaults, so adding a field never shifts a config fingerprint.
 */
export const LanguageServerSchema = z.object({
  language: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** File extensions this server maps, e.g. [".rs"]. TypeScript and JavaScript stay with the built-in extractor. */
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1).refine((xs) => !xs.some((x) => BUILT_IN_EXTENSIONS.includes(x)), "TypeScript and JavaScript are mapped by the built-in extractor"),
  /** The LSP languageId sent with each opened document; defaults to `language`. */
  languageId: z.string().min(1).optional(),
  command: z.string().min(1).refine((c) => !/[|&;<>`$]/.test(c), "a command, not a shell string"),
  args: z.array(z.string()).optional(),
  envKeys: z.array(EnvName).optional(),
  /** The image with the server installed, for the vm-docker tier. */
  image: z.string().min(1).optional(),
  initializationOptions: z.record(z.string(), z.unknown()).optional(),
  /** Per-server budget for start, indexing, and queries. Default 120000. */
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  /** References requested per file at most. Default 200. */
  referenceCap: z.number().int().min(1).max(10_000).optional(),
}).strict();
export type LanguageServerConfig = z.infer<typeof LanguageServerSchema>;

export const LanguageServersSchema = z.array(LanguageServerSchema).superRefine((servers, ctx) => {
  const languages = new Set<string>();
  const extensions = new Map<string, string>();
  for (const s of servers) {
    if (languages.has(s.language)) ctx.addIssue({ code: "custom", message: `language '${s.language}' is configured twice` });
    languages.add(s.language);
    for (const e of s.extensions) {
      if (extensions.has(e)) ctx.addIssue({ code: "custom", message: `extension ${e} is claimed by both ${extensions.get(e)} and ${s.language}` });
      extensions.set(e, s.language);
    }
  }
});

// ---- outbound MCP servers (M4 slice f) ----

/**
 * A stdio MCP server Legion may spawn as a tool provider (ADR-0005), in
 * project.json \`mcpServers\`. An argv, never a shell string; environment
 * variables by name only; an image for the vm-docker tier.
 */
export const McpServerConfigSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/).refine((n) => !n.includes("__"), "no '__' in a server name: the gateway names tools <server>__<tool>").refine((n) => n !== "browser", "'browser' is the tool gateway's built-in browser server; name this server something else").refine((n) => n !== "web", "'web' is the tool gateway's built-in web server; name this server something else"),
  command: z.string().min(1).refine((c) => !/[|&;<>`$]/.test(c), "a command, not a shell string"),
  args: z.array(z.string()).optional(),
  envKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional(),
  image: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** Risk classes an agent may call through the tool gateway (M4 slice k); ["read"] when unset. */
  allowRisk: z.array(z.enum(["read", "edit", "network", "create_delete"])).optional(),
  /** Tool names never exposed, whatever their risk class. */
  deny: z.array(z.string().min(1)).optional(),
}).strict();
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersSchema = z.array(McpServerConfigSchema).superRefine((servers, ctx) => {
  const names = new Set<string>();
  for (const s of servers) {
    if (names.has(s.name)) ctx.addIssue({ code: "custom", message: `MCP server '${s.name}' is declared twice` });
    names.add(s.name);
  }
});

export const TOOL_RISK_CLASSES = ["read", "edit", "create_delete", "network"] as const;

/** What probing one server found: its identity, the negotiated protocol, and each tool with its annotations mapped to a risk class. Tools are listed, never called. */
export const ToolProbeSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.TOOL_PROBE),
  server: z.string(),
  tier: z.enum(["vm-docker", "unhardened"]),
  ok: z.boolean(),
  reason: z.string().optional(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).strict().optional(),
  protocolVersion: z.string().optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    riskClass: z.enum(TOOL_RISK_CLASSES),
    /** Set when the hints contradict each other (read-only and destructive). */
    conflict: z.string().optional(),
  }).strict()),
  ms: z.number().int().min(0),
}).strict();
export type ToolProbe = z.infer<typeof ToolProbeSchema>;

/** One risk class per tool, most cautious first; a missing hint is not a promise, so no hints means edit. */
export function riskForAnnotations(a: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown } | undefined): { riskClass: (typeof TOOL_RISK_CLASSES)[number]; conflict?: string } {
  const conflict = a?.readOnlyHint === true && a?.destructiveHint === true ? "readOnlyHint and destructiveHint are both true; treated as destructive" : undefined;
  const riskClass = a?.destructiveHint === true ? "create_delete" : a?.openWorldHint === true ? "network" : a?.readOnlyHint === true ? "read" : "edit";
  return { riskClass, ...(conflict ? { conflict } : {}) };
}
