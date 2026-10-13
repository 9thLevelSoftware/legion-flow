import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runCommand,
  renderText,
  exitCodeFor,
  InvalidEnvelopeError,
  type RunnerIo,
  type CommandHandler,
} from "../dist/index.js";
import { SCHEMA_VERSIONS, type ResultEnvelope } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

function captureIo(): RunnerIo & { out: string[]; err: string[]; exitCode: number | undefined } {
  const io = {
    out: [] as string[],
    err: [] as string[],
    exitCode: undefined as number | undefined,
    stdout(text: string) {
      io.out.push(text);
    },
    stderr(text: string) {
      io.err.push(text);
    },
    setExitCode(code: number) {
      io.exitCode = code;
    },
  };
  return io;
}

const ctx = { cwd: "/nowhere", isTTY: false, workspace: Workspace.at("/nowhere") };

const blockedEnvelope: ResultEnvelope = {
  schema: SCHEMA_VERSIONS.RESULT,
  command: "status",
  status: "blocked",
  phase: "uninitialized",
  diagnostics: [
    { code: "project_not_initialized", severity: "warning", message: "No project.", hint: "Run init." },
  ],
  gates: [],
  nextAction: { type: "command", run: "legion-flow init --adapter <id>" },
};

describe("runner", () => {
  test("exit code table matches the CLI contract", () => {
    assert.equal(exitCodeFor("ok"), 0);
    assert.equal(exitCodeFor("ready"), 0);
    assert.equal(exitCodeFor("refused"), 2);
    assert.equal(exitCodeFor("usage_error"), 2);
    assert.equal(exitCodeFor("blocked"), 3);
    assert.equal(exitCodeFor("awaiting_decision"), 3);
  });

  test("--json writes exactly one parseable envelope and sets exit 3 for blocked", async () => {
    const io = captureIo();
    const handler: CommandHandler = async () => blockedEnvelope;
    const result = await runCommand(handler, ctx, {}, { json: true, io });
    assert.equal(io.out.length, 1);
    assert.deepEqual(JSON.parse(io.out[0]!), blockedEnvelope);
    assert.equal(io.exitCode, 3);
    assert.equal(result.status, "blocked");
    assert.equal(io.err.length, 0);
  });

  test("text mode renders status, diagnostics with FIX line, and next action", async () => {
    const io = captureIo();
    const handler: CommandHandler = async () => blockedEnvelope;
    await runCommand(handler, ctx, {}, { json: false, io });
    const text = io.out.join("");
    assert.match(text, /^status: blocked\n/);
    assert.match(text, /\[⚠\] project_not_initialized: No project\./);
    assert.match(text, /    FIX: Run init\./);
    assert.match(text, /Next: legion-flow init --adapter <id>/);
    assert.doesNotMatch(text, /Phase:/, "phase line is omitted when uninitialized");
  });

  test("a per-command renderer replaces the generic one", async () => {
    const io = captureIo();
    const handler: CommandHandler = async () => blockedEnvelope;
    await runCommand(handler, ctx, {}, { json: false, io, renderText: (e) => `custom ${e.command}` });
    assert.equal(io.out.join(""), "custom status\n");
  });

  test("an invalid envelope throws and writes nothing", async () => {
    const io = captureIo();
    const handler: CommandHandler = async () =>
      ({ ...blockedEnvelope, status: "not-a-status" }) as unknown as ResultEnvelope;
    await assert.rejects(
      runCommand(handler, ctx, {}, { json: true, io }),
      (err: unknown) => err instanceof InvalidEnvelopeError && /status/.test(err.message)
    );
    assert.equal(io.out.length, 0);
    assert.equal(io.exitCode, undefined);
  });

  test("renderText prints one line per gate verdict, with the waiver when present", () => {
    const withGates: ResultEnvelope = {
      ...blockedEnvelope,
      command: "ship",
      status: "ready",
      phase: "ready_to_ship",
      diagnostics: [],
      gates: [
        {
          schema: SCHEMA_VERSIONS.GATE_VERDICT,
          gateId: "approved_spec",
          riskTier: "R1",
          acceptanceIds: [],
          status: "satisfied",
          reason: "receipt matches",
          evidence: [],
          judge: null,
          inputs: { specFingerprint: "sha256:" + "a".repeat(64), planFingerprint: "sha256:" + "b".repeat(64) },
          evaluatedAt: "2026-10-08T00:00:00Z",
          waiver: null,
        },
        {
          schema: SCHEMA_VERSIONS.GATE_VERDICT,
          gateId: "independent_review",
          riskTier: "R1",
          acceptanceIds: [],
          status: "unevaluable",
          reason: "arrives in M3",
          evidence: [],
          judge: null,
          inputs: { specFingerprint: "sha256:" + "a".repeat(64), planFingerprint: "sha256:" + "b".repeat(64) },
          evaluatedAt: "2026-10-08T00:00:00Z",
          waiver: { reason: "no reviewer exists yet; owner accepts", waivedBy: "lead", waivedAt: "2026-10-08T00:00:00Z" },
        },
      ],
      nextAction: { type: "command", run: "legion-flow ship --commit --approver <id>" },
    };
    const text = renderText(withGates);
    assert.match(text, /\[✔\] gate approved_spec: satisfied, receipt matches/);
    assert.match(text, /\[\?\] gate independent_review: unevaluable, arrives in M3/);
    assert.match(text, /    waived by lead: no reviewer exists yet/);
  });

  test("renderText prints the phase line, decision kind, and wait reason", () => {
    const decision: ResultEnvelope = {
      ...blockedEnvelope,
      command: "execute",
      status: "awaiting_decision",
      phase: "awaiting_decision",
      diagnostics: [],
      nextAction: {
        type: "human_decision",
        interruptId: "int_7f",
        decisionKind: "approve_action",
        run: "legion-flow decide int_7f --approve --approver <id>",
      },
    };
    const text = renderText(decision);
    assert.match(text, /Phase: awaiting_decision/);
    assert.match(text, /Decision required \(approve_action\): legion-flow decide int_7f/);

    const waiting = renderText({
      ...decision,
      nextAction: { type: "wait", until: "2026-10-08T00:00:00Z", reason: "sleep step" },
    });
    assert.match(waiting, /Wait until 2026-10-08T00:00:00Z: sleep step/);
  });
});
