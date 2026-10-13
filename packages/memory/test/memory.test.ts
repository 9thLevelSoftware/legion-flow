import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { MapFacts } from "@9thlevelsoftware/legion-flow-schema";
import { MemoryIndex, INDEX_SCHEMA_VERSION, isSqliteExperimentalWarning, sqliteHealth, loadSqlite } from "../dist/index.js";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const mod = (path: string) => ({ id: h(`module\0${path}`), path, sha256: h(path), language: "ts" as const });
const imp = (from: string, to: string | null, extra: Partial<MapFacts["imports"][number]> = {}) => ({ id: h(`import\0${from}\0${to}`), from, specifier: to ? `./${to}` : "pkg", kind: "static" as const, resolution: (to ? "compiler" : "external") as "compiler" | "external", ...(to ? { resolved: to } : { package: "pkg" }), ...extra });

// a -> b -> c, d -> b, a -> pkg; symbol `run` declared in b and in d.
const facts: MapFacts = {
  modules: ["a.ts", "b.ts", "c.ts", "d.ts"].map(mod),
  symbols: [
    { id: h("s1"), module: "b.ts", name: "run", kind: "function" },
    { id: h("s2"), module: "d.ts", name: "run", kind: "const" },
    { id: h("s3"), module: "c.ts", name: "only", kind: "function" },
  ],
  imports: [imp("a.ts", "b.ts", { resolution: "heuristic_src", resolvedOutside: "dist/b.d.ts" }), imp("a.ts", null), imp("b.ts", "c.ts"), imp("d.ts", "b.ts")],
  usages: [
    { id: h("u1"), symbol: "run", declaredIn: "b.ts", usedBy: "a.ts", via: "compiler" },
    { id: h("u2"), symbol: "only", declaredIn: "c.ts", usedBy: "b.ts", via: "compiler" },
    { id: h("u3"), symbol: "only", declaredIn: "c.ts", usedBy: "d.ts", via: "compiler" },
  ],
  routes: [
    { id: h("r1"), module: "b.ts", method: "get", path: "/users", detector: "express_call", line: 3 },
    { id: h("r2"), module: "b.ts", method: "post", unresolved: "base + \"/x\"", detector: "express_call", line: 4 },
  ],
};

describe("memory index", () => {
  test("the map round-trips exactly; deps and impact walk transitively with depth; who-uses answers, or returns candidates for an ambiguous name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-memory-"));
    const path = join(dir, "var", "index.sqlite");
    try {
      assert.equal(await MemoryIndex.openExisting(path), null, "a query never creates an index");
      const index = await MemoryIndex.open(path);
      assert.equal(index.mapState(), null);
      index.replaceMap("ep_one", facts, "f".repeat(64));
      const back = index.readMapFacts();
      const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const k of ["modules", "symbols", "imports", "usages"] as const) assert.deepEqual(sortById(back[k] as { id: string }[]), sortById(facts[k] as { id: string }[]), k);
      assert.deepEqual(index.mapState(), { snapshotId: "ep_one", factsSha256: "f".repeat(64) });

      assert.deepEqual(index.deps("a.ts"), { modules: [{ path: "b.ts", depth: 1, via: "heuristic_src" }, { path: "c.ts", depth: 2, via: "compiler" }], external: ["pkg"] });
      assert.deepEqual(index.impact("c.ts").modules, [{ path: "b.ts", depth: 1, via: "compiler" }, { path: "a.ts", depth: 2, via: "heuristic_src" }, { path: "d.ts", depth: 2, via: "compiler" }]);
      assert.deepEqual(index.whoUses("only"), { usedBy: ["b.ts", "d.ts"], candidates: [] });
      assert.deepEqual(index.whoUses("run"), { usedBy: [], candidates: ["b.ts#run", "d.ts#run"] }, "an ambiguous bare name is never guessed");
      assert.deepEqual(index.whoUses("b.ts#run"), { usedBy: ["a.ts"], candidates: [] });
      assert.equal(index.hasModule("a.ts"), true);
      assert.equal(index.hasModule("zzz.ts"), false);

      index.replaceMap("ep_two", { ...facts, usages: [] }, "e".repeat(64));
      assert.deepEqual(index.whoUses("b.ts#run").usedBy, [], "a replace removes every earlier row");
      index.close();

      // The read path changes nothing on disk.
      const { readFile, stat } = await import("node:fs/promises");
      const before = { bytes: await readFile(path), mtime: (await stat(path)).mtimeMs };
      const reader = (await MemoryIndex.openExisting(path))!;
      assert.deepEqual(reader.mapState(), { snapshotId: "ep_two", factsSha256: "e".repeat(64) });
      reader.deps("a.ts");
      reader.impact("c.ts");
      reader.whoUses("only");
      assert.throws(() => reader.replaceMap("ep_three", facts, "d".repeat(64)), /readonly|read-only/i, "a read-only handle cannot write");
      reader.close();
      assert.equal((await stat(path)).mtimeMs, before.mtime);
      assert.ok((await readFile(path)).equals(before.bytes), "the index file is byte-identical after queries");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an index from another schema version is dropped and rebuilt, never migrated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-memory-v-"));
    const path = join(dir, "index.sqlite");
    try {
      const first = await MemoryIndex.open(path);
      first.replaceMap("ep_old", facts, "a".repeat(64));
      first.close();
      const { DatabaseSync } = await loadSqlite();
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(INDEX_SCHEMA_VERSION + 99));
      raw.close();
      assert.equal(await MemoryIndex.openExisting(path), null, "the read path reports an outdated index as absent and leaves it alone");
      const reopened = await MemoryIndex.open(path);
      assert.equal(reopened.mapState(), null);
      assert.equal(reopened.hasModule("a.ts"), false);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the 22.x warning filter drops only SQLite's ExperimentalWarning, in both emitWarning shapes; loading prints nothing", async () => {
    assert.equal(isSqliteExperimentalWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning"), true);
    assert.equal(isSqliteExperimentalWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" }), true);
    const err = Object.assign(new Error("SQLite is an experimental feature"), { name: "ExperimentalWarning" });
    assert.equal(isSqliteExperimentalWarning(err, undefined), true);
    assert.equal(isSqliteExperimentalWarning("VM modules are experimental", "ExperimentalWarning"), false);
    assert.equal(isSqliteExperimentalWarning("SQLite thing", "DeprecationWarning"), false);
    assert.deepEqual((await sqliteHealth()).ok, true);

    // Meaningful on Node 22.x, where the warning exists; on 24 it passes either way (ADR-0003 records the 22.23.2 run).
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-memory-w-"));
    try {
      const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js").split("\\").join("/");
      await writeFile(join(dir, "probe.mjs"), `const m = await import("file:///${dist.replace(/^\//, "")}");\nconst r = await m.sqliteHealth();\nif (!r.ok) process.exit(5);\n`);
      const { stderr } = await promisify(execFile)(process.execPath, [join(dir, "probe.mjs")]);
      assert.equal(stderr, "", `node ${process.version} printed: ${stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("proposal analysis (M4 slice a2)", () => {
  test("a sandbox copy with no edits introduces and resolves nothing, though the checkout has built output and node_modules links and the copy has neither", async () => {
    const { copyTree, fingerprintTree } = await import("@9thlevelsoftware/legion-flow-persist");
    const { mkdir, symlink } = await import("node:fs/promises");
    const { MapRulesSchema } = await import("@9thlevelsoftware/legion-flow-schema");
    const { analyzeCandidate } = await import("../dist/index.js");
    const checkout = await mkdtemp(join(tmpdir(), "legion-flow-noop-"));
    const copy = await mkdtemp(join(tmpdir(), "legion-flow-noop-copy-"));
    const files: Record<string, string> = {
      "packages/core/package.json": JSON.stringify({ name: "@w/core", type: "module", exports: { ".": { types: "./dist/index.d.ts" } } }),
      "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", rootDir: "./src", outDir: "./dist" } }),
      "packages/core/src/index.ts": "export const helper = 1;\n",
      "packages/core/dist/index.d.ts": "export declare const helper = 1;\n",
      "packages/app/src/main.ts": "import { helper } from '@w/core';\nexport const x = helper;\n",
      "packages/app/src/bad.ts": "import { x } from './main.js';\nimport '@langchain/core';\nexport const y = x;\n",
    };
    try {
      for (const [p, body] of Object.entries(files)) {
        await mkdir(dirname(join(checkout, p)), { recursive: true });
        await writeFile(join(checkout, p), body);
      }
      await mkdir(join(checkout, "node_modules", "@w"), { recursive: true });
      await symlink(join(checkout, "packages", "core"), join(checkout, "node_modules", "@w", "core"), "junction");
      await copyTree(checkout, copy, { mode: "fs" });
      const rules = MapRulesSchema.parse({ layers: [{ name: "core", paths: ["packages/core/src/**"] }, { name: "app", paths: ["packages/app/src/**"] }], allow: { app: ["core"] }, externalForbid: ["@langchain/*"] });
      const noop = await analyzeCandidate({ checkoutRoot: checkout, treeDir: copy, changedPaths: [], rules });
      assert.equal(noop.architecture?.introduced.length, 0, JSON.stringify(noop.architecture?.introduced));
      assert.equal(noop.architecture?.resolved.length, 0);
      assert.equal(noop.architecture?.unchanged, 1, "the existing forbidden package is the one unchanged violation");

      // An edit that adds a forbidden edge in the copy is introduced; removing the bad import resolves the old one.
      await writeFile(join(copy, "packages", "core", "src", "index.ts"), "import { x } from '../../app/src/main.js';\nexport const helper = x;\n");
      await writeFile(join(copy, "packages", "app", "src", "bad.ts"), "export const y = 1;\n");
      const edited = await analyzeCandidate({ checkoutRoot: checkout, treeDir: copy, changedPaths: ["packages/core/src/index.ts", "packages/app/src/bad.ts"], rules });
      assert.deepEqual(edited.architecture?.introduced.map((v) => `${v.rule}:${v.from}>${v.to}`), ["layer:packages/core/src/index.ts>packages/app/src/main.ts"]);
      assert.deepEqual(edited.architecture?.resolved.map((v) => v.rule), ["external_forbid"]);
      assert.deepEqual(edited.impact.changedModules, ["packages/app/src/bad.ts", "packages/core/src/index.ts"]);
      assert.ok(edited.impact.dependents.some((d) => d.path === "packages/app/src/main.ts"));
      void fingerprintTree;
    } finally {
      await rm(checkout, { recursive: true, force: true });
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe("language servers in the map service (M4 slice a3)", async () => {
  const { createHash: h2 } = await import("node:crypto");
  const id = (s: string) => h2("sha256").update(s).digest("hex");
  /** A scripted runner: every .fl file declares `def NAME`; another file with a line NAME uses it. */
  function scriptedRunner(calls: string[], opts: { partial?: string; version?: string | null; noHandshake?: boolean } = {}) {
    const reported = opts.version === null ? { name: "scripted" } : { name: "scripted", version: opts.version ?? "1" };
    return {
      ...(opts.noHandshake ? {} : { version: async () => reported }),
      async run(server: { language: string }, input: { root: string; files: { path: string; sha256: string }[] }) {
        calls.push(`${server.language}@${input.root}`);
        const { readFileSync } = await import("node:fs");
        const text = new Map(input.files.map((f) => [f.path, readFileSync(join(input.root, ...f.path.split("/")), "utf8")]));
        const symbols: { id: string; module: string; name: string; kind: "function" }[] = [];
        const usages: { id: string; symbol: string; declaredIn: string; usedBy: string; via: "lsp" }[] = [];
        const imports: { id: string; from: string; specifier: string; kind: "reference"; resolution: "lsp"; resolved: string }[] = [];
        for (const [path, body] of text) {
          for (const m of body.matchAll(/^def (\w+)/gm)) {
            symbols.push({ id: id(`symbol\0${path}\0${m[1]}`), module: path, name: m[1]!, kind: "function" });
            for (const [other, ob] of text) {
              if (other !== path && new RegExp(`^${m[1]}$`, "m").test(ob)) {
                usages.push({ id: id(`usage\0${path}\0${m[1]}\0${other}`), symbol: m[1]!, declaredIn: path, usedBy: other, via: "lsp" });
                imports.push({ id: id(`import\0${other}\0${path}\0reference`), from: other, specifier: path, kind: "reference", resolution: "lsp", resolved: path });
              }
            }
          }
        }
        return {
          modules: input.files.map((f) => ({ id: id(`module\0${f.path}`), path: f.path, sha256: f.sha256, language: "lsp" as const, lspLanguage: server.language })),
          symbols,
          imports,
          usages,
          capped: [],
          ...(opts.partial ? { partial: opts.partial } : {}),
          server: reported,
        };
      },
    };
  }

  const setConfig = async (ws: { paths: { projectConfig: string } }, patch: (cfg: Record<string, any>) => void) => {
    const { readFile } = await import("node:fs/promises");
    const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
    patch(cfg);
    await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  };

  test("a configured language is run once, reused while unchanged, rerun on a change or --rebuild, and a changed config makes the map stale", async () => {
    const { Workspace } = await import("@9thlevelsoftware/legion-flow-persist");
    const { buildMap, mapStatus } = await import("../dist/index.js");
    const { mkdir: mk } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "legion-flow-lsp-svc-"));
    const ws = Workspace.at(root);
    const calls: string[] = [];
    try {
      await mk(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.fl"), "def helper\n");
      await writeFile(join(root, "src", "b.fl"), "helper\n");
      await writeFile(join(root, "src", "x.ts"), "export const x = 1;\n");
      const server = { language: "fake", extensions: [".fl"], command: "fake-lsp" };
      await ws.lock.withLock(async (held) => {
        await ws.project.create({ name: "L", adapterId: "fake", ownerId: "lead" }, held);
      }, "test");
      await setConfig(ws, (cfg) => (cfg.map = { languageServers: [server] }));
      const build = (opts: Record<string, unknown> = {}) => ws.lock.withLock((held) => buildMap(ws, held, new Date(), opts), "test");

      const first = await build({ runner: scriptedRunner(calls) });
      assert.equal(calls.length, 1);
      assert.deepEqual(first.languages.map((l) => [l.language, l.modules, l.reused]), [["fake", 2, false]]);
      assert.equal(first.snapshot.counts.modules, 3, "two .fl modules beside the TypeScript one");
      assert.equal((await mapStatus(ws)).freshness, "fresh");

      const second = await build({ runner: scriptedRunner(calls) });
      assert.equal(calls.length, 1, "unchanged files, config, and server version: the facts are reused");
      assert.equal(second.kind, "unchanged");
      assert.equal(second.languages[0]?.versionCheck, "same");

      // The handshake (M4 slice g): an upgraded server runs again on the same files; one that cannot say its version runs again too.
      const upgraded = await build({ runner: scriptedRunner(calls, { version: "2" }) });
      assert.equal(calls.length, 2, "a server reporting another version runs again");
      assert.equal(upgraded.languages[0]?.versionCheck, "changed");
      assert.equal(upgraded.languages[0]?.server?.version, "2");
      const silent = await build({ runner: scriptedRunner(calls, { version: "2", noHandshake: true }) });
      assert.equal(calls.length, 3, "a runner with no handshake cannot confirm the version, so the server runs");
      assert.equal(silent.languages[0]?.versionCheck, "unavailable");
      await build({ runner: scriptedRunner(calls, { version: "2" }) });
      assert.equal(calls.length, 3, "the same version again: reused");

      await writeFile(join(root, "src", "x.ts"), "export const x = 2;\n");
      const tsOnly = await build({ runner: scriptedRunner(calls, { version: "2" }) });
      assert.equal(calls.length, 3, "a TypeScript edit does not rerun the server for another language");
      assert.equal(tsOnly.languages[0]?.reused, true);

      await writeFile(join(root, "src", "c.fl"), "helper\n");
      assert.equal((await mapStatus(ws)).freshness, "stale", "a new .fl file is a map input");
      await build({ runner: scriptedRunner(calls, { version: "2" }) });
      assert.equal(calls.length, 4);
      await build({ runner: scriptedRunner(calls, { version: "2" }), rebuild: true });
      assert.equal(calls.length, 5, "rebuild runs it again");

      await setConfig(ws, (cfg) => (cfg.map.languageServers[0].referenceCap = 5));
      const st = await mapStatus(ws);
      assert.equal(st.freshness, "stale");
      assert.match(st.reason ?? "", /configured differently/);

      const partial = await build({ runner: scriptedRunner(calls, { partial: "indexing did not settle" }) });
      assert.equal(partial.languages[0]?.partial, "indexing did not settle");
      assert.equal((await mapStatus(ws)).freshness, "partial");
      const none = await build();
      assert.match(none.languages[0]?.partial ?? "", /no language server runner/, "without a runner the files are modules and the language says why it is incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("candidate analysis runs a server only for a language the proposal changed, and a server that does not finish is an error (R0 then pauses)", async () => {
    const { Workspace, copyTree } = await import("@9thlevelsoftware/legion-flow-persist");
    const { buildMap, analyzeCandidate } = await import("../dist/index.js");
    const { MapRulesSchema } = await import("@9thlevelsoftware/legion-flow-schema");
    const { mkdir: mk } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "legion-flow-lsp-cand-"));
    const copy = await mkdtemp(join(tmpdir(), "legion-flow-lsp-cand-copy-"));
    const ws = Workspace.at(root);
    const calls: string[] = [];
    const server = { language: "fake", extensions: [".fl"], command: "fake-lsp" };
    try {
      await mk(join(root, "core"), { recursive: true });
      await mk(join(root, "ui"), { recursive: true });
      await writeFile(join(root, "core", "c.fl"), "def run\n");
      await writeFile(join(root, "ui", "u.fl"), "def show\nrun\n");
      await ws.lock.withLock(async (held) => {
        await ws.project.create({ name: "L", adapterId: "fake", ownerId: "lead" }, held);
      }, "test");
      await setConfig(ws, (cfg) => (cfg.map = { languageServers: [server] }));
      await ws.lock.withLock((held) => buildMap(ws, held, new Date(), { runner: scriptedRunner(calls) }), "test");
      await copyTree(root, copy, { mode: "fs" });
      const rules = MapRulesSchema.parse({ layers: [{ name: "core", paths: ["core/**"] }, { name: "ui", paths: ["ui/**"] }], allow: { ui: ["core"] } });
      const base = { checkoutRoot: root, treeDir: copy, rules, servers: [server], indexPath: ws.paths.indexSqlite };

      calls.length = 0;
      const untouched = await analyzeCandidate({ ...base, changedPaths: ["README.md"], runner: scriptedRunner(calls) });
      assert.equal(calls.length, 0, "no .fl file changed: the indexed language facts are reused");
      assert.equal(untouched.architecture?.introduced.length, 0);

      await writeFile(join(copy, "core", "c.fl"), "def run\nshow\n");
      const touched = await analyzeCandidate({ ...base, changedPaths: ["core/c.fl"], runner: scriptedRunner(calls) });
      assert.equal(calls.length, 1);
      assert.deepEqual(touched.architecture?.introduced.map((v) => `${v.rule}:${v.from}>${v.to}:${v.resolution}`), ["layer:core/c.fl>ui/u.fl:lsp"], "core now uses ui: a layer violation over an lsp edge");
      assert.deepEqual(touched.impact.dependents.map((d) => d.path), ["ui/u.fl"]);

      await assert.rejects(analyzeCandidate({ ...base, changedPaths: ["core/c.fl"], runner: scriptedRunner(calls, { partial: "timed out" }) }), /did not finish on the candidate/);
      calls.length = 0;
      const { rules: _omit, ...noRules } = base;
      const unjudged = await analyzeCandidate({ ...noRules, changedPaths: ["core/c.fl"], runner: scriptedRunner(calls) });
      assert.equal(calls.length, 0, "without rules a proposal never starts a server");
      assert.equal(unjudged.architecture, undefined);
      assert.deepEqual(unjudged.impact.dependents.map((d) => d.path), ["ui/u.fl"], "impact for the changed file comes from the indexed facts");
      await assert.rejects(analyzeCandidate({ ...base, changedPaths: ["core/c.fl"] }), /no language server runner/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe("facts by replay (M4 slice b)", async () => {
  const { replayFacts, conflictsFor, trueAsOf, factRowsSha256, syncFacts, currentFacts } = await import("../dist/index.js");
  const { SCHEMA_VERSIONS: V } = await import("@9thlevelsoftware/legion-flow-schema");
  const fact = (id: string, subject: string, predicate: string, text: string, validAt: string, extra: Record<string, unknown> = {}) => ({ id, subject, predicate, object: { text }, validAt, createdAt: validAt, origin: "llm" as const, ...extra });
  const ep = (id: string, body: Record<string, unknown>) => ({ schema: V.EPISODE, id, createdAt: "2026-10-09T00:00:00.000Z", ...body }) as never;

  test("learn, retro, and supersession replay into statuses; an approved replacement retires the old fact the Graphiti way; nothing is deleted", () => {
    const rows = replayFacts([
      ep("ep_a1", { kind: "learn", fact: fact("fct_1", "topic:db", "engine", "postgres", "2026-01-01T00:00:00.000Z"), status: "active", subjectVerified: true }),
      ep("ep_a2", { kind: "learn", fact: fact("fct_2", "topic:db", "engine", "sqlite", "2026-06-01T00:00:00.000Z", { supersedes: ["fct_1"] }), status: "proposed", subjectVerified: true }),
      ep("ep_a3", { kind: "learn", fact: fact("fct_3", "topic:db", "engine", "mysql", "2026-07-01T00:00:00.000Z", { supersedes: ["fct_2"] }), status: "proposed", subjectVerified: true }),
      ep("ep_a4", { kind: "supersession", newFactId: "fct_2", oldFactIds: ["fct_1"], outcome: "approved", interruptId: "int_x", createdAt: "2026-06-02T00:00:00.000Z" }),
      ep("ep_a5", { kind: "supersession", newFactId: "fct_3", oldFactIds: ["fct_2"], outcome: "rejected", interruptId: "int_y" }),
      ep("ep_a6", { kind: "retro", releaseId: "rel_1", facts: [fact("fct_4", "release:rel_1", "decided_by", "lead", "2026-08-01T00:00:00.000Z", { origin: "deterministic" })] }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { fct_1: "superseded", fct_2: "active", fct_3: "rejected", fct_4: "active" });
    assert.equal(by.fct_1.invalidAt, "2026-06-01T00:00:00.000Z", "invalid from the new fact's valid time");
    assert.equal(by.fct_1.expiredAt, "2026-06-02T00:00:00.000Z", "expired when the decision was recorded");
    assert.equal(trueAsOf(by.fct_1, "2026-03-01T00:00:00.000Z"), true, "the old fact was true before the change");
    assert.equal(trueAsOf(by.fct_1, "2026-06-15T00:00:00.000Z"), false);
    assert.equal(trueAsOf(by.fct_2, "2026-06-15T00:00:00.000Z"), true);
    assert.equal(trueAsOf(by.fct_3, "2026-08-01T00:00:00.000Z"), false, "a rejected fact is never true");
    const shuffled = replayFacts([...[
      ep("ep_a6", { kind: "retro", releaseId: "rel_1", facts: [fact("fct_4", "release:rel_1", "decided_by", "lead", "2026-08-01T00:00:00.000Z", { origin: "deterministic" })] }),
      ep("ep_a1", { kind: "learn", fact: fact("fct_1", "topic:db", "engine", "postgres", "2026-01-01T00:00:00.000Z"), status: "active", subjectVerified: true }),
    ]]);
    assert.deepEqual(shuffled.map((r) => r.id), ["fct_1", "fct_4"], "replay orders by episode id, not input order");
  });

  test("conflicts: only a declared single-valued predicate with a different object, or an explicit --supersedes; everything else coexists", () => {
    const rows = replayFacts([
      ep("ep_b1", { kind: "learn", fact: fact("fct_1", "topic:svc", "owner", "alice", "2026-01-01T00:00:00.000Z"), status: "active", subjectVerified: true }),
      ep("ep_b2", { kind: "learn", fact: fact("fct_2", "topic:svc", "uses", "redis", "2026-01-01T00:00:00.000Z"), status: "active", subjectVerified: true }),
    ]);
    const next = (predicate: string, text: string, supersedes?: string[]) => ({ subject: "topic:svc", predicate, object: { text }, ...(supersedes ? { supersedes } : {}) });
    assert.deepEqual(conflictsFor(rows, next("owner", "bob"), ["owner"]).map((r) => r.id), ["fct_1"]);
    assert.deepEqual(conflictsFor(rows, next("owner", "alice"), ["owner"]), [], "the same object is no conflict");
    assert.deepEqual(conflictsFor(rows, next("owner", "bob"), []), [], "an undeclared predicate is many-valued");
    assert.deepEqual(conflictsFor(rows, next("uses", "kafka"), ["owner"]), []);
    assert.deepEqual(conflictsFor(rows, next("uses", "kafka", ["fct_2"]), []).map((r) => r.id), ["fct_2"]);
  });

  test("the index facts tables are a replay: deleted and rebuilt, they hash the same; the read path never writes", async () => {
    const { Workspace } = await import("@9thlevelsoftware/legion-flow-persist");
    const root = await mkdtemp(join(tmpdir(), "legion-flow-facts-"));
    const ws = Workspace.at(root);
    try {
      await ws.lock.withLock(async (held) => {
        await ws.episodes.record({ schema: V.EPISODE, kind: "learn", createdAt: "2026-10-09T00:00:00.000Z", fact: fact("fct_aaa", "topic:x", "note", "first fact about search", "2026-10-09T00:00:00.000Z"), status: "active", subjectVerified: true } as never, held);
        const rows = await syncFacts(ws, held);
        const sha = factRowsSha256(rows);
        // Wipe the facts and their replay marker (Windows keeps the shared-memory file mapped, so the file is emptied, not deleted).
        const { loadSqlite: ls } = await import("../dist/index.js");
        const { DatabaseSync } = await ls();
        const raw = new DatabaseSync(ws.paths.indexSqlite);
        raw.exec("DELETE FROM facts; DELETE FROM meta WHERE key LIKE 'facts_%';");
        raw.close();
        assert.equal((await currentFacts(ws)).indexed, false, "an emptied index is not indexed; the replay still answers");
        assert.equal(factRowsSha256(await syncFacts(ws, held)), sha);
        assert.equal((await currentFacts(ws)).indexed, true);
        const index = (await MemoryIndex.openExisting(ws.paths.indexSqlite))!;
        let hits: string[];
        try {
          hits = index.searchFacts("search");
        } finally {
          index.close();
        }
        assert.deepEqual(hits, ["fct_aaa"], "FTS5 finds the fact text");
      }, "test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
