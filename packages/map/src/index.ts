/**
 * The deterministic code map. A pure function from a source tree to typed
 * facts: modules, exported symbols, imports, and symbol usages. TypeScript's
 * own parser reads each file (syntax only), and its resolver and binder follow
 * imports and re-exports; no type checking, no model, no network. The same tree
 * always yields the same facts, so `factsSha256` can prove a rebuilt index.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { MapFacts, MapImport, MapModule, MapRoute, MapSymbol, MapUsage } from "@9thlevelsoftware/legion-flow-schema";
import { routesOf } from "./routes.js";
import { discoverWorkspacePackages, resolveWorkspaceSpecifier } from "./workspace.js";

export * from "./workspace.js";
export * from "./rules.js";
export * from "./graph.js";
export * from "./diagram.js";
export * from "./routes.js";

type Via = MapUsage["via"];

export const MAP_EXTRACTOR_VERSION = `legion-flow-map/3 typescript@${ts.version}`;
export const MAP_MAX_FILE_BYTES = 1024 * 1024;
/** Build output never enters the map, whatever the listing mode; imports that land there are mapped back by the tagged heuristic. */
export const MAP_EXCLUDED_DIRS: readonly string[] = ["dist", "build", "out", "coverage"];

export interface MapInputFile {
  /** Forward-slash path relative to the root. */
  path: string;
  sha256: string;
}

export interface MapSkip {
  path: string;
  reason: "too_large" | "parse_errors" | "unreadable";
}

export interface MapExtraction {
  facts: MapFacts;
  skipped: MapSkip[];
  extractorVersion: string;
}

type Language = MapModule["language"];

export function languageOf(path: string): Language | null {
  if (/\.d\.(m|c)?ts$/.test(path)) return "dts";
  if (/\.(m|c)?ts$/.test(path)) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (/\.(m|c)?js$/.test(path)) return "js";
  if (path.endsWith(".jsx")) return "jsx";
  return null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const toPosix = (p: string) => p.split(sep).join("/");

/** Canonical JSON (sorted keys) of the fact list; its sha256 is the snapshot's `factsSha256`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function factsSha256(facts: MapFacts): string {
  return sha(canonicalJson(facts));
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
};

/** The nearest tsconfig.json at or above a file's directory, stopping at the root. */
function nearestTsconfig(root: string, fileAbs: string, cache: Map<string, string | null>): string | null {
  let dir = dirname(fileAbs);
  const visited: string[] = [];
  for (;;) {
    if (cache.has(dir)) {
      const hit = cache.get(dir)!;
      for (const v of visited) cache.set(v, hit);
      return hit;
    }
    visited.push(dir);
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      for (const v of visited) cache.set(v, candidate);
      return candidate;
    }
    if (dir === root || toPosix(relative(root, dir)).startsWith("..")) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const v of visited) cache.set(v, null);
  return null;
}

function optionsFor(tsconfig: string | null): ts.CompilerOptions {
  let options: ts.CompilerOptions = { ...DEFAULT_OPTIONS };
  if (tsconfig) {
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
      options = { ...parsed.options };
      if (options.moduleResolution === undefined) {
        options.module ??= ts.ModuleKind.NodeNext;
        options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
      }
    }
  }
  // The map binds and resolves; it never type-checks or emits. Skipping the standard
  // library and ambient types keeps one program per config fast and independent of
  // what happens to be installed globally.
  return { ...options, allowJs: true, noEmit: true, noLib: true, types: [], skipLibCheck: true, declaration: false, declarationMap: false, sourceMap: false, composite: false, incremental: false };
}

function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier.split("/")[0]!;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const BUILD_DIRS = ["dist", "lib", "build", "out"];
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function extractMap(root: string, input: readonly MapInputFile[]): MapExtraction {
  const rootAbs = resolve(root);
  const inTree = new Map<string, MapInputFile>();
  const manifests: string[] = [];
  for (const f of input) {
    if (f.path.split("/").some((s) => MAP_EXCLUDED_DIRS.includes(s))) continue;
    if (languageOf(f.path)) inTree.set(f.path, f);
    else if (f.path === "package.json" || f.path.endsWith("/package.json")) manifests.push(f.path);
  }
  manifests.sort();
  const workspacePackages = discoverWorkspacePackages(rootAbs, manifests);
  const skipped: MapSkip[] = [];
  const parseable: MapInputFile[] = [];
  for (const f of [...inTree.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    try {
      const size = statSync(join(rootAbs, ...f.path.split("/"))).size;
      if (size > MAP_MAX_FILE_BYTES) skipped.push({ path: f.path, reason: "too_large" });
      else parseable.push(f);
    } catch {
      skipped.push({ path: f.path, reason: "unreadable" });
    }
  }

  const relOf = (abs: string): string | null => {
    const rel = toPosix(relative(rootAbs, abs));
    return rel.startsWith("..") || rel === "" || /^[a-zA-Z]:/.test(rel) ? null : rel;
  };

  /**
   * A path under the root but outside the tree (a workspace package's built
   * output) mapped back to its source by name: <pkg>/dist/x.d.ts -> <pkg>/src/x.ts.
   * A guess, so it is tagged; when no source file matches, nothing is invented.
   */
  const heuristicSource = (outsideRel: string): string | null => {
    const parts = outsideRel.split("/");
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!BUILD_DIRS.includes(parts[i]!)) continue;
      const pkgDir = parts.slice(0, i).join("/");
      if (!existsSync(join(rootAbs, ...(pkgDir ? pkgDir.split("/") : []), "package.json"))) continue;
      const stem = parts.slice(i + 1).join("/").replace(/\.d\.(m|c)?ts$/, "").replace(/\.(m|c)?(t|j)sx?$/, "");
      for (const ext of SOURCE_EXTS) {
        const candidate = `${pkgDir ? pkgDir + "/" : ""}src/${stem}${ext}`;
        if (inTree.has(candidate)) return candidate;
      }
      return null;
    }
    return null;
  };

  // Group by nearest tsconfig so each program resolves with the options its files are compiled with.
  const tsconfigCache = new Map<string, string | null>();
  const groups = new Map<string, MapInputFile[]>();
  for (const f of parseable) {
    const key = nearestTsconfig(rootAbs, join(rootAbs, ...f.path.split("/")), tsconfigCache) ?? "";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const modules: MapModule[] = [];
  const symbols = new Map<string, MapSymbol>();
  const imports = new Map<string, MapImport>();
  const usages = new Map<string, MapUsage>();
  const routes = new Map<string, MapRoute>();
  const pendingUsages: { usedBy: string; module: string; name: string }[] = [];
  const pendingOrigins: { module: string; name: string; target: string; targetName: string }[] = [];

  for (const key of [...groups.keys()].sort()) {
    const files = groups.get(key)!;
    const options = optionsFor(key || null);
    const host = ts.createCompilerHost(options, true);
    const program = ts.createProgram({ rootNames: files.map((f) => join(rootAbs, ...f.path.split("/"))), options, host });
    const checker = program.getTypeChecker();
    const resolutionCache = ts.createModuleResolutionCache(rootAbs, (s) => s, options);

    const resolveSpecifier = (specifier: string, containingAbs: string): Pick<MapImport, "resolution" | "resolved" | "resolvedOutside" | "package"> => {
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
      // Manifests first: the same answer whether or not the package is built, and whether or not node_modules exists.
      if (bare) {
        const ws = resolveWorkspaceSpecifier(rootAbs, workspacePackages, (rel) => inTree.has(rel), specifier);
        if (ws) return { resolution: "workspace", resolved: ws };
      }
      const result = ts.resolveModuleName(specifier, containingAbs, options, host, resolutionCache).resolvedModule;
      if (!result) return bare ? { resolution: "external", package: packageName(specifier) } : { resolution: "unresolved" };
      const abs = host.realpath ? host.realpath(result.resolvedFileName) : result.resolvedFileName;
      const rel = relOf(abs);
      if (rel && inTree.has(rel)) return { resolution: "compiler", resolved: rel };
      if (!rel || rel.split("/").includes("node_modules")) return { resolution: "external", package: packageName(specifier) };
      const guess = heuristicSource(rel);
      return guess ? { resolution: "heuristic_src", resolved: guess, resolvedOutside: rel } : { resolution: "unresolved", resolvedOutside: rel };
    };

    /** Where a symbol is really declared, in tree terms; null when it lives outside the tree. */
    const declaredIn = (node: ts.Node): { module: string; name: string; via: Via } | null => {
      let symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return null;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = checker.getAliasedSymbol(symbol);
        } catch {
          return null;
        }
      }
      const decl = symbol.declarations?.[0];
      if (!decl) return null;
      const rel = relOf(host.realpath ? host.realpath(decl.getSourceFile().fileName) : decl.getSourceFile().fileName);
      if (!rel) return null;
      const direct = inTree.has(rel);
      const module = direct ? rel : rel.split("/").includes("node_modules") ? null : heuristicSource(rel);
      if (!module) return null;
      const name = symbol.escapedName === "default" || symbol.escapedName === "export=" ? "default" : symbol.name;
      return { module, name, via: direct ? "compiler" : "heuristic_src" };
    };

    for (const f of files) {
      const abs = join(rootAbs, ...f.path.split("/"));
      const sf = program.getSourceFile(abs);
      if (!sf) {
        skipped.push({ path: f.path, reason: "unreadable" });
        continue;
      }
      if (program.getSyntacticDiagnostics(sf).length > 0) {
        skipped.push({ path: f.path, reason: "parse_errors" });
        continue;
      }
      modules.push({ id: sha(`module\0${f.path}`), path: f.path, sha256: f.sha256, language: languageOf(f.path)! });

      const addSymbol = (name: string, kind: MapSymbol["kind"], origin?: { module: string; name: string; via: Via }) => {
        const id = sha(`symbol\0${f.path}\0${name}`);
        if (!symbols.has(id)) symbols.set(id, { id, module: f.path, name, kind, ...(origin && (origin.module !== f.path || origin.name !== name) ? { origin } : {}) });
      };
      const addImport = (specifier: string, kind: MapImport["kind"]): MapImport => {
        const id = sha(`import\0${f.path}\0${specifier}\0${kind}`);
        if (!imports.has(id)) imports.set(id, { id, from: f.path, specifier, kind, ...resolveSpecifier(specifier, abs) });
        return imports.get(id)!;
      };
      const addUsage = (node: ts.Node) => {
        const target = declaredIn(node);
        if (!target || target.module === f.path) return;
        const id = sha(`usage\0${target.module}\0${target.name}\0${f.path}`);
        if (!usages.has(id)) usages.set(id, { id, symbol: target.name, declaredIn: target.module, usedBy: f.path, via: target.via });
      };

      for (const stmt of sf.statements) {
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : [];
        const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const imp = addImport(stmt.moduleSpecifier.text, stmt.importClause?.isTypeOnly ? "type" : "static");
          const clause = stmt.importClause;
          if (imp.resolution === "workspace") {
            // Credited by name through our own symbol facts after every file is read, never through built output.
            if (clause?.name) pendingUsages.push({ usedBy: f.path, module: imp.resolved!, name: "default" });
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) pendingUsages.push({ usedBy: f.path, module: imp.resolved!, name: (el.propertyName ?? el.name).text });
            continue;
          }
          if (clause?.name) addUsage(clause.name);
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) addUsage(el.name);
          continue;
        }
        if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference) && ts.isStringLiteral(stmt.moduleReference.expression)) {
          addImport(stmt.moduleReference.expression.text, "require");
          continue;
        }
        if (ts.isExportDeclaration(stmt)) {
          const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
          const reexported = spec ? addImport(spec, "reexport") : null;
          if (reexported?.resolution === "workspace" && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
              addSymbol(el.name.text, "reexport");
              pendingOrigins.push({ module: f.path, name: el.name.text, target: reexported.resolved!, targetName: (el.propertyName ?? el.name).text });
            }
            continue;
          }
          if (!stmt.exportClause) {
            if (spec) addSymbol(`* from ${spec}`, "reexport_all");
          } else if (ts.isNamedExports(stmt.exportClause)) {
            for (const el of stmt.exportClause.elements) {
              const origin = declaredIn(el.name) ?? undefined;
              if (spec) {
                addSymbol(el.name.text, "reexport", origin);
                if (origin) addUsage(el.name);
              } else {
                addSymbol(el.name.text, origin && origin.module !== f.path ? "reexport" : "const", origin);
              }
            }
          } else if (spec) {
            addSymbol(stmt.exportClause.name.text, "reexport");
          }
          continue;
        }
        if (ts.isExportAssignment(stmt)) {
          addSymbol("default", "default");
          continue;
        }
        if (!exported) continue;
        const named = (n: ts.Identifier | undefined, kind: MapSymbol["kind"]) => addSymbol(isDefault || !n ? "default" : n.text, isDefault ? "default" : kind);
        if (ts.isFunctionDeclaration(stmt)) named(stmt.name, "function");
        else if (ts.isClassDeclaration(stmt)) named(stmt.name, "class");
        else if (ts.isInterfaceDeclaration(stmt)) named(stmt.name, "interface");
        else if (ts.isTypeAliasDeclaration(stmt)) named(stmt.name, "type");
        else if (ts.isEnumDeclaration(stmt)) named(stmt.name, "enum");
        else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) named(stmt.name, "namespace");
        else if (ts.isVariableStatement(stmt)) {
          const flags = stmt.declarationList.flags;
          const kind: MapSymbol["kind"] = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
          const names = (b: ts.BindingName): string[] => (ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : names(e.name))));
          for (const d of stmt.declarationList.declarations) for (const n of names(d.name)) addSymbol(n, kind);
        }
      }

      // Dynamic import() and require() anywhere in the file, string literal specifiers only.
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addImport((node.arguments[0] as ts.StringLiteralLike).text, "dynamic");
          else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) addImport((node.arguments[0] as ts.StringLiteralLike).text, "require");
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      for (const r of routesOf(sf, f.path)) routes.set(r.id, r);
    }
  }

  // Workspace bindings: follow our own symbol facts (named re-exports, then export * chains) to the declaration.
  const symbolAt = new Map<string, MapSymbol>();
  for (const s of symbols.values()) symbolAt.set(`${s.module}\0${s.name}`, s);
  const resolveExport = (module: string, name: string, depth = 0): { module: string; name: string } | null => {
    if (depth > 16) return null;
    const pending = pendingOrigins.find((p) => p.module === module && p.name === name);
    if (pending) return resolveExport(pending.target, pending.targetName, depth + 1);
    const s = symbolAt.get(`${module}\0${name}`);
    if (s && s.kind !== "reexport_all") return s.origin ? { module: s.origin.module, name: s.origin.name } : { module, name };
    if (name === "default") return null;
    for (const star of [...symbols.values()].filter((x) => x.module === module && x.kind === "reexport_all").sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const spec = star.name.slice("* from ".length);
      const imp = [...imports.values()].find((i) => i.from === module && i.kind === "reexport" && i.specifier === spec);
      if (!imp?.resolved) continue;
      const hit = resolveExport(imp.resolved, name, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const p of pendingOrigins) {
    const target = resolveExport(p.target, p.targetName);
    const s = symbolAt.get(`${p.module}\0${p.name}`);
    if (s && target) s.origin = { module: target.module, name: target.name, via: "workspace" };
  }
  for (const p of pendingUsages) {
    const target = resolveExport(p.module, p.name);
    if (!target || target.module === p.usedBy) continue;
    const id = sha(`usage\0${target.module}\0${target.name}\0${p.usedBy}`);
    if (!usages.has(id)) usages.set(id, { id, symbol: target.name, declaredIn: target.module, usedBy: p.usedBy, via: "workspace" });
  }

  return { facts: sortFacts({ modules, symbols: [...symbols.values()], imports: [...imports.values()], usages: [...usages.values()], routes: [...routes.values()] }), skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : 1)), extractorVersion: MAP_EXTRACTOR_VERSION };
}

/** The one fact order: the extractor, a merge with language-server facts, and the index read-back all use it, so their hashes agree. */
export function sortFacts(facts: MapFacts): MapFacts {
  const byPath = <T extends { id: string }>(xs: Iterable<T>, key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1));
  return {
    modules: byPath(facts.modules, (m) => m.path),
    symbols: byPath(facts.symbols, (s) => `${s.module}\0${s.name}`),
    imports: byPath(facts.imports, (i) => `${i.from}\0${i.specifier}\0${i.kind}`),
    usages: byPath(facts.usages, (u) => `${u.declaredIn}\0${u.symbol}\0${u.usedBy}`),
    routes: byPath(facts.routes, (r) => `${r.module}\0${r.method}\0${r.path ?? "\uffff" + (r.unresolved ?? "")}`),
  };
}

const isResolutionInput = (p: string) => /(^|\/)(package\.json|tsconfig(\.[^/]+)?\.json)$/.test(p);

/** The files the map reads, from a full tree listing: source files plus the manifests and tsconfigs that decide resolution; build output excluded. */
export function selectMapInputs(files: Record<string, string>, serverExtensions: readonly string[] = []): MapInputFile[] {
  return Object.keys(files)
    .filter((p) => (languageOf(p) || isResolutionInput(p) || serverExtensions.some((e) => p.endsWith(e))) && !p.split("/").some((s) => MAP_EXCLUDED_DIRS.includes(s)))
    .sort()
    .map((path) => ({ path, sha256: files[path]! }));
}

/** `sha256:` over the (path, sha256) lines of the map's inputs: freshness ignores files the map never reads. */
export function mapInputFingerprint(inputs: readonly MapInputFile[]): string {
  const h = createHash("sha256");
  for (const f of [...inputs].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${f.sha256}\n`);
  return "sha256:" + h.digest("hex");
}

/** The files one language server maps, from the map inputs. */
export function filesWithExtensions(inputs: readonly MapInputFile[], extensions: readonly string[]): MapInputFile[] {
  return inputs.filter((f) => extensions.some((e) => f.path.endsWith(e)));
}
