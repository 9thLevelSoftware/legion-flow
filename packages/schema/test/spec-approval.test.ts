import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SpecSchema, ApprovalSchema, ProjectConfigSchema, SCHEMA_VERSIONS } from "../dist/index.js";

const now = new Date().toISOString();
const fp = "sha256:" + "a".repeat(64);

describe("spec and approval schemas", () => {
  test("SpecSchema defaults criteria to empty, types them, and rejects a bad id", () => {
    const spec = SpecSchema.parse({ schema: SCHEMA_VERSIONS.SPEC, id: "spc_abc123", title: "T", createdAt: now });
    assert.deepEqual(spec.acceptanceCriteria, []);
    const withAc = SpecSchema.parse({
      ...spec,
      acceptanceCriteria: [{ id: "AC-01", statement: "It works", kind: "behavior" }],
    });
    assert.equal(withAc.acceptanceCriteria[0]?.surface, "unit");
    assert.equal(withAc.acceptanceCriteria[0]?.priority, "P1");
    assert.throws(() => SpecSchema.parse({ ...spec, id: "SPC-01" }));
    assert.throws(() => SpecSchema.parse({ ...spec, status: "frozen" }), "no status field: frozen is derived");
  });

  test("ApprovalSchema binds fingerprints, requires a human, and is strict", () => {
    const receipt = {
      schema: SCHEMA_VERSIONS.APPROVAL,
      id: "apv_abc123",
      subject: "spec",
      subjectId: "spc_abc123",
      fingerprints: { spec: fp, config: fp },
      decidedBy: { id: "lead", displayName: "Lead", kind: "human" },
      decidedAt: now,
      source: "tty",
      idempotencyKey: "prj:spc:approve.spec:" + fp,
    };
    assert.equal(ApprovalSchema.parse(receipt).subject, "spec");
    assert.throws(() => ApprovalSchema.parse({ ...receipt, decidedBy: { ...receipt.decidedBy, kind: "agent" } }));
    assert.throws(() => ApprovalSchema.parse({ ...receipt, fingerprints: { spec: "abc", config: fp } }));
    assert.throws(() => ApprovalSchema.parse({ ...receipt, extra: true }));
  });

  test("ProjectConfigSchema accepts an optional current pointer and records without one", () => {
    const base = {
      schema: SCHEMA_VERSIONS.PROJECT,
      id: "prj_x",
      name: "X",
      decisionOwners: [{ id: "h", displayName: "H", kind: "human" }],
      adapter: { default: "fake" },
      createdAt: now,
    };
    assert.equal(ProjectConfigSchema.parse(base).current, undefined);
    assert.equal(ProjectConfigSchema.parse({ ...base, current: { specId: "spc_abc" } }).current?.specId, "spc_abc");
    assert.throws(() => ProjectConfigSchema.parse({ ...base, current: { specId: "SPC-01" } }));
  });
});
