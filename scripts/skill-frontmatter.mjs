// The one frontmatter reader the generator and the check share. A declared
// subset of YAML, by design: top-level `key: value` lines and one nested
// `metadata:` block of two-space-indented string pairs. Anything else fails,
// which is how "metadata is string to string" and "only the spec keys" are
// enforced without a YAML dependency.
import { readFileSync } from "node:fs";

export const SPEC_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Returns { frontmatter, body, problems }. */
export function parseSkill(path) {
  const text = readFileSync(path, "utf8");
  const problems = [];
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, problems: ["no frontmatter block"] };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text, problems: ["frontmatter block is not closed"] };
  const lines = text.slice(4, end).split("\n");
  const body = text.slice(end + 5);
  const frontmatter = {};
  let inMetadata = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (inMetadata && line.startsWith("  ")) {
      const m = /^  ([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      if (!m) {
        problems.push(`metadata line is not a string pair: ${line}`);
        continue;
      }
      frontmatter.metadata[m[1]] = unquote(m[2]);
      continue;
    }
    inMetadata = false;
    const m = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (!m) {
      problems.push(`not a top-level key: ${line}`);
      continue;
    }
    const [, key, value] = m;
    if (!SPEC_KEYS.has(key)) problems.push(`'${key}' is not an Agent Skills spec key`);
    if (key === "metadata") {
      if (value.trim().length > 0) problems.push("metadata must be a nested block of string pairs");
      frontmatter.metadata = {};
      inMetadata = true;
      continue;
    }
    frontmatter[key] = unquote(value);
  }
  return { frontmatter, body, problems };
}
