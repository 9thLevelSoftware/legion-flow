import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { MapFactsSchema } from "@9thlevelsoftware/legion-flow-schema";
import { extractMap, factsSha256, selectMapInputs, mapInputFingerprint, languageOf, MAP_MAX_FILE_BYTES } from "../dist/index.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-map-"));
  const listing: Record<string, string> = {};
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
    listing[path] = sha(body);
  }
  return { root, listing };
}

describe("map extractor", () => {
  test("modules, every export form, every import kind, re-export origins, usages through re-exports; output validates", async () => {
    const { root, listing } = await tree({
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
      "src/lib/core.ts": "export function f() { return 1; }\nexport class K {}\nexport interface I { a: number }\nexport type T = string;\nexport enum E { A }\nexport const [x, { y }] = [1, { y: 2 }];\nexport namespace NS { export const n = 1; }\nexport default function () { return 0; }\n",
      "src/index.ts": "export { f as g, K } from './lib/core.js';\nexport * from './lib/core.js';\nimport type { I } from '@lib/core.js';\nconst local = 1;\nexport { local };\nexport type { I };\n",
      "src/use.ts": "import def, { g } from './index.js';\nimport * as all from './lib/core.js';\nimport { readFileSync } from 'node:fs';\nimport z from 'zod';\nconst lazy = () => import('./lib/core.js');\nexport = { def, g, all, lazy, readFileSync, z };\n",
      "src/legacy.js": "const core = require('./lib/core.js');\nmodule.exports = core;\n",
      "README.md": "not code",
    });
    try {
      const r = extractMap(root, selectMapInputs(listing));
      MapFactsSchema.parse(r.facts);
      assert.deepEqual(r.facts.modules.map((m) => `${m.path}:${m.language}`), ["src/index.ts:ts", "src/legacy.js:js", "src/lib/core.ts:ts", "src/use.ts:ts"]);
      const core = Object.fromEntries(r.facts.symbols.filter((s) => s.module === "src/lib/core.ts").map((s) => [s.name, s.kind]));
      assert.deepEqual(core, { f: "function", K: "class", I: "interface", T: "type", E: "enum", x: "const", y: "const", NS: "namespace", default: "default" });
      const index = r.facts.symbols.filter((s) => s.module === "src/index.ts");
      const g = index.find((s) => s.name === "g")!;
      assert.equal(g.kind, "reexport");
      assert.deepEqual(g.origin, { module: "src/lib/core.ts", name: "f", via: "compiler" }, "a renamed re-export is followed to its declaration");
      assert.ok(index.some((s) => s.kind === "reexport_all"));
      assert.equal(index.find((s) => s.name === "local")?.kind, "const");

      const kinds = (from: string) => r.facts.imports.filter((i) => i.from === from).map((i) => `${i.specifier}|${i.kind}|${i.resolution}|${i.resolved ?? i.package ?? ""}`).sort();
      assert.deepEqual(kinds("src/use.ts"), [
        "./index.js|static|compiler|src/index.ts",
        "./lib/core.js|dynamic|compiler|src/lib/core.ts",
        "./lib/core.js|static|compiler|src/lib/core.ts",
        "node:fs|static|external|node:fs",
        "zod|static|external|zod",
      ]);
      assert.ok(kinds("src/index.ts").includes("@lib/core.js|type|compiler|src/lib/core.ts"), "a tsconfig path alias resolves through the compiler");
      assert.deepEqual(kinds("src/legacy.js"), ["./lib/core.js|require|compiler|src/lib/core.ts"]);

      const usedFrom = (symbol: string) => r.facts.usages.filter((u) => u.symbol === symbol).map((u) => `${u.declaredIn}<-${u.usedBy}`).sort();
      assert.deepEqual(usedFrom("f"), ["src/lib/core.ts<-src/index.ts", "src/lib/core.ts<-src/use.ts"], "use.ts imports g from index.ts, which is f from core.ts");
      assert.deepEqual(usedFrom("default"), [], "export * never re-exports a default, so the default import binds nothing and no usage is invented");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deterministic: the same tree hashes the same twice and with the input order shuffled", async () => {
    const { root, listing } = await tree({ "a.ts": "export const a = 1;\n", "b.ts": "import { a } from './a.js';\nexport const b = a;\n", "c.ts": "export * from './b.js';\nimport('./a.js');\n" });
    try {
      const inputs = selectMapInputs(listing);
      const one = factsSha256(extractMap(root, inputs).facts);
      const two = factsSha256(extractMap(root, inputs).facts);
      const shuffled = factsSha256(extractMap(root, [...inputs].reverse()).facts);
      assert.equal(one, two);
      assert.equal(one, shuffled);
      assert.equal(mapInputFingerprint(inputs), mapInputFingerprint([...inputs].reverse()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a workspace package's built output maps back to its source, tagged heuristic_src; no source file means unresolved, never invented", async () => {
    const { root, listing } = await tree({
      "packages/lib/package.json": JSON.stringify({ name: "@w/lib", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }),
      "packages/lib/src/index.ts": "export const helper = 1;\n",
      "packages/lib/dist/index.d.ts": "export declare const helper = 1;\n",
      "packages/lib/dist/index.js": "export const helper = 1;\n",
      "packages/ghost/package.json": JSON.stringify({ name: "@w/ghost", type: "module", exports: { ".": { types: "./dist/index.d.ts" } } }),
      "packages/ghost/dist/index.d.ts": "export declare const g = 1;\n",
      "packages/app/src/main.ts": "import { helper } from '@w/lib';\nimport { g } from '@w/ghost';\nexport const out = helper + g;\n",
    });
    // pnpm-style links: node_modules/@w/<name> -> packages/<name>
    const { symlink } = await import("node:fs/promises");
    await mkdir(join(root, "node_modules", "@w"), { recursive: true });
    await symlink(join(root, "packages", "lib"), join(root, "node_modules", "@w", "lib"), "junction");
    await symlink(join(root, "packages", "ghost"), join(root, "node_modules", "@w", "ghost"), "junction");
    try {
      const r = extractMap(root, selectMapInputs(listing));
      assert.ok(!r.facts.modules.some((m) => m.path.includes("/dist/")), "build output never enters the map");
      const lib = r.facts.imports.find((i) => i.specifier === "@w/lib")!;
      assert.equal(lib.resolution, "heuristic_src");
      assert.equal(lib.resolved, "packages/lib/src/index.ts");
      assert.equal(lib.resolvedOutside, "packages/lib/dist/index.d.ts");
      const ghost = r.facts.imports.find((i) => i.specifier === "@w/ghost")!;
      assert.equal(ghost.resolution, "unresolved");
      assert.equal(ghost.resolved, undefined);
      assert.equal(ghost.resolvedOutside, "packages/ghost/dist/index.d.ts");
      const usage = r.facts.usages.find((u) => u.symbol === "helper")!;
      assert.deepEqual({ declaredIn: usage.declaredIn, via: usage.via }, { declaredIn: "packages/lib/src/index.ts", via: "heuristic_src" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("files with parse errors and files over the size cap are skipped and named; other languages are not modules", async () => {
    const big = "export const s = '" + "x".repeat(MAP_MAX_FILE_BYTES) + "';\n";
    const { root, listing } = await tree({ "ok.ts": "export const ok = 1;\n", "broken.ts": "export const = ;\n", "big.ts": big, "main.py": "print(1)\n" });
    try {
      const r = extractMap(root, selectMapInputs(listing));
      assert.deepEqual(r.facts.modules.map((m) => m.path), ["ok.ts"]);
      assert.deepEqual(r.skipped, [{ path: "big.ts", reason: "too_large" }, { path: "broken.ts", reason: "parse_errors" }]);
      assert.equal(languageOf("main.py"), null);
      assert.equal(languageOf("x.d.mts"), "dts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Workspace packages resolve by manifest, so this holds before and after a build.
  test("this repository: the cli imports the schema package (by its manifest), and the measurement is recorded", async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { fingerprintTree } = await import("@9thlevelsoftware/legion-flow-persist");
    const listing = (await fingerprintTree(repo, { mode: "fs" })).files;
    const t0 = performance.now();
    const r = extractMap(repo, selectMapInputs(listing));
    const ms = Math.round(performance.now() - t0);
    const edge = r.facts.imports.find((i) => i.from === "packages/cli/src/mcp.ts" && i.specifier === "@9thlevelsoftware/legion-flow-schema");
    assert.equal(edge?.resolution, "workspace");
    assert.equal(edge?.resolved, "packages/schema/src/index.ts");
    const usage = r.facts.usages.find((u) => u.usedBy === "packages/cli/src/mcp.ts" && u.symbol === "ResultEnvelopeSchema");
    assert.equal(usage?.declaredIn, "packages/schema/src/result.ts", "a symbol re-exported by the package index is credited to its declaring file");
    console.log(`# map of this repository: ${r.facts.modules.length} modules, ${r.facts.usages.length} usages, ${ms} ms`);
  });
});
