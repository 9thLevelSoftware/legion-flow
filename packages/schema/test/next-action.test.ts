import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultEnvelopeSchema, NextActionSchema } from "../dist/index.js";

test("credential_required is a next action naming the variable and the adapter, never a value", () => {
  const next = NextActionSchema.parse({ type: "credential_required", variable: "ANTHROPIC_API_KEY", adapter: "claude", hint: "Set it and re-run." });
  assert.equal(next.type, "credential_required");
  assert.throws(() => NextActionSchema.parse({ type: "credential_required", variable: "sk-live-abc", adapter: "claude", hint: "x" }), "a value-looking string is not a variable name");
  const env = ResultEnvelopeSchema.parse({ command: "execute", status: "blocked", phase: "plan_ready", nextAction: next });
  assert.equal(env.status, "blocked");
});
