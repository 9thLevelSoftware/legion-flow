import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, statusCommand } from "../dist/index.js";
import { parseDraftOutput } from "@9thlevelsoftware/legion-flow-engine";

const SPEC = { title: "Friendlier greeting", intent: "The greeting should say hello, so new users feel welcome.", acceptanceCriteria: [{ id: "AC-01", statement: "greet.ts exports a greeting containing hello", kind: "behavior", surface: "unit", priority: "P0", extra: "dropped" }], outOfScope: "Translations." };
const PLAN = {
  tasks: [
    { id: "T-01", title: "Say hello", acceptanceIds: ["AC-01"], dependsOn: [], contract: { filesAllowed: ["src/greet.ts"], verificationCommands: ["node check.mjs"] }, tools: ["browser"], member: "x" },
    { id: "T-02", title: "Tidy everything", acceptanceIds: [], dependsOn: ["T-01"], contract: { filesAllowed: ["**"], verificationCommands: ["npm test && echo ok"] } },
  ],
  checks: ["node check.mjs"],
};

async function project() {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-draft-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "greet.ts"), 'export const greeting = "hi";\n');
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "Draft", owner: "alice" });
  const script = async (plan: Record<string, unknown>) => writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(plan));
  const host = { sandbox: "unhardened", allowNoSandbox: true, adapterTimeoutMs: 60_000 };
  return { root, ws, ctx, script, host };
}

describe("drafting: spec --draft and plan --draft", () => {
  test("spec --draft creates the spec at initialized, rewrites the same spec at spec_draft, and is refused once the spec is approved", async () => {
    const { root, ws, ctx, script, host } = await project();
    try {
      await script({ draft: { spec: SPEC } });
      const first = ResultEnvelopeSchema.parse(await specCommand(ctx, { draft: "make the greeting friendlier", ...host }));
      assert.equal(first.status, "ok", JSON.stringify(first.diagnostics));
      assert.equal(first.phase, "spec_draft");
      const specDir = first.diagnostics.find((d) => d.code === "spec_drafted")!.path!;
      const spec = JSON.parse(await readFile(join(specDir, "spec.json"), "utf8"));
      assert.equal(spec.title, "Friendlier greeting");
      assert.deepEqual(spec.acceptanceCriteria, [{ id: "AC-01", statement: "greet.ts exports a greeting containing hello", kind: "behavior", surface: "unit", priority: "P0" }], "a stray criterion key is dropped");
      const md = await readFile(join(specDir, "SPEC.md"), "utf8");
      assert.match(md, /Drafted by fake in run run_[0-9a-z]+ from the request: "make the greeting friendlier"/);
      assert.match(md, /- \*\*AC-01\*\* \(behavior, unit, P0\): greet\.ts exports/);
      assert.match(md, /## Out of scope\n\nTranslations\./);
      assert.ok(first.diagnostics.some((d) => d.code === "spec_criterion" && d.message.includes('<untrusted-content source="drafter">')));

      await script({ draft: { spec: { ...SPEC, title: "Friendlier greeting, take two" } } });
      const second = ResultEnvelopeSchema.parse(await specCommand(ctx, { draft: "and keep it short", ...host }));
      assert.equal(second.status, "ok");
      assert.equal(second.diagnostics.find((d) => d.code === "spec_drafted")!.path, specDir, "a rewrite keeps the same spec and directory");
      assert.equal(JSON.parse(await readFile(join(specDir, "spec.json"), "utf8")).id, spec.id);
      assert.equal(JSON.parse(await readFile(join(specDir, "spec.json"), "utf8")).createdAt, spec.createdAt);
      assert.equal((await readdir(ws.paths.specsDir)).length, 1);

      await approveCommand(ctx, { subject: "spec", approver: "alice" });
      const frozen = await specCommand(ctx, { draft: "change it again", ...host });
      assert.equal(frozen.status, "refused");
      assert.equal(frozen.diagnostics[0]?.code, "draft_phase");
      assert.match(frozen.diagnostics[0]?.hint ?? "", /plan --draft/);
      const events = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; created?: boolean });
      assert.deepEqual(events.filter((e) => e.type === "spec_drafted").map((e) => e.created), [true, false]);
      assert.equal((await statusCommand(ctx, {})).phase, "spec_frozen", "drafting runs never set the phase");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed answers are refused with nothing written; a fenced JSON answer is unwrapped", async () => {
    const { root, ws, ctx, script, host } = await project();
    try {
      await script({ draftRaw: "Sure! Here is your spec: {not json" });
      const bad = await specCommand(ctx, { draft: "anything", ...host });
      assert.equal(bad.status, "refused");
      assert.equal(bad.diagnostics[0]?.code, "draft_invalid");
      assert.match(bad.diagnostics[0]?.message ?? "", /not JSON/);
      assert.equal((await readdir(ws.paths.specsDir)).length, 0, "nothing was written");

      await script({});
      const none = await specCommand(ctx, { draft: "anything", ...host });
      assert.equal(none.diagnostics[0]?.code, "draft_invalid");
      assert.match(none.diagnostics[0]?.message ?? "", /no output file/);

      const fenced = parseDraftOutput("spec", "```json\n" + JSON.stringify(SPEC) + "\n```\n");
      assert.equal(fenced.ok, true);
      assert.equal(parseDraftOutput("spec", JSON.stringify({ ...SPEC, acceptanceCriteria: [] })).ok, false, "a spec needs at least one criterion");
      assert.equal(parseDraftOutput("spec", JSON.stringify({ ...SPEC, acceptanceCriteria: [SPEC.acceptanceCriteria[0], SPEC.acceptanceCriteria[0]] })).ok, false, "repeated ids");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plan --draft creates the plan against the frozen spec; forbidden fields are stripped, whole-tree contracts and shell checks are flagged, drafted checks are shown as host execution, and suggestions are never the next action", async () => {
    const { root, ws, ctx, script, host } = await project();
    try {
      await script({ draft: { spec: SPEC, plan: PLAN } });
      const early = await planCommand(ctx, { draft: true, ...host });
      assert.equal(early.diagnostics[0]?.code, "draft_phase");
      await specCommand(ctx, { draft: "make the greeting friendlier", ...host });
      await approveCommand(ctx, { subject: "spec", approver: "alice" });

      const env = ResultEnvelopeSchema.parse(await planCommand(ctx, { draft: "keep it to one file", ...host }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      assert.equal(env.phase, "planning");
      const dir = env.diagnostics.find((d) => d.code === "plan_drafted")!.path!;
      const plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
      assert.equal(plan.tasks.length, 2);
      assert.equal(plan.tasks[0].tools, undefined);
      assert.equal(plan.tasks[0].member, undefined);
      assert.equal(plan.tasks[0].contract.maxFilesTouched, 20, "schema defaults fill the contract");
      const codes = env.diagnostics.map((d) => d.code);
      for (const c of ["draft_fields_stripped", "draft_whole_tree", "draft_checks", "draft_check_refused", "draft_suggested_checks"]) assert.ok(codes.includes(c), c);
      assert.match(env.diagnostics.find((d) => d.code === "draft_fields_stripped")!.message, /T-01\.member, T-01\.tools|T-01\.tools, T-01\.member/);
      assert.match(env.diagnostics.find((d) => d.code === "draft_checks")!.message, /run on this machine/);
      assert.equal(env.nextAction.type, "command");
      if (env.nextAction.type === "command") assert.ok(!env.nextAction.run.includes("node check.mjs"), "the drafter's suggestion is never the pasteable next command");

      await script({ draft: { plan: { tasks: [PLAN.tasks[0]] } } });
      const again = ResultEnvelopeSchema.parse(await planCommand(ctx, { draft: true, ...host }));
      assert.equal(again.diagnostics.find((d) => d.code === "plan_drafted")!.path, dir, "a rewrite keeps the same plan");
      assert.equal(JSON.parse(await readFile(join(dir, "plan.json"), "utf8")).tasks.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
