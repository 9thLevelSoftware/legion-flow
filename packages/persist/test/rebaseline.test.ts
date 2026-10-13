import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../dist/index.js";

const REASON = "operator accepted a corrupted log after a disk incident";

async function workspaceWithEvents(name: string) {
  const root = await mkdtemp(join(tmpdir(), `legion-flow-rebaseline-${name}-`));
  const ws = Workspace.at(root);
  await ws.lock.withLock(async (held) => {
    await ws.project.create({ name: "R", adapterId: "fake", ownerId: "lead" }, held);
    for (let i = 0; i < 4; i++) await ws.audit.append({ type: "note", i }, held);
  }, "test");
  return { root, ws };
}

describe("audit rebaseline: the one recorded repair", () => {
  test("an edited middle line breaks verify; rebaseline keeps every parseable line as a pinned region, restarts the chain, and verify passes until the region is touched", async () => {
    const { root, ws } = await workspaceWithEvents("edit");
    try {
      const lines = (await readFile(ws.paths.eventsJsonl, "utf8")).split("\n").filter(Boolean);
      const tampered = lines[2]!.replace('"i":2', '"i":99');
      await writeFile(ws.paths.eventsJsonl, [...lines.slice(0, 2), tampered, ...lines.slice(3)].join("\n") + "\n", "utf8");
      const broken = await ws.audit.verify();
      assert.equal(broken.valid, false);
      assert.match(broken.error ?? "", /digest mismatch/i);

      const outcome = await ws.lock.withLock((held) => ws.audit.rebaseline(REASON, "lead", held, new Date("2026-10-09T10:00:00.000Z")), "test");
      assert.equal(outcome.keptLines, 4, "every parseable line is kept, tampered or not");
      assert.equal(outcome.quarantinedLines, 0);
      assert.ok(outcome.archivedChainPath?.includes("chain.before-2026-10-09T10-00-00-000Z"));
      assert.equal(outcome.state.length, 5);
      assert.equal(outcome.state.baseline?.seq, 4);
      assert.equal(outcome.priorVerify.valid, false);

      const after = await ws.audit.verify();
      assert.equal(after.valid, true, after.error);
      assert.equal(after.verifiedCount, 5);
      const last = JSON.parse((await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").at(-1)!);
      assert.equal(last.type, "audit_rebaselined");
      assert.equal(last._seq, 5);
      assert.equal(last._prevDigest, outcome.state.baseline?.priorBytesSha256);

      // The chain continues normally after the baseline.
      await ws.lock.withLock((held) => ws.audit.append({ type: "note", i: 5 }, held), "test");
      assert.equal((await ws.audit.verify()).valid, true);

      // Touching the archived region is detected.
      const now = (await readFile(ws.paths.eventsJsonl, "utf8")).split("\n");
      now[0] = now[0]!.replace('"i":0', '"i":7');
      await writeFile(ws.paths.eventsJsonl, now.join("\n"), "utf8");
      const touched = await ws.audit.verify();
      assert.equal(touched.valid, false);
      assert.match(touched.error ?? "", /archived region/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a truncated log (rewound) and appended garbage are both repaired; garbage is quarantined, not kept", async () => {
    const { root, ws } = await workspaceWithEvents("tail");
    try {
      const text = await readFile(ws.paths.eventsJsonl, "utf8");
      const lines = text.split("\n").filter(Boolean);
      await writeFile(ws.paths.eventsJsonl, lines.slice(0, 3).join("\n") + "\n", "utf8");
      assert.match((await ws.audit.verify()).error ?? "", /rewound/);
      const first = await ws.lock.withLock((held) => ws.audit.rebaseline(REASON, "lead", held), "test");
      assert.equal(first.keptLines, 3);
      assert.equal((await ws.audit.verify()).valid, true);

      await appendFile(ws.paths.eventsJsonl, "this is not json\n{\"also\":\"orphan\"}\n", "utf8");
      assert.equal((await ws.audit.verify()).valid, false);
      const second = await ws.lock.withLock((held) => ws.audit.rebaseline(REASON, "lead", held), "test");
      assert.equal(second.quarantinedLines, 2, "the unparseable line and everything after it");
      assert.ok(second.quarantinePath);
      assert.match(await readFile(second.quarantinePath!, "utf8"), /not json/);
      assert.equal((await ws.audit.verify()).valid, true);
      const names = await readdir(ws.paths.auditDir);
      assert.equal(names.filter((n) => n.startsWith("chain.before-")).length, 2, "every rebaseline archives the chain index it replaced");
      assert.equal(names.filter((n) => n.startsWith("events.quarantined-")).length, 1);

      await assert.rejects(ws.lock.withLock((held) => ws.audit.rebaseline("too short", "lead", held), "test"), /at least 24/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a corrupt chain.json verifies as invalid and is repaired by rebaseline", async () => {
    const { root, ws } = await workspaceWithEvents("chain");
    try {
      await writeFile(ws.paths.chainJson, "{ not json", "utf8");
      const bad = await ws.audit.verify();
      assert.equal(bad.valid, false);
      assert.match(bad.error ?? "", /chain.json is unreadable/);
      const outcome = await ws.lock.withLock((held) => ws.audit.rebaseline(REASON, "lead", held), "test");
      assert.equal(outcome.keptLines, 4);
      assert.equal((await ws.audit.verify()).valid, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
