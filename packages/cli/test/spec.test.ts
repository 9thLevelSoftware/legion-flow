import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, statusCommand, specCommand, approveCommand } from "../dist/index.js";
import { ResultEnvelopeSchema, ApprovalSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

describe("spec and approve spec (M1 slice a)", () => {
  let root: string;
  let ws: Workspace;
  let specDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-spec-cli-"));
    ws = Workspace.at(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  const codes = (env: { diagnostics: { code: string }[] }) => env.diagnostics.map((d) => d.code);

  test("spec before init is refused; after init, bare spec is blocked with the --new hint", async () => {
    const before = await specCommand(ctx(), {});
    ResultEnvelopeSchema.parse(before);
    assert.equal(before.status, "refused");
    assert.equal(before.diagnostics[0]?.code, "project_not_initialized");

    await initCommand(ctx(), { adapter: "fake", name: "App", owner: "lead" });
    const bare = await specCommand(ctx(), {});
    assert.equal(bare.status, "blocked");
    assert.equal(bare.phase, "initialized");
    assert.equal(bare.diagnostics[0]?.code, "no_current_spec");
    assert.match((bare.nextAction as { run: string }).run, /spec --new/);
  });

  test("spec --new creates a draft, sets the current pointer, moves the phase to spec_draft, and audits", async () => {
    const env = await specCommand(ctx(), { new: "Login flow" });
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "ok");
    assert.equal(env.phase, "spec_draft");
    assert.ok(codes(env).includes("spec_created"));
    assert.ok(codes(env).includes("no_acceptance_criteria"));
    specDir = env.diagnostics.find((d) => d.code === "spec_created")!.path!;
    assert.match(await readFile(join(specDir, "SPEC.md"), "utf8"), /^# Login flow/);

    const status = await statusCommand(ctx(), {});
    assert.equal(status.phase, "spec_draft");
    assert.ok(codes(status).includes("current_spec"));
    assert.match((status.nextAction as { run: string }).run, /approve spec/);

    const chain = await ws.audit.verify();
    assert.equal(chain.verifiedCount, 2, "project_initialized + spec_created");

    const again = await specCommand(ctx(), { new: "Second" });
    assert.equal(again.status, "refused");
    assert.equal(again.diagnostics[0]?.code, "spec_exists");
  });

  test("approve spec refuses a non-owner and an empty spec, and writes nothing", async () => {
    const stranger = await approveCommand(ctx(), { subject: "spec", approver: "someone_else" });
    assert.equal(stranger.status, "refused");
    assert.equal(stranger.diagnostics[0]?.code, "approver_not_decision_owner");

    const empty = await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    assert.equal(empty.status, "refused");
    assert.equal(empty.diagnostics[0]?.code, "spec_has_no_criteria");

    assert.equal((await readdir(ws.paths.approvalsDir).catch(() => [])).length, 0, "no receipt was written");
  });

  test("approve spec by an owner writes a receipt, freezes the spec, audits, and is idempotent", async () => {
    const jsonPath = join(specDir, "spec.json");
    const spec = JSON.parse(await readFile(jsonPath, "utf8"));
    spec.acceptanceCriteria = [
      { id: "AC-01", statement: "A user with valid credentials reaches the dashboard", kind: "behavior", surface: "end_to_end", priority: "P0" },
      { id: "AC-02", statement: "Login unit tests pass", kind: "test" },
    ];
    await writeFile(jsonPath, JSON.stringify(spec, null, 2) + "\n", "utf8");

    const inspect = await specCommand(ctx(), {});
    assert.equal(inspect.status, "ok");
    assert.match(inspect.diagnostics.find((d) => d.code === "acceptance_criteria")?.message ?? "", /2 acceptance criteria: AC-01/);

    const approved = await approveCommand(ctx(true), { subject: "spec", approver: "lead" });
    ResultEnvelopeSchema.parse(approved);
    assert.equal(approved.status, "ok");
    assert.equal(approved.phase, "spec_frozen");
    const receiptPath = approved.diagnostics.find((d) => d.code === "spec_approved")!.path!;
    const receipt = ApprovalSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    assert.equal(receipt.decidedBy.id, "lead");
    assert.equal(receipt.source, "tty");
    assert.equal(receipt.subjectId, spec.id);

    const frozen = await specCommand(ctx(), {});
    assert.equal(frozen.status, "ready");
    assert.equal(frozen.phase, "spec_frozen");
    assert.match((frozen.nextAction as { run: string }).run, /legion-flow plan/);

    const again = await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    assert.equal(again.status, "ok");
    assert.equal(again.diagnostics[0]?.code, "approval_unchanged");
    assert.equal((await readdir(ws.paths.approvalsDir)).length, 1, "idempotent: no second receipt");

    const chain = await ws.audit.verify();
    assert.equal(chain.verifiedCount, 3, "one spec_approved event, not two");
  });

  test("editing SPEC.md after approval returns the project to spec_draft with the invalidation reason", async () => {
    await appendFile(join(specDir, "SPEC.md"), "\nA late edit.\n");
    const status = await statusCommand(ctx(), {});
    assert.equal(status.phase, "spec_draft");
    assert.ok(codes(status).includes("spec_approval_invalidated"));
    assert.match((status.nextAction as { run: string }).run, /approve spec/);

    const reapproved = await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    assert.equal(reapproved.status, "ok");
    assert.equal(reapproved.phase, "spec_frozen");
    assert.equal(reapproved.diagnostics[0]?.code, "spec_approved");
    assert.equal((await readdir(ws.paths.approvalsDir)).length, 2, "receipts are history; the matching one freezes");
  });

  test("approve rejects an unknown subject as a usage error, and approve plan without --check likewise", async () => {
    const bad = await approveCommand(ctx(), { subject: "thing", approver: "lead" });
    assert.equal(bad.status, "usage_error");
    assert.equal(bad.diagnostics[0]?.code, "unknown_subject");
    const plan = await approveCommand(ctx(), { subject: "plan", approver: "lead" });
    assert.equal(plan.status, "usage_error");
    assert.equal(plan.diagnostics[0]?.code, "check_required");
  });
});
