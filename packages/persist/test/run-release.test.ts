import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type GateVerdict } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, sha256Hex, newId } from "../dist/index.js";

const fp = (c: string) => "sha256:" + c.repeat(64);
const fingerprints = { spec: fp("a"), plan: fp("b"), config: fp("c") };

describe("run and release stores", () => {
  let base: string;
  let ws: Workspace;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-run-"));
    ws = Workspace.at(base);
    await ws.lock.withLock((held) => ws.project.create({ name: "R", adapterId: "fake", ownerId: "lead" }, held), "test");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("a run is created running, evidence is content-addressed, verdicts and index persist, completion flips status", async () => {
    const result = await ws.lock.withLock(async (held) => {
      const { run, dir } = await ws.runs.create({ kind: "ship", riskTier: "R1", fingerprints, requiredGates: ["approved_spec"] }, held);
      assert.equal(run.status, "running");
      assert.match(run.id, /^run_/);

      const ev = await ws.runs.writeEvidence(run.id, { hello: "world" }, held);
      // Concurrent indexed writes (the span exporter beside a node) must all land.
      await Promise.all(Array.from({ length: 12 }, (_, i) => ws.runs.writeEvidence(run.id, { concurrent: i }, held, i % 2 ? "spans" : "verdict")));
      const indexed = (await ws.runs.load(run.id))!.evidenceIndex;
      assert.equal(indexed.length, 12, "no index entry is lost to a concurrent rewrite");
      assert.match(ev.path, /^runs\/run_[0-9a-z]+\/evidence\/[0-9a-f]{64}\.json$/);
      assert.equal(sha256Hex(await readFile(ev.absolutePath)), ev.sha256);

      const verdict: GateVerdict = {
        schema: SCHEMA_VERSIONS.GATE_VERDICT,
        gateId: "approved_spec",
        riskTier: "R1",
        acceptanceIds: [],
        status: "satisfied",
        reason: "receipt matches",
        evidence: [{ path: ev.path, sha256: ev.sha256 }],
        judge: null,
        inputs: { specFingerprint: fingerprints.spec, planFingerprint: fingerprints.plan },
        evaluatedAt: new Date().toISOString(),
        waiver: null,
      };
      await ws.runs.writeVerdict(run.id, verdict, held);
      await ws.runs.writeIndex(run.id, [{ path: ev.path, sha256: ev.sha256, producedBy: "approved_spec" }], held);
      const complete = await ws.runs.complete(run.id, true, held);
      assert.equal(complete.status, "complete");
      assert.equal(complete.ready, true);
      return { run, dir, ev };
    }, "test");

    const loaded = await ws.runs.load(result.run.id);
    assert.ok(loaded);
    assert.equal(loaded.run.status, "complete");
    assert.equal(loaded.verdicts[0]?.gateId, "approved_spec");
    assert.equal(loaded.evidenceIndex.length, 1);
    assert.equal((await ws.runs.list()).length, 1);

    const verified = await ws.runs.verifyEvidence(loaded);
    assert.deepEqual(verified, { ok: true, checked: 1, drifted: [], missing: [] });

    await writeFile(result.ev.absolutePath, "{\n  \"hello\": \"tampered\"\n}\n", "utf8");
    const drifted = await ws.runs.verifyEvidence(loaded);
    assert.equal(drifted.ok, false);
    assert.deepEqual(drifted.drifted, [result.ev.path]);
  });

  test("releases record and list; writes require the workspace's lock", async () => {
    const release = {
      schema: SCHEMA_VERSIONS.RELEASE,
      id: newId("rel"),
      runId: "run_abc",
      fingerprints,
      decidedBy: { id: "lead", displayName: "lead", kind: "human" as const },
      decidedAt: new Date().toISOString(),
      source: "tty" as const,
      idempotencyKey: "k",
    };
    await ws.lock.withLock((held) => ws.releases.record(release, held), "test");
    const listed = await ws.releases.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, release.id);

    const fake = {} as never;
    await assert.rejects(ws.releases.record(release, fake), /HeldLock of this workspace/);
    await assert.rejects(ws.runs.create({ kind: "ship", riskTier: "R0", fingerprints, requiredGates: [] }, fake), /HeldLock of this workspace/);
  });
});
