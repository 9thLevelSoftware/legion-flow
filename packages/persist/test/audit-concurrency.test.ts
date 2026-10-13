import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../dist/index.js";

test("concurrent appends inside one held lock (parallel runs) keep the chain intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-audit-par-"));
  const ws = Workspace.at(root);
  try {
    await ws.lock.withLock(async (held) => {
      await ws.project.create({ name: "A", adapterId: "fake", ownerId: "lead" }, held);
      await Promise.all(Array.from({ length: 24 }, (_, i) => ws.audit.append({ type: "parallel_probe", i }, held)));
    }, "test");
    const verified = await ws.audit.verify();
    assert.equal(verified.valid, true, JSON.stringify(verified));
    assert.ok(verified.verifiedCount >= 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
