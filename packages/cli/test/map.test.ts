import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, MapQueryResultSchema, MapSnapshotEpisodeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, mapCommand, mapStatus } from "../dist/index.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-map-cli-"));
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(join(root, "src", "lib", "core.ts"), "export function run() { return 1; }\nexport const name = 'core';\n");
  await writeFile(join(root, "src", "a.ts"), "import { run } from './lib/core.js';\nexport const a = run();\n");
  await writeFile(join(root, "src", "b.ts"), "import { a } from './a.js';\nimport { readFile } from 'node:fs';\nexport const b = [a, readFile];\n");
  await writeFile(join(root, "src", "other.ts"), "export function run() { return 2; }\n");
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: false, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "Map", owner: "lead" });
  return { root, ws, ctx };
}

const auditTypes = async (ws: Workspace) => (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type);

describe("M4 slice (a1): map", () => {
  test("build records one snapshot and one audit event; a rerun is unchanged; a lost index is re-indexed to the same hash; only source edits make it stale", async () => {
    const { root, ws, ctx } = await project();
    try {
      assert.equal((await mapStatus(ws)).freshness, "absent");
      const built = ResultEnvelopeSchema.parse(await mapCommand(ctx, {}));
      assert.equal(built.status, "ok", JSON.stringify(built.diagnostics));
      assert.ok(built.diagnostics.some((d) => d.code === "map_built"));
      const episodes = await readdir(ws.paths.episodesDir);
      assert.equal(episodes.length, 1);
      const snap = MapSnapshotEpisodeSchema.parse(JSON.parse(await readFile(join(ws.paths.episodesDir, episodes[0]!), "utf8")));
      assert.deepEqual(snap.counts, { modules: 4, symbols: 5, imports: 3, usages: 2, routes: 0 });
      assert.equal((await auditTypes(ws)).filter((t) => t === "map_built").length, 1);
      assert.equal((await mapStatus(ws)).freshness, "fresh");

      const again = await mapCommand(ctx, {});
      assert.ok(again.diagnostics.some((d) => d.code === "map_unchanged"));
      assert.equal((await readdir(ws.paths.episodesDir)).length, 1, "no new snapshot when the facts did not change");
      assert.equal((await auditTypes(ws)).filter((t) => t === "map_built").length, 1);

      await rm(ws.paths.indexSqlite, { force: true });
      await rm(ws.paths.indexSqlite + "-wal", { force: true });
      await rm(ws.paths.indexSqlite + "-shm", { force: true });
      assert.equal((await mapStatus(ws)).freshness, "absent");
      const reindexed = await mapCommand(ctx, {});
      assert.ok(reindexed.diagnostics.some((d) => d.code === "map_reindexed"), JSON.stringify(reindexed.diagnostics));
      assert.equal((await readdir(ws.paths.episodesDir)).length, 1, "the rebuilt facts hash the same, so the snapshot stands");

      await writeFile(join(root, "README.md"), "# docs only\n");
      assert.equal((await mapStatus(ws)).freshness, "fresh", "a file the map never reads does not make it stale");
      await writeFile(join(root, "src", "c.ts"), "export const c = 3;\n");
      assert.equal((await mapStatus(ws)).freshness, "stale");
      await mapCommand(ctx, {});
      assert.equal((await readdir(ws.paths.episodesDir)).length, 2);
      assert.equal((await mapStatus(ws)).freshness, "fresh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queries: deps and impact are transitive and written as a query document; who-uses answers or lists candidates; bad input is typed", async () => {
    const { root, ctx } = await project();
    try {
      const none = await mapCommand(ctx, { deps: "src/b.ts" });
      assert.equal(none.status, "blocked");
      assert.equal(none.nextAction.type === "command" && none.nextAction.run, "legion-flow map");

      await mapCommand(ctx, {});
      const deps = ResultEnvelopeSchema.parse(await mapCommand(ctx, { deps: "./src/b.ts" }));
      assert.equal(deps.status, "ok");
      const doc = deps.diagnostics.find((d) => d.code === "map_query")!;
      const result = MapQueryResultSchema.parse(JSON.parse(await readFile(doc.path!, "utf8")));
      assert.deepEqual(result.modules.map((m) => `${m.depth}:${m.path}`), ["1:src/a.ts", "2:src/lib/core.ts"]);
      assert.deepEqual(result.external, ["node:fs"]);
      assert.equal(result.freshness, "fresh");

      const impact = await mapCommand(ctx, { impact: join(root, "src", "lib", "core.ts") });
      assert.deepEqual(impact.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["1 src/a.ts", "2 src/b.ts"], "an absolute path is accepted");

      const ambiguous = await mapCommand(ctx, { whoUses: "run" });
      assert.deepEqual(ambiguous.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["candidate src/lib/core.ts#run", "candidate src/other.ts#run"]);
      const exact = await mapCommand(ctx, { whoUses: "src/lib/core.ts#run" });
      assert.deepEqual(exact.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["used by src/a.ts"]);

      const unknown = await mapCommand(ctx, { impact: "src/nope.ts" });
      assert.equal(unknown.status, "refused");
      assert.ok(unknown.diagnostics.some((d) => d.code === "map_target_unknown"));
      const two = await mapCommand(ctx, { deps: "src/a.ts", impact: "src/a.ts" });
      assert.equal(two.status, "usage_error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("map outside a project is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-map-none-"));
    try {
      const r = await mapCommand({ cwd: root, isTTY: false, workspace: Workspace.at(root) }, {});
      assert.equal(r.status, "refused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
