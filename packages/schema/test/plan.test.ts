import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PlanSchema, SCHEMA_VERSIONS } from "../dist/index.js";

const fp = "sha256:" + "b".repeat(64);
const base = {
  schema: SCHEMA_VERSIONS.PLAN,
  id: "pln_abc123",
  specId: "spc_abc123",
  specFingerprint: fp,
  createdAt: new Date().toISOString(),
};

describe("plan schema", () => {
  test("defaults tasks to empty and applies contract defaults inside a task", () => {
    assert.deepEqual(PlanSchema.parse(base).tasks, []);
    const plan = PlanSchema.parse({
      ...base,
      tasks: [
        {
          id: "T-01",
          title: "Add login route",
          acceptanceIds: ["AC-01"],
          contract: { filesAllowed: ["src/login.ts"], verificationCommands: ["node --test"] },
        },
      ],
    });
    const task = plan.tasks[0]!;
    assert.deepEqual(task.dependsOn, []);
    assert.deepEqual(task.contract.filesForbidden, []);
    assert.equal(task.contract.maxFilesTouched, 20);
    assert.equal(task.contract.schema, SCHEMA_VERSIONS.FILE_CONTRACT);
  });

  test("rejects bad ids, a missing spec fingerprint, and a status field", () => {
    assert.throws(() => PlanSchema.parse({ ...base, id: "PLN-1" }));
    assert.throws(() => PlanSchema.parse({ ...base, specFingerprint: "abc" }));
    assert.throws(() => PlanSchema.parse({ ...base, status: "approved" }));
    assert.throws(() =>
      PlanSchema.parse({
        ...base,
        tasks: [{ id: "task-1", title: "x", contract: { filesAllowed: [], verificationCommands: [] } }],
      })
    );
  });
});
