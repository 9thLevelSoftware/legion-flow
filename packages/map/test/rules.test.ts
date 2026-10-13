import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { MapRulesSchema, matchesPathPattern, type MapRules } from "@9thlevelsoftware/legion-flow-schema";
import { extractMap, selectMapInputs, factsSha256, evaluateRules, compareViolations, importCycles, impactOf, contextFor, renderMapDiagram, rulesSha256 } from "../dist/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-rules-"));
  const listing: Record<string, string> = {};
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
    listing[path] = sha(body);
  }
  return { root, listing };
}

/** Two workspace packages with tsconfig rootDir/outDir, never built, no node_modules. */
const workspaceFixture = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "packages/core/package.json": JSON.stringify({ name: "@w/core", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./extra": { types: "./dist/extra.d.ts" } } }),
  "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", rootDir: "./src", outDir: "./dist" } }),
  "packages/core/src/index.ts": "export * from './impl.js';\nexport { helper as renamed } from './impl.js';\n",
  "packages/core/src/impl.ts": "export function helper() { return 1; }\nexport const value = 2;\n",
  "packages/core/src/extra.ts": "export const extra = 3;\n",
  "packages/app/package.json": JSON.stringify({ name: "@w/app", type: "module", dependencies: { "@w/core": "workspace:*" } }),
  "packages/app/tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", rootDir: "./src", outDir: "./dist" } }),
  "packages/app/src/main.ts": "import { helper, renamed } from '@w/core';\nimport { extra } from '@w/core/extra';\nimport { z } from 'zod';\nexport const out = [helper(), renamed(), extra, z];\n",
};

describe("workspace resolution by manifest", () => {
  test("never built and no node_modules: imports resolve to source, usages follow export * and renamed re-exports, all tagged workspace", async () => {
    const { root, listing } = await tree(workspaceFixture);
    try {
      const r = extractMap(root, selectMapInputs(listing));
      const imp = (spec: string) => r.facts.imports.find((i) => i.from === "packages/app/src/main.ts" && i.specifier === spec)!;
      assert.deepEqual({ res: imp("@w/core").resolution, to: imp("@w/core").resolved }, { res: "workspace", to: "packages/core/src/index.ts" });
      assert.deepEqual({ res: imp("@w/core/extra").resolution, to: imp("@w/core/extra").resolved }, { res: "workspace", to: "packages/core/src/extra.ts" });
      assert.equal(imp("zod").resolution, "external");
      const used = r.facts.usages.filter((u) => u.usedBy === "packages/app/src/main.ts").map((u) => `${u.declaredIn}#${u.symbol}:${u.via}`).sort();
      assert.deepEqual(used, ["packages/core/src/extra.ts#extra:workspace", "packages/core/src/impl.ts#helper:workspace"], "helper (through export *) and renamed (through a renamed re-export) are both credited to impl.ts#helper");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the decisive no-op: the same sources with built output and node_modules links map to the same facts as a bare copy", async () => {
    const bare = await tree(workspaceFixture);
    const built = await tree({ ...workspaceFixture, "packages/core/dist/index.d.ts": "export * from './impl.js';\n", "packages/core/dist/impl.d.ts": "export declare function helper(): number;\n" });
    const { symlink } = await import("node:fs/promises");
    await mkdir(join(built.root, "node_modules", "@w"), { recursive: true });
    await symlink(join(built.root, "packages", "core"), join(built.root, "node_modules", "@w", "core"), "junction");
    try {
      const a = extractMap(bare.root, selectMapInputs(bare.listing));
      const b = extractMap(built.root, selectMapInputs(built.listing));
      assert.equal(factsSha256(b.facts), factsSha256(a.facts), "built output and node_modules change nothing the map records");
    } finally {
      await rm(bare.root, { recursive: true, force: true });
      await rm(built.root, { recursive: true, force: true });
    }
  });
});

describe("one path matcher for contracts and rules", () => {
  test("exact, directory prefix, and globs", () => {
    const cases: [string, string, boolean][] = [
      ["src/a.ts", "src/a.ts", true],
      ["src/a.ts", "src/b.ts", false],
      ["src/x/y.ts", "src/", true],
      ["srcx/y.ts", "src/", false],
      ["packages/cli/src/a.ts", "packages/*/src/**", true],
      ["packages/cli/src/deep/a.ts", "packages/*/src/**", true],
      ["packages/cli/test/a.ts", "packages/*/src/**", false],
      ["a.ts", "**/*.ts", true],
      ["x/y/a.ts", "**/*.ts", true],
      ["x/y/a.js", "**/*.ts", false],
      ["src/a1.ts", "src/a?.ts", true],
      ["src/a/1.ts", "src/a?.ts", false],
      ["@opentelemetry/api", "@opentelemetry/*", true],
      ["node:fs", "node:*", true],
    ];
    for (const [path, pattern, expected] of cases) assert.equal(matchesPathPattern(path, pattern), expected, `${path} vs ${pattern}`);
  });
});

describe("architecture rules", () => {
  const facts = {
    modules: ["ui/a.ts", "ui/b.ts", "core/c.ts", "core/d.ts", "db/e.ts", "misc/f.ts"].map((path) => ({ id: sha(path), path, sha256: sha(path), language: "ts" as const })),
    symbols: [{ id: sha("s"), module: "core/c.ts", name: "run", kind: "function" as const }],
    imports: [
      { from: "ui/a.ts", to: "core/c.ts" },
      { from: "core/c.ts", to: "db/e.ts" },
      { from: "ui/b.ts", to: "db/e.ts" },
      { from: "core/c.ts", to: "core/d.ts" },
      { from: "core/d.ts", to: "core/c.ts" },
      { from: "db/e.ts", to: "core/d.ts", kind: "type" as const },
    ].map((e) => ({ id: sha(e.from + e.to), from: e.from, specifier: "./x", kind: e.kind ?? ("static" as const), resolution: "compiler" as const, resolved: e.to }))
      .concat([
        { id: sha("ext1"), from: "core/c.ts", specifier: "lodash", kind: "static" as const, resolution: "external" as const, package: "lodash" } as never,
        { id: sha("ext2"), from: "ui/a.ts", specifier: "@langchain/core", kind: "static" as const, resolution: "external" as const, package: "@langchain/core" } as never,
      ]),
    usages: [{ id: sha("u"), symbol: "run", declaredIn: "core/c.ts", usedBy: "ui/a.ts", via: "compiler" as const }],
    routes: [],
  };
  const rules: MapRules = MapRulesSchema.parse({
    layers: [{ name: "ui", paths: ["ui/**"] }, { name: "core", paths: ["core/**"] }, { name: "db", paths: ["db/**"] }],
    allow: { ui: ["core"], core: ["db"] },
    forbid: [{ from: "ui/**", to: "db/**", reason: "the UI never touches storage" }],
    externalAllow: { core: ["node:*"] },
    externalForbid: ["@langchain/*"],
    noCycles: true,
    unlayered: "violation",
  });

  test("every rule kind fires once per edge, with stable ids, and cycles come from Tarjan", () => {
    const v = evaluateRules(facts, rules);
    const summary = v.map((x) => `${x.rule}:${x.from}${x.to ? ">" + x.to : x.specifier ? ">" + x.specifier : ""}`).sort();
    assert.deepEqual(summary, [
      "cycle:core/c.ts",
      "external_allow:core/c.ts>lodash",
      "external_forbid:ui/a.ts>@langchain/core",
      "forbid:ui/b.ts>db/e.ts",
      "layer:db/e.ts>core/d.ts",
      "layer:ui/b.ts>db/e.ts",
      "unlayered:misc/f.ts",
    ]);
    assert.deepEqual(v.find((x) => x.rule === "cycle")?.members, ["core/c.ts", "core/d.ts", "db/e.ts"], "the type-only db -> core edge closes a cycle through all three");
    assert.deepEqual(evaluateRules(facts, rules).map((x) => x.id), v.map((x) => x.id), "deterministic");
    const typeFree = evaluateRules(facts, { ...rules, ignoreTypeOnly: true });
    assert.ok(!typeFree.some((x) => x.rule === "layer" && x.from === "db/e.ts"), "ignoreTypeOnly drops the type-only edge");
    assert.equal(rulesSha256(rules), rulesSha256(MapRulesSchema.parse(JSON.parse(JSON.stringify(rules)))));
  });

  test("a violation's identity ignores resolution, so the same edge compares equal across trees", () => {
    const viaWorkspace = { ...facts, imports: facts.imports.map((i) => (i.resolution === "compiler" ? { ...i, resolution: "workspace" as const } : i)) };
    const diff = compareViolations(evaluateRules(facts, rules), evaluateRules(viaWorkspace, rules));
    assert.deepEqual({ introduced: diff.introduced.length, resolved: diff.resolved.length }, { introduced: 0, resolved: 0 });
    const fixed = { ...facts, imports: facts.imports.filter((i) => !(i.from === "ui/b.ts")) };
    const after = compareViolations(evaluateRules(facts, rules), evaluateRules(fixed, rules));
    assert.deepEqual(after.resolved.map((x) => x.rule).sort(), ["forbid", "layer"]);
    assert.equal(after.introduced.length, 0);
  });

  test("rules referring to unknown layers are refused by the schema", () => {
    assert.throws(() => MapRulesSchema.parse({ layers: [{ name: "a", paths: ["a/**"] }], allow: { a: ["ghost"] } }), /unknown layer/);
    assert.throws(() => MapRulesSchema.parse({ layers: [{ name: "a", paths: ["a/**"] }, { name: "a", paths: ["b/**"] }] }), /unique/);
  });

  test("cycles: none in a DAG, one component per strongly connected set", () => {
    assert.deepEqual(importCycles(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }]), []);
    assert.deepEqual(importCycles(["a", "b", "c", "d"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "c", to: "d" }, { from: "d", to: "c" }]), [["a", "b"], ["c", "d"]]);
  });

  test("impact is transitive and capped; the context slice is one level each way", () => {
    const imp = impactOf(facts, ["db/e.ts"]);
    assert.deepEqual(imp.dependents.map((d) => `${d.depth}:${d.path}`), ["1:core/c.ts", "1:ui/b.ts", "2:core/d.ts", "2:ui/a.ts"]);
    assert.equal(imp.dependentsCapped, false);
    assert.equal(impactOf(facts, ["db/e.ts"], 1).dependentsCapped, true);
    assert.deepEqual(impactOf(facts, ["core/c.ts"]).usedSymbols, [{ module: "core/c.ts", name: "run", usedBy: 1 }]);
    const ctx = contextFor(facts, (p) => p === "core/c.ts", "fresh", "ep_x");
    assert.deepEqual(ctx.files[0], { path: "core/c.ts", imports: ["core/d.ts", "db/e.ts"], importedBy: ["core/d.ts", "ui/a.ts"], exports: ["run"] });
  });

  test("diagrams: package level groups with layer boxes, a red cycle, a dashed violation; module level collapses the outside; the cap is stated", () => {
    const groupOf = (p: string) => p.split("/")[0] + "/";
    const violations = evaluateRules(facts, rules);
    const pkg = renderMapDiagram(facts, { groupOf, rules, violations });
    assert.equal(pkg.level, "package");
    assert.match(pkg.mermaid, /^flowchart LR/);
    assert.match(pkg.mermaid, /subgraph L_ui\["layer ui"\]/);
    assert.match(pkg.mermaid, /stroke-dasharray/, "the ui -> db violation is dashed");
    assert.deepEqual(pkg.cycles, [["core/", "db/"]], "core and db import each other at package level");
    const mod = renderMapDiagram(facts, { groupOf, scope: "core" });
    assert.equal(mod.level, "module");
    assert.match(mod.mermaid, /core\/c\.ts/);
    assert.match(mod.mermaid, /"db\/"/, "outside modules collapse into their group");
    const capped = renderMapDiagram(facts, { groupOf, maxNodes: 2 });
    assert.equal(capped.nodes, 2);
    assert.ok(capped.omitted.length > 0);
    assert.match(capped.mermaid, /omitted over the cap of 2/);
  });
});

describe("this repository holds to its own architecture", () => {
  test("the package dependency direction and the no-framework rule from CLAUDE.md: zero violations", async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { fingerprintTree } = await import("@9thlevelsoftware/legion-flow-persist");
    const r = extractMap(repo, selectMapInputs((await fingerprintTree(repo, { mode: "fs" })).files));
    const pkg = (name: string) => ({ name, paths: [`packages/${name}/src/**`] });
    // Written from the real imports (code wins), then checked against the documented direction.
    const rules = MapRulesSchema.parse({
      layers: [pkg("schema"), pkg("persist"), pkg("map"), pkg("memory"), pkg("gates"), pkg("engine"), pkg("evidence"), pkg("evals"), pkg("egress"), pkg("adapters"), pkg("sandbox"), pkg("lsp"), pkg("browser"), pkg("cli"), { name: "tests", paths: ["packages/*/test/**"] }],
      allow: {
        persist: ["schema"],
        map: ["schema"],
        memory: ["schema", "persist", "map"],
        gates: ["schema", "persist", "memory", "browser"],
        browser: ["schema", "engine"],
        engine: ["schema", "persist"],
        evidence: ["schema", "persist"],
        evals: ["schema"],
        egress: ["schema"],
        adapters: ["schema", "persist", "engine", "egress"],
        sandbox: ["schema", "persist", "engine", "egress"],
        lsp: ["schema"],
        cli: ["*"],
        tests: ["*"],
      },
      externalAllow: {
        schema: ["zod"],
        map: ["typescript", "node:*"],
        memory: ["node:*"],
        egress: ["node:*"],
        lsp: ["node:*"],
        browser: ["playwright-core", "node:*"],
      },
      externalForbid: ["@langchain/*", "langgraph", "@mastra/*", "@cognee/*", "cognee", "@browser_use/*", "browser-use", "deepeval", "mcp-use"],
      noCycles: true,
    });
    const violations = evaluateRules(r.facts, rules);
    assert.deepEqual(violations.map((v) => `${v.rule} ${v.from} ${v.to ?? v.specifier ?? (v.members ?? []).join(",")}`), []);
  });
});
