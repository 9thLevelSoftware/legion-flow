/**
 * The one path matcher: file contracts (filesAllowed, filesForbidden) and map
 * rules (layers, forbid edges) both use it, so a path can never match a
 * contract and miss a layer written the same way.
 *
 * A pattern is a forward-slash path relative to the workspace root:
 * - ending in `/`: the directory and everything under it (`src/` matches `src/a/b.ts`);
 * - containing `*`, `**`, or `?`: a glob, where `*` and `?` stay within one path
 *   segment and `**` spans any number of segments (including none);
 * - otherwise: exactly that path.
 */
const cache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(re + "$");
  cache.set(glob, compiled);
  return compiled;
}

export function matchesPathPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(path);
  return path === pattern;
}

export function matchesAnyPathPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPathPattern(path, p));
}
