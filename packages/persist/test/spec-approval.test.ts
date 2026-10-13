import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Approval } from "@9thlevelsoftware/legion-flow-schema";
import {
  Workspace,
  canonicalJson,
  fingerprintRecord,
  configFingerprint,
  specFingerprint,
  newId,
  type HeldLock,
} from "../dist/index.js";

describe("fingerprints", () => {
  test("canonical JSON sorts keys recursively and ignores formatting", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" }, u: undefined };
    const b = { a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(fingerprintRecord(a), fingerprintRecord(b));
    assert.equal(canonicalJson({ a: 1 }), '{"a":1}');
  });

  test("the config fingerprint excludes the current pointer", () => {
    const base = {
      schema: SCHEMA_VERSIONS.PROJECT,
      id: "prj_x",
      name: "X",
      decisionOwners: [{ id: "h", displayName: "H", kind: "human" as const }],
      riskPolicyVersion: "risk-policy/v1",
      defaultRiskTier: "R1" as const,
      controlMode: "guarded" as const,
      adapter: { default: "fake" },
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    assert.equal(configFingerprint(base), configFingerprint({ ...base, current: { specId: "spc_abc" } }));
    assert.notEqual(configFingerprint(base), configFingerprint({ ...base, name: "Y" }));
  });

  test("ids are unique within one millisecond and carry their prefix", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId("spc")));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^spc_[0-9a-z]+$/);
  });
});

describe("spec store, approval store, and phase derivation", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-spec-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function initialized(name: string): Promise<Workspace> {
    const ws = Workspace.at(join(base, name));
    await ws.lock.withLock(
      (held) => ws.project.create({ name, adapterId: "fake", ownerId: "lead" }, held),
      "test"
    );
    return ws;
  }

  const receiptFor = (ws: Workspace, specFp: string, configFp: string, specId: string): Approval => ({
    schema: SCHEMA_VERSIONS.APPROVAL,
    id: newId("apv"),
    subject: "spec",
    subjectId: specId,
    fingerprints: { spec: specFp, config: configFp },
    decidedBy: { id: "lead", displayName: "lead", kind: "human" },
    decidedAt: new Date().toISOString(),
    source: "tty",
    idempotencyKey: `${ws.root}:${specId}:approve.spec:${specFp}`,
  });

  test("create, load, fingerprint: reformatting spec.json changes nothing, editing either half changes it", async () => {
    const ws = await initialized("fp");
    const created = await ws.lock.withLock((held) => ws.specs.create("Login flow", held), "test");
    assert.match(created.spec.id, /^spc_/);

    const loaded = await ws.specs.load(created.spec.id);
    assert.equal(loaded.kind, "valid");
    if (loaded.kind !== "valid") return;
    assert.equal(loaded.fingerprint, created.fingerprint);
    assert.equal(loaded.spec.title, "Login flow");
    assert.match(loaded.markdown, /^# Login flow/);

    const jsonPath = join(loaded.dir, "spec.json");
    await writeFile(jsonPath, JSON.stringify(JSON.parse(await readFile(jsonPath, "utf8"))), "utf8"); // reformat only
    const reformatted = await ws.specs.load(created.spec.id);
    assert.equal(reformatted.kind === "valid" && reformatted.fingerprint, created.fingerprint);

    await appendFile(join(loaded.dir, "SPEC.md"), "\nOne more sentence.\n");
    const editedMd = await ws.specs.load(created.spec.id);
    assert.notEqual(editedMd.kind === "valid" && editedMd.fingerprint, created.fingerprint);

    const spec = JSON.parse(await readFile(jsonPath, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "User can log in", kind: "behavior" }];
    await writeFile(jsonPath, JSON.stringify(spec, null, 2), "utf8");
    const editedJson = await ws.specs.load(created.spec.id);
    assert.equal(editedJson.kind, "valid");
    if (editedJson.kind !== "valid") return;
    assert.notEqual(editedJson.fingerprint, editedMd.kind === "valid" ? editedMd.fingerprint : "");
    assert.equal(editedJson.spec.acceptanceCriteria[0]?.surface, "unit", "schema defaults apply on read");
    assert.equal(specFingerprint(editedJson.spec, editedJson.markdown), editedJson.fingerprint);
  });

  test("load reports absent, malformed, schema-invalid, and an id that disagrees with its directory", async () => {
    const ws = await initialized("invalid");
    assert.equal((await ws.specs.load("spc_nothing")).kind, "absent");

    const created = await ws.lock.withLock((held) => ws.specs.create("X", held), "test");
    const jsonPath = join(created.dir, "spec.json");
    await writeFile(jsonPath, "{ nope", "utf8");
    const malformed = await ws.specs.load(created.spec.id);
    assert.equal(malformed.kind === "invalid" && malformed.cause, "malformed_json");

    await writeFile(jsonPath, JSON.stringify({ ...created.spec, id: "spc_other" }), "utf8");
    const mismatch = await ws.specs.load(created.spec.id);
    assert.equal(mismatch.kind === "invalid" && mismatch.cause, "schema");
    assert.match(mismatch.kind === "invalid" ? mismatch.detail : "", /directory says/);
  });

  test("phase: initialized, then spec_draft, then spec_frozen on a matching receipt, then draft again with a reason after an edit", async () => {
    const ws = await initialized("phase");
    const p0 = await ws.project.load();
    assert.equal(p0.kind === "valid" && p0.phase, "initialized");

    const created = await ws.lock.withLock(async (held) => {
      const c = await ws.specs.create("Flow", held);
      await ws.project.setCurrent({ specId: c.spec.id }, held);
      return c;
    }, "test");
    const p1 = await ws.project.load();
    assert.equal(p1.kind === "valid" && p1.phase, "spec_draft");
    assert.equal(p1.kind === "valid" && p1.config.current?.specId, created.spec.id);

    const current = await ws.specs.current();
    assert.equal(current?.kind, "valid");
    if (!current || current.kind !== "valid" || p1.kind !== "valid") return;

    const configFp = configFingerprint(p1.config);
    const receipt = receiptFor(ws, current.fingerprint, configFp, created.spec.id);
    await ws.lock.withLock((held) => ws.approvals.record(receipt, held), "test");
    const found = await ws.approvals.forSubject("spec", created.spec.id);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, receipt.id);

    const p2 = await ws.project.load();
    assert.equal(p2.kind === "valid" && p2.phase, "spec_frozen");
    assert.deepEqual(p2.kind === "valid" ? p2.phaseReasons : null, []);

    // Moving the pointer again (same spec) must not invalidate: config fingerprint excludes `current`.
    await ws.lock.withLock((held) => ws.project.setCurrent({ specId: created.spec.id }, held), "test");
    const p2b = await ws.project.load();
    assert.equal(p2b.kind === "valid" && p2b.phase, "spec_frozen");

    await appendFile(join(created.dir, "SPEC.md"), "\nChanged after approval.\n");
    const p3 = await ws.project.load();
    assert.equal(p3.kind === "valid" && p3.phase, "spec_draft");
    assert.equal(p3.kind === "valid" && p3.phaseReasons[0]?.code, "spec_approval_invalidated");
  });

  test("a dangling current pointer is initialized with a reason; an invalid receipt is listed, not skipped silently", async () => {
    const ws = await initialized("dangling");
    await ws.lock.withLock((held) => ws.project.setCurrent({ specId: "spc_gone" }, held), "test");
    const p = await ws.project.load();
    assert.equal(p.kind === "valid" && p.phase, "initialized");
    assert.equal(p.kind === "valid" && p.phaseReasons[0]?.code, "current_spec_missing");

    await ws.lock.withLock(async (held) => {
      await ws.approvals.record(receiptFor(ws, "sha256:" + "0".repeat(64), "sha256:" + "1".repeat(64), "spc_gone"), held);
    }, "test");
    await writeFile(join(ws.paths.approvalsDir, "apv_broken.json"), "{ nope", "utf8");
    const listing = await ws.approvals.list();
    assert.equal(listing.valid.length, 1);
    assert.equal(listing.invalid.length, 1);
  });

  test("writes require this workspace's held lock", async () => {
    const ws = await initialized("locked");
    const fake = {} as unknown as HeldLock;
    await assert.rejects(ws.specs.create("X", fake), /HeldLock of this workspace/);
    await assert.rejects(ws.project.setCurrent({ specId: "spc_x" }, fake), /HeldLock of this workspace/);
    await assert.rejects(
      ws.approvals.record(receiptFor(ws, "sha256:" + "0".repeat(64), "sha256:" + "1".repeat(64), "spc_x"), fake),
      /HeldLock of this workspace/
    );
  });
});
