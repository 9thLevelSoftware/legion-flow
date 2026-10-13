/**
 * `map`: build the deterministic code map, and answer three questions about it.
 * The snapshot episode in project/ is the durable record; the facts live only
 * in var/index.sqlite and are proved against the snapshot by their hash.
 */
import { spawnAllowed } from "@9thlevelsoftware/legion-flow-sandbox";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSIONS, MapQueryResultSchema, type LanguageServerConfig, type MapQueryKind, type MapRules, type Diagnostic, type ResultEnvelope } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { MAP_EXTRACTOR_VERSION } from "@9thlevelsoftware/legion-flow-map";
import { buildMap, checkArchitecture, mapDiagram, mapStatus, runMapQuery, type LanguageServerRunner, type MapStatus } from "@9thlevelsoftware/legion-flow-memory";
import type { LspTier } from "./lsp-runner.js";

/** Mermaid for the HTML page, loaded by the viewer's browser; the tool itself never fetches it. */
export const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
const DIAGRAM_MARKER = "<!-- legion-flow map --diagram: generated; rerun to refresh, edits here are overwritten -->";

const RESULT_LINES = 25;

function freshnessDiagnostic(s: MapStatus): Diagnostic {
  const severity = s.freshness === "fresh" ? "info" : "warning";
  return { code: "map_freshness", severity, message: `Map is ${s.freshness}${s.snapshot ? ` (snapshot ${s.snapshot.id})` : ""}${s.reason ? `: ${s.reason}` : ""}.`, ...(s.freshness === "fresh" ? {} : { hint: "Run legion-flow map to rebuild it." }) };
}

export interface MapOptions {
  deps?: string;
  impact?: string;
  whoUses?: string;
  /** HTTP route facts: true for all, or a URL path prefix (starting with /) or a module path or directory. */
  routes?: string | boolean;
  check?: boolean;
  diagram?: boolean;
  scope?: string;
  out?: string;
  /** Where configured language servers run: vm-docker (default) or unhardened (terminal only, with allowNoSandbox). */
  sandbox?: string;
  allowNoSandbox?: boolean;
  /** Run every language server again instead of reusing unchanged languages. */
  rebuild?: boolean;
}

export interface MapBuildContext {
  isTTY: boolean;
  /** project.json sandbox.require (M4 slice j1): language servers never run on the host. */
  requireSandbox?: boolean;
  servers: LanguageServerConfig[];
  runnerFor: (tier: LspTier) => LanguageServerRunner;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function diagramHtml(title: string, caption: string, mermaid: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code map</title>
<style>
:root { --bg: #ffffff; --fg: #1a1a1a; --muted: #555555; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --fg: #ececec; --muted: #a8a8a8; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
h1 { font-size: 1.2rem; margin: 0 0 4px; }
p { color: var(--muted); margin: 0 0 16px; }
.mermaid { overflow-x: auto; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(caption)}</p>
<pre class="mermaid">${escapeHtml(mermaid)}</pre>
<script type="module">
import mermaid from "${MERMAID_CDN}";
mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
</script>
</body>
</html>
`;
}

type Envelope = (command: string, status: ResultEnvelope["status"], diagnostics: Diagnostic[], nextAction: ResultEnvelope["nextAction"]) => Promise<ResultEnvelope>;

/** The `map` verb. `envelope` supplies phase and the status next action, owned by commands.ts. */
export async function mapVerb(ws: Workspace, opts: MapOptions, envelope: Envelope, statusNext: () => Promise<ResultEnvelope["nextAction"]>, rules?: MapRules, build: MapBuildContext = { isTTY: false, servers: [], runnerFor: () => ({ run: async () => { throw new Error("no runner"); } }) }): Promise<ResultEnvelope> {
  if ((opts.sandbox !== undefined || opts.allowNoSandbox || opts.rebuild) && Object.keys(opts).some((k) => ["deps", "impact", "whoUses", "routes", "check", "diagram"].includes(k) && (opts as Record<string, unknown>)[k] !== undefined && (opts as Record<string, unknown>)[k] !== false)) {
    return envelope("map", "usage_error", [{ code: "map_build_only", severity: "error", message: "--sandbox, --allow-no-sandbox, and --rebuild apply to building the map (bare map) only." }], { type: "command", run: "legion-flow map" });
  }
  const asked = (["deps", "impact", "whoUses", "routes", "check", "diagram"] as const).filter((k) => opts[k] !== undefined && opts[k] !== false);
  if (asked.length > 1) {
    return envelope("map", "usage_error", [{ code: "map_one_query", severity: "error", message: "Ask one thing at a time: --deps, --impact, --who-uses, --routes, --check, or --diagram." }], { type: "command", run: "legion-flow map --deps <path>" });
  }
  if ((opts.scope !== undefined || opts.out !== undefined) && !opts.diagram) {
    return envelope("map", "usage_error", [{ code: "map_diagram_only", severity: "error", message: "--scope and --out apply to --diagram only." }], { type: "command", run: "legion-flow map --diagram" });
  }

  if (opts.check) {
    if (!rules) return envelope("map", "refused", [{ code: "map_rules_absent", severity: "error", message: "The project declares no map.rules; there is nothing to check.", hint: "Add map.rules to project.json (layers, allow, forbid, externalAllow, externalForbid, noCycles); rules change the config fingerprint, so approvals are made again." }], await statusNext());
    const check = await checkArchitecture(ws, rules, { requireFresh: false });
    if (check.kind === "not_fresh") return envelope("map", "blocked", [freshnessDiagnostic(check.status), { code: "map_absent", severity: "error", message: "There is no map index to check.", hint: "Run legion-flow map first." }], { type: "command", run: "legion-flow map" });
    const doc = MapQueryResultSchema.parse({ schema: SCHEMA_VERSIONS.MAP_QUERY, query: { kind: "check", target: `rules:${check.rulesSha256.slice(0, 16)}` }, snapshotId: check.snapshotId, freshness: check.status.freshness, violations: check.violations });
    const bytes = JSON.stringify(doc, null, 2) + "\n";
    const path = join(ws.paths.cacheMapDir, `check-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
    await mkdir(ws.paths.cacheMapDir, { recursive: true });
    await atomicWriteFile(path, bytes);
    const diagnostics: Diagnostic[] = [
      freshnessDiagnostic(check.status),
      { code: "map_check", severity: check.violations.length ? "error" : "info", message: `${check.violations.length} rule violation(s) in snapshot ${check.snapshotId}.`, path },
      ...check.violations.slice(0, RESULT_LINES).map((v) => ({ code: "map_violation", severity: "error" as const, message: `${v.rule}: ${v.from}${v.to ? ` -> ${v.to}` : v.specifier ? ` -> ${v.specifier}` : v.members ? ` (${v.members.length} modules)` : ""}: ${v.detail}${v.resolution && v.resolution !== "compiler" ? ` [${v.resolution}]` : ""}.` })),
      ...(check.violations.length > RESULT_LINES ? [{ code: "map_results_truncated", severity: "info" as const, message: `${check.violations.length - RESULT_LINES} more in the check document.`, path }] : []),
    ];
    return envelope("map", check.violations.length ? "blocked" : "ok", diagnostics, check.violations.length ? { type: "command", run: "legion-flow map --check", hint: "Fix the violations (or change the rules, which needs new approvals), then check again." } : await statusNext());
  }

  if (opts.diagram) {
    const scope = opts.scope !== undefined ? opts.scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") : undefined;
    const drawn = await mapDiagram(ws, { ...(scope !== undefined ? { scope } : {}), ...(rules ? { rules } : {}) });
    if (drawn.kind === "no_index") return envelope("map", "blocked", [freshnessDiagnostic(drawn.status), { code: "map_absent", severity: "error", message: "There is no map index to draw.", hint: "Run legion-flow map first." }], { type: "command", run: "legion-flow map" });
    const d = drawn.diagram;
    if (d.nodes === 0) return envelope("map", "refused", [freshnessDiagnostic(drawn.status), { code: "map_scope_empty", severity: "error", message: `No mapped module is under '${scope}'.`, hint: "Pass a workspace-relative directory such as packages/cli/src." }], await statusNext());
    const name = d.level === "package" ? "diagram-packages" : `diagram-module-${(scope ?? "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const title = d.level === "package" ? "Package dependencies" : `Modules under ${scope}`;
    const caption = `Map snapshot ${drawn.status.snapshot?.id ?? "(none)"}, ${drawn.status.freshness}; ${d.nodes} nodes, ${d.edges} edges (labels count imports); ${d.cycles.length} cycle(s) in red; ${drawn.violations.length} rule violation(s), drawn red and dashed where they join two nodes.${d.omitted.length ? ` ${d.omitted.length} node(s) omitted over the cap.` : ""}`;
    await mkdir(ws.paths.cacheMapDir, { recursive: true });
    const mmd = join(ws.paths.cacheMapDir, `${name}.mmd`);
    const html = join(ws.paths.cacheMapDir, `${name}.html`);
    await atomicWriteFile(mmd, d.mermaid);
    await atomicWriteFile(html, diagramHtml(title, caption, d.mermaid));
    const diagnostics: Diagnostic[] = [
      freshnessDiagnostic(drawn.status),
      { code: "map_diagram", severity: "info", message: `${title}: ${caption}`, path: html },
      { code: "map_diagram_source", severity: "info", message: "Mermaid source (renders on GitHub as a mermaid code block).", path: mmd },
      ...(d.omitted.length ? [{ code: "map_diagram_omitted", severity: "info" as const, message: `Omitted: ${d.omitted.slice(0, 10).join(", ")}${d.omitted.length > 10 ? ", ..." : ""}.` }] : []),
    ];
    if (opts.out !== undefined) {
      const target = isAbsolute(opts.out) ? opts.out : resolve(ws.root, opts.out);
      const rel = relative(ws.root, target).split(sep).join("/");
      if (rel.startsWith("..") || isAbsolute(rel) || rel.startsWith(".legion-flow/") || !rel.endsWith(".md")) {
        return envelope("map", "refused", [...diagnostics, { code: "map_out_rejected", severity: "error", message: `--out must be a .md file inside the workspace and outside .legion-flow/ (got '${opts.out}').` }], await statusNext());
      }
      const existing = await readFile(target, "utf8").catch(() => null);
      if (existing !== null && !existing.startsWith(DIAGRAM_MARKER)) {
        return envelope("map", "refused", [...diagnostics, { code: "map_out_not_generated", severity: "error", message: `${rel} exists and was not written by map --diagram; it is never overwritten.`, hint: "Choose another path, or delete the file yourself." }], await statusNext());
      }
      await mkdir(resolve(target, ".."), { recursive: true });
      await atomicWriteFile(target, `${DIAGRAM_MARKER}\n\n# ${title}\n\n${caption}\n\n\`\`\`mermaid\n${d.mermaid}\`\`\`\n`);
      diagnostics.push({ code: "map_diagram_out", severity: "info", message: `Wrote ${rel}.`, path: target });
    }
    return envelope("map", "ok", diagnostics, await statusNext());
  }
  if (asked.length === 1) {
    const key = asked[0] as "deps" | "impact" | "whoUses" | "routes";
    const query: MapQueryKind = key === "whoUses" ? "who_uses" : key;
    const outcome = await runMapQuery(ws, query, key === "routes" && opts.routes === true ? "*" : String(opts[key]));
    if (outcome.kind === "no_index") {
      return envelope("map", "blocked", [freshnessDiagnostic(outcome.status), { code: "map_absent", severity: "error", message: "There is no map index to query.", hint: "Run legion-flow map first." }], { type: "command", run: "legion-flow map", hint: "Build the map, then ask again." });
    }
    if (outcome.kind === "unknown_target") {
      return envelope("map", "refused", [freshnessDiagnostic(outcome.status), { code: "map_target_unknown", severity: "error", message: `'${outcome.target}' is not a module in the map.`, hint: "Pass a workspace-relative source path such as packages/cli/src/cli.ts; a newly added file needs legion-flow map first." }], await statusNext());
    }
    const r = outcome.result;
    const bytes = JSON.stringify(r, null, 2) + "\n";
    const path = join(ws.paths.cacheMapDir, `query-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
    await mkdir(ws.paths.cacheMapDir, { recursive: true });
    await atomicWriteFile(path, bytes);
    const routeLine = (x: (typeof r.routes)[number]) => `${x.method.toUpperCase()} ${x.path ?? `(unresolved: ${x.unresolved})`} ${x.module}:${x.line} [${x.detector}]`;
    const lines: string[] =
      query === "routes"
        ? r.routes.map(routeLine)
        : query === "who_uses"
        ? r.candidates.length > 0
          ? r.candidates.map((c) => `candidate ${c}`)
          : r.usedBy.map((u) => `used by ${u}`)
        : [...r.modules.map((m) => `${m.depth} ${m.path}${m.via === "heuristic_src" ? " (heuristic_src)" : ""}`), ...r.external.map((e) => `external ${e}`)];
    const count = query === "routes" ? `${r.routes.length} route(s)${r.routes.some((x) => x.path === undefined) ? `, ${r.routes.filter((x) => x.path === undefined).length} with an unresolved path` : ""}` : query === "who_uses" ? (r.candidates.length > 0 ? `${r.candidates.length} candidate declaration(s); ask again with path#name` : `${r.usedBy.length} module(s)`) : `${r.modules.length} module(s)${r.external.length ? `, ${r.external.length} external package(s)` : ""}`;
    const diagnostics: Diagnostic[] = [
      freshnessDiagnostic(outcome.status),
      { code: "map_query", severity: "info", message: `${query.replace("_", "-")} ${r.query.target}: ${count}.`, path },
      ...lines.slice(0, RESULT_LINES).map((message) => ({ code: "map_result", severity: "info" as const, message })),
      ...(lines.length > RESULT_LINES ? [{ code: "map_results_truncated", severity: "info" as const, message: `${lines.length - RESULT_LINES} more in the query document.`, path }] : []),
    ];
    return envelope("map", "ok", diagnostics, await statusNext());
  }

  return ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") {
        return envelope("map", "refused", [{ code: "project_not_initialized", severity: "error", message: "The map is recorded in a project; none is initialized here." }], { type: "command", run: "legion-flow init --adapter <id>" });
      }
      // Configured language servers: refuse before anything runs when the tier cannot host them.
      const tier = (opts.sandbox ?? "vm-docker") as LspTier;
      if (tier !== "vm-docker" && tier !== "unhardened") {
        return envelope("map", "usage_error", [{ code: "map_sandbox_unknown", severity: "error", message: `--sandbox must be vm-docker or unhardened (got '${opts.sandbox}').` }], { type: "command", run: "legion-flow map" });
      }
      if (build.servers.length > 0) {
        const policy = spawnAllowed({ kind: "language_server", tier, hardened: tier === "vm-docker", ...(build.requireSandbox ? { require: true } : {}) });
        if (!policy.ok) return envelope("map", "refused", [{ code: policy.code, severity: "error", message: policy.message, hint: policy.hint }], await statusNext());
      }
      if (build.servers.length > 0 && tier === "unhardened" && (!opts.allowNoSandbox || !build.isTTY)) {
        return envelope("map", "refused", [{ code: opts.allowNoSandbox ? "sandbox_confirmation_requires_tty" : "sandbox_not_hardened", severity: "error", message: "Running language servers on the host is not a sandbox: some (rust-analyzer, gopls) run project code.", hint: "FIX: re-run with --allow-no-sandbox on a terminal to accept that, or use the default vm-docker tier with an image per server." }], await statusNext());
      }
      if (build.servers.length > 0 && tier === "vm-docker") {
        const missing = build.servers.filter((s) => !s.image).map((s) => s.language);
        if (missing.length > 0) {
          return envelope("map", "refused", [{ code: "language_server_image_missing", severity: "error", message: `Language server(s) ${missing.join(", ")} have no image for the vm-docker tier.`, hint: "FIX: set map.languageServers[].image to an image with the server installed, or run legion-flow map --sandbox unhardened --allow-no-sandbox on a terminal." }], await statusNext());
        }
      }
      const built = await buildMap(ws, held, new Date(), { ...(build.servers.length ? { runner: build.runnerFor(tier) } : {}), ...(opts.rebuild ? { rebuild: true } : {}) });
      const s = built.snapshot;
      const status = await mapStatus(ws);
      const verb = built.kind === "built" ? "Recorded" : built.kind === "reindexed" ? "Re-indexed" : "Unchanged";
      const diagnostics: Diagnostic[] = [
        { code: `map_${built.kind}`, severity: "info", message: `${verb} map snapshot ${s.id}: ${s.counts.modules} modules, ${s.counts.symbols} exported symbols, ${s.counts.imports} imports, ${s.counts.usages} symbol usages, ${s.counts.routes ?? 0} HTTP routes in ${built.ms} ms (${s.extractorVersion}).`, path: join(ws.paths.episodesDir, `${s.id}.json`) },
        freshnessDiagnostic(status),
        { code: "map_index", severity: "info", message: "Facts are cached in the index; their hash matches the snapshot.", path: ws.paths.indexSqlite },
        ...s.skipped.slice(0, RESULT_LINES).map((k) => ({ code: "map_skipped", severity: "warning" as const, message: `${k.path}: ${k.reason.replace("_", " ")}.` })),
        ...built.languages.map((l) => ({
          code: l.partial ? "map_language_partial" : "map_language",
          severity: l.partial ? ("warning" as const) : ("info" as const),
          message: `Language '${l.language}' (${l.extensions.join(", ")}): ${l.modules} module(s)${l.server ? `, ${l.server.name}${l.server.version ? ` ${l.server.version}` : ""}` : ""}${l.reused ? `, reused from the previous snapshot (unchanged files and configuration; server version ${l.versionCheck === "same" ? "confirmed the same" : "unavailable, no runner to re-run it"}; --rebuild runs it again)` : `, ${tier}${l.versionCheck === "changed" ? "; run again because the server reports another version" : l.versionCheck === "unavailable" ? "; run again because the server version could not be confirmed" : ""}`}${l.partial ? `; incomplete: ${l.partial}` : ""}.`,
        })),
      ];
      return envelope("map", "ok", diagnostics, await statusNext());
  }, "map");
}

export { MAP_EXTRACTOR_VERSION };
