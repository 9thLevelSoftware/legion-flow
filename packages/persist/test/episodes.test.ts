import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "../dist/index.js";

describe("episode store", () => {
  test("record mints the id under the lock and never overwrites; list returns oldest first and marks a bad file invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-episodes-"));
    const ws = Workspace.at(root);
    try {
      assert.deepEqual(await ws.episodes.list(), []);
      const draft = {
        schema: SCHEMA_VERSIONS.EPISODE,
        kind: "map_snapshot" as const,
        createdAt: "2026-10-09T12:00:00.000Z",
        treeFingerprint: "sha256:" + "a".repeat(64),
        treeMode: "fs" as const,
        extractorVersion: "test/1",
        counts: { modules: 1, symbols: 0, imports: 0, usages: 0 },
        skipped: [],
        factsSha256: "b".repeat(64),
      };
      const [one, two] = await ws.lock.withLock(async (held) => [await ws.episodes.record(draft, held), await ws.episodes.record(draft, held)], "test");
      assert.notEqual(one!.episode.id, two!.episode.id);
      await mkdir(ws.paths.episodesDir, { recursive: true });
      await writeFile(join(ws.paths.episodesDir, "ep_zzzzzzzz.json"), JSON.stringify({ ...draft, id: "ep_other" }));
      const listed = await ws.episodes.list();
      assert.deepEqual(listed.map((e) => e.kind), ["valid", "valid", "invalid"]);
      assert.equal(listed[0]!.kind === "valid" && listed[0]!.episode.id, one!.episode.id);
      await assert.rejects(() => ws.episodes.record(draft, null as never), /HeldLock/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
