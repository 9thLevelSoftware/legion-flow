// Generates the host manifests from the one skills tree. Deterministic: no
// timestamps, sorted keys, so the gate can compare a regeneration byte for byte.
// Usage: node scripts/gen-skill-manifests.mjs [--check]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill } from "./skill-frontmatter.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const pkg = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));

function skills() {
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory() && existsSync(join(skillsDir, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, ...parseSkill(join(skillsDir, name, "SKILL.md")) }));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
const json = (value) => JSON.stringify(stable(value), null, 2) + "\n";

export function generate() {
  const list = skills();
  const description = "Legion Flow: a governed workflow engine for coding agents. Host agents drive the loop and stop at every human decision.";
  const files = {
    // Shape copied from an installed Claude Code plugin (.claude-plugin/plugin.json).
    ".claude-plugin/plugin.json": json({
      name: "legion-flow",
      version: pkg.version,
      description,
      author: { name: "9th Level Software" },
      license: "MIT",
      keywords: ["workflow", "governance", "sandbox", "coding-agents"],
      skills: list.map((s) => `./skills/${s.name}`),
    }),
    // Shape from an installed marketplace (.claude-plugin/marketplace.json); a relative-path source is what `claude plugin validate` accepts for a local plugin.
    ".claude-plugin/marketplace.json": json({
      name: "legion-flow",
      owner: { name: "9th Level Software" },
      plugins: [{ name: "legion-flow", description, author: { name: "9th Level Software" }, category: "engineering", source: "./" }],
    }),
    // Gemini CLI extension manifest: shape from the research only, unverified against a Gemini host.
    "gemini-extension.json": json({ name: "legion-flow", version: pkg.version, description, contextFileName: "skills/AGENTS.md" }),
    // The fallback for hosts without Agent Skills. Lives inside the tree: a root AGENTS.md would read as instructions for this repository.
    "skills/AGENTS.md": [
      "# Legion Flow skills (fallback for hosts without Agent Skills)",
      "",
      "Generated from the skills tree by scripts/gen-skill-manifests.mjs; do not edit by hand.",
      "",
      // A skill body links its references relative to its own directory; from this file they live one level down.
      ...list.flatMap((s) => [`## ${s.frontmatter.name}`, "", s.frontmatter.description, "", s.body.trim().replaceAll("`references/", `\`${s.name}/references/`), ""]),
    ].join("\n"),
  };
  return files;
}

const check = process.argv.includes("--check");
let drift = 0;
for (const [rel, content] of Object.entries(generate())) {
  const path = join(root, ...rel.split("/"));
  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== content) {
      console.error(`skills: ${rel} differs from a regeneration; run node scripts/gen-skill-manifests.mjs`);
      drift += 1;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    console.log(`wrote ${rel}`);
  }
}
if (check && drift > 0) process.exit(1);
