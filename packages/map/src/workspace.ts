/**
 * Workspace packages found by their manifests, independent of build state. A
 * bare specifier naming a workspace package resolves to its entry, and an entry
 * in built output maps to source through that package's own tsconfig rootDir
 * and outDir: the compiler's real mapping, not a guess by name.
 */
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";

export interface WorkspacePackage {
  name: string;
  /** Forward-slash directory relative to the root; "" for the root package. */
  dir: string;
  manifest: Record<string, unknown>;
  /** From the package's tsconfig.json, when it declares both. Absolute. */
  rootDir?: string;
  outDirs: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");
const CONDITIONS = ["types", "import", "default", "node", "require"];
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function discoverWorkspacePackages(rootAbs: string, manifestPaths: readonly string[]): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const rel of manifestPaths) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(rootAbs, ...rel.split("/")), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
    const dir = rel === "package.json" ? "" : rel.slice(0, -"/package.json".length);
    const pkg: WorkspacePackage = { name: manifest.name, dir, manifest, outDirs: [] };
    const tsconfig = join(rootAbs, ...(dir ? dir.split("/") : []), "tsconfig.json");
    if (existsSync(tsconfig)) {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      if (!read.error) {
        const opts = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig)).options;
        if (opts.rootDir) pkg.rootDir = opts.rootDir;
        for (const d of [opts.outDir, opts.declarationDir]) if (d) pkg.outDirs.push(d);
      }
    }
    out.push(pkg);
  }
  // Longest name first so "@a/b-c" is preferred over a hypothetical "@a/b" prefix match.
  return out.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1));
}

function pick(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = pick(v);
      if (p) return p;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const c of CONDITIONS) if (c in obj) {
      const p = pick(obj[c]);
      if (p) return p;
    }
  }
  return null;
}

/** The entry strings a manifest names for a subpath ("." or "./x"), most specific first. */
function entriesFor(manifest: Record<string, unknown>, subpath: string): string[] {
  const exp = manifest.exports;
  if (exp !== undefined) {
    if (typeof exp === "string" || Array.isArray(exp)) return subpath === "." ? [pick(exp)].filter((x): x is string => !!x) : [];
    if (exp && typeof exp === "object") {
      const obj = exp as Record<string, unknown>;
      const keyed = Object.keys(obj).some((k) => k.startsWith("."));
      if (!keyed) return subpath === "." ? [pick(obj)].filter((x): x is string => !!x) : [];
      if (subpath in obj) return [pick(obj[subpath])].filter((x): x is string => !!x);
      for (const key of Object.keys(obj).sort((a, b) => b.length - a.length)) {
        const star = key.indexOf("*");
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
          const target = pick(obj[key]);
          if (target) return [target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length))];
        }
      }
      return [];
    }
  }
  if (subpath === ".") return ["types", "typings", "module", "main"].map((f) => manifest[f]).filter((x): x is string => typeof x === "string");
  return [subpath.slice(2)];
}

const stripExt = (p: string) => p.replace(/\.d\.(m|c)?ts$/, "").replace(/\.(m|c)?(t|j)sx?$/, "");

/**
 * Resolve a bare specifier against the workspace packages; null when no
 * package claims it or its entry has no source file in the tree.
 */
export function resolveWorkspaceSpecifier(rootAbs: string, packages: readonly WorkspacePackage[], inTree: (rel: string) => boolean, specifier: string): string | null {
  const pkg = packages.find((p) => specifier === p.name || specifier.startsWith(p.name + "/"));
  if (!pkg) return null;
  const subpath = specifier === pkg.name ? "." : "./" + specifier.slice(pkg.name.length + 1);
  const pkgAbs = join(rootAbs, ...(pkg.dir ? pkg.dir.split("/") : []));
  for (const entry of entriesFor(pkg.manifest, subpath)) {
    const entryAbs = join(pkgAbs, entry);
    const entryRel = toPosix(relative(rootAbs, entryAbs));
    if (inTree(entryRel)) return entryRel;
    if (!pkg.rootDir) continue;
    for (const out of pkg.outDirs) {
      const within = toPosix(relative(out, entryAbs));
      if (within.startsWith("..") || /^[a-zA-Z]:/.test(within)) continue;
      const stem = stripExt(within);
      for (const ext of SOURCE_EXTS) {
        const candidate = toPosix(relative(rootAbs, join(pkg.rootDir, stem + ext)));
        if (inTree(candidate)) return candidate;
      }
    }
  }
  return null;
}
