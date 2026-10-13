// The skills conformance gate: every skills/<name>/SKILL.md uses only the Agent
// Skills spec keys, `name` matches its directory, `description` is present,
// metadata is string to string, the body stays under the recommended size, no
// local absolute paths leak (Windows user-profile paths and the sibling repos' drive
// paths), a declared legion-flow.version matches the CLI package, and the generated
// host manifests match a regeneration.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseSkill } from "./skill-frontmatter.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const problems = [];
const LOCAL_PATH = /[A-Za-z]:\\Users\\|D:\\legion-(cli|ide|framework)/;
const cliVersion = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;

for (const name of readdirSync(skillsDir)) {
  const dir = join(skillsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) {
    problems.push(`${name}: no SKILL.md`);
    continue;
  }
  const { frontmatter, body, problems: parse } = parseSkill(skillPath);
  problems.push(...parse.map((p) => `${name}: ${p}`));
  if (frontmatter.name !== name) problems.push(`${name}: frontmatter name '${frontmatter.name}' does not match the directory`);
  if (!frontmatter.description) problems.push(`${name}: description is required`);
  if (frontmatter.metadata) {
    for (const [k, v] of Object.entries(frontmatter.metadata)) if (typeof v !== "string") problems.push(`${name}: metadata.${k} is not a string`);
    const declared = frontmatter.metadata["legion-flow.version"];
    if (declared !== undefined && declared !== cliVersion) problems.push(`${name}: metadata legion-flow.version '${declared}' does not match the CLI package version '${cliVersion}'`);
  }
  // The spec recommends under 5000 tokens; four characters per token is the usual rough figure.
  if (body.length > 20_000) problems.push(`${name}: body is ${body.length} characters, over the recommended size`);
  for (const file of [skillPath, ...(existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")).map((f) => join(dir, "references", f)) : [])]) {
    if (LOCAL_PATH.test(readFileSync(file, "utf8"))) problems.push(`${name}: ${file} contains a local absolute path`);
  }
}

try {
  execFileSync(process.execPath, [join(root, "scripts", "gen-skill-manifests.mjs"), "--check"], { stdio: ["ignore", "ignore", "pipe"] });
} catch (err) {
  problems.push(`generated manifests drift: ${String(err.stderr ?? "").trim() || "regenerate with node scripts/gen-skill-manifests.mjs"}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`skills check: ${p}`);
  process.exit(1);
}
console.log("skills check: ok");
