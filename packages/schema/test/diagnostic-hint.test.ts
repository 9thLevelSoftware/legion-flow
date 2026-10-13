import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticSchema, ResultEnvelopeSchema, SCHEMA_VERSIONS } from "../dist/index.js";

describe("Diagnostic hint", () => {
  test("accepts an optional non-empty hint", () => {
    const d = DiagnosticSchema.parse({ code: "docker_isolation", severity: "warning", message: "m", hint: "Start Docker Desktop" });
    assert.equal(d.hint, "Start Docker Desktop");
    const noHint = DiagnosticSchema.parse({ code: "x", severity: "info", message: "m" });
    assert.equal(noHint.hint, undefined);
  });

  test("rejects an empty hint and unknown keys", () => {
    assert.throws(() => DiagnosticSchema.parse({ code: "x", severity: "info", message: "m", hint: "" }));
    assert.throws(() => DiagnosticSchema.parse({ code: "x", severity: "info", message: "m", fixHint: "f" }));
  });

  test("an envelope carries hinted diagnostics", () => {
    const env = ResultEnvelopeSchema.parse({
      schema: SCHEMA_VERSIONS.RESULT,
      command: "doctor",
      status: "blocked",
      phase: "initialized",
      diagnostics: [{ code: "audit_chain", severity: "error", message: "m", hint: "h" }],
      gates: [],
      nextAction: { type: "command", run: "legion-flow doctor" },
    });
    assert.equal(env.diagnostics[0]?.hint, "h");
  });
});
