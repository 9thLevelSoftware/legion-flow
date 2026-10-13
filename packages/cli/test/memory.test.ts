import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { currentFacts } from "@9thlevelsoftware/legion-flow-memory";
import { initCommand, learnCommand, retroCommand, decideCommand, statusCommand, mapCommand, specCommand, planCommand, approveCommand, shipCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;

async function project(singleValued: string[] = ["owner"]) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-learn-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export function run() { return 1; }\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Mem", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.memory = { singleValued };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  return { root, ws, ctx };
}

const facts = async (ws: Workspace) => (await currentFacts(ws)).rows;

describe("M4 slice (b): learn and supersession", () => {
  test("learn records an llm fact; a human fact needs a terminal and an owner; bad input is a usage error", async () => {
    const { root, ws, ctx } = await project();
    try {
      const learned = ResultEnvelopeSchema.parse(await learnCommand(ctx(), { subject: "topic:payments", predicate: "uses", text: "stripe for card payments" }));
      assert.equal(learned.status, "ok", JSON.stringify(learned.diagnostics));
      const rows = await facts(ws);
      assert.deepEqual(rows.map((r) => [r.subject, r.predicate, r.origin, r.status]), [["topic:payments", "uses", "llm", "active"]]);
      assert.equal((await currentFacts(ws)).indexed, true, "the index holds the replay");

      assert.equal((await learnCommand(ctx(false), { subject: "topic:payments", predicate: "uses", text: "x", approver: "lead" })).diagnostics[0]?.code, "human_assertion_requires_tty");
      assert.equal((await learnCommand(ctx(true), { subject: "topic:payments", predicate: "uses", text: "x", approver: "stranger" })).diagnostics[0]?.code, "approver_not_owner");
      const human = await learnCommand(ctx(true), { subject: "topic:payments", predicate: "audited_by", text: "the security team", approver: "lead" });
      assert.equal(human.status, "ok");
      assert.equal((await facts(ws)).find((r) => r.predicate === "audited_by")?.origin, "human");
      assert.equal((await facts(ws)).find((r) => r.predicate === "audited_by")?.assertedBy, "lead");

      assert.equal((await learnCommand(ctx(), { subject: "nonsense", predicate: "uses", text: "x" })).status, "usage_error");
      assert.equal((await learnCommand(ctx(), { subject: "topic:a", predicate: "Bad Predicate", text: "x" })).status, "usage_error");
      assert.equal((await learnCommand(ctx(), { subject: "topic:a", predicate: "uses", text: "x", object: "topic:b" })).status, "usage_error");
      assert.equal((await learnCommand(ctx(), { subject: "topic:a", predicate: "uses", text: "x", validAt: "yesterday" })).status, "usage_error");
      assert.equal((await learnCommand(ctx(), { subject: "topic:a", predicate: "uses", text: "x", supersedes: ["fct_nothere"] })).diagnostics[0]?.code, "fact_not_active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a module or symbol subject is checked against a fresh map and only noted when the map is not fresh", async () => {
    const { root, ctx } = await project();
    try {
      const unchecked = await learnCommand(ctx(), { subject: "module:src/a.ts", predicate: "owned_by", text: "team a" });
      assert.equal(unchecked.status, "ok");
      assert.ok(unchecked.diagnostics.some((d) => d.code === "subject_unverified"));
      await mapCommand(ctx(), {});
      assert.equal((await learnCommand(ctx(), { subject: "symbol:src/a.ts#run", predicate: "complexity", text: "low" })).status, "ok");
      const unknown = await learnCommand(ctx(), { subject: "module:src/missing.ts", predicate: "owned_by", text: "nobody" });
      assert.equal(unknown.status, "refused");
      assert.equal(unknown.diagnostics[0]?.code, "fact_subject_unknown");
      assert.equal((await learnCommand(ctx(), { subject: "symbol:src/a.ts#nope", predicate: "x", text: "y" })).status, "refused");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a single-valued conflict waits for a human: status points at decide, then at learn --resume; approve retires the old fact without deleting it", async () => {
    const { root, ws, ctx } = await project();
    try {
      await learnCommand(ctx(), { subject: "topic:checkout", predicate: "owner", text: "alice", validAt: "2026-01-01T00:00:00.000Z" });
      const many = await learnCommand(ctx(), { subject: "topic:checkout", predicate: "reviewer", text: "carol" });
      assert.equal(many.status, "ok", "an undeclared predicate coexists");
      await learnCommand(ctx(), { subject: "topic:checkout", predicate: "reviewer", text: "dave" });
      assert.equal((await facts(ws)).filter((r) => r.predicate === "reviewer" && r.status === "active").length, 2);

      const proposed = ResultEnvelopeSchema.parse(await learnCommand(ctx(), { subject: "topic:checkout", predicate: "owner", text: "bob", validAt: "2026-06-01T00:00:00.000Z" }));
      assert.equal(proposed.status, "awaiting_decision");
      assert.ok(proposed.diagnostics.some((d) => d.code === "fact_conflict"));
      assert.equal((await facts(ws)).find((r) => r.object && "text" in r.object && r.object.text === "bob")?.status, "proposed");
      const interruptId = proposed.nextAction.type === "human_decision" ? proposed.nextAction.interruptId : "";
      const status = await statusCommand(ctx(), {});
      assert.equal(status.nextAction.type === "human_decision" && status.nextAction.interruptId, interruptId);

      assert.equal((await learnCommand(ctx(), { resume: true })).status, "awaiting_decision", "resume before the decision names it");
      const decided = await decideCommand(ctx(true), { interruptId, approve: true, approver: "lead" });
      assert.equal(decided.status, "ok", JSON.stringify(decided.diagnostics));
      assert.match(decided.diagnostics.find((d) => d.code === "resume_pending")?.hint ?? "", /learn --resume/);
      assert.equal((await statusCommand(ctx(), {})).nextAction.type === "command" && (await statusCommand(ctx(), {})).nextAction.run, "legion-flow learn --resume");

      const resumed = await learnCommand(ctx(), { resume: true });
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      assert.ok(resumed.diagnostics.some((d) => d.code === "fact_superseded"));
      const owners = (await facts(ws)).filter((r) => r.predicate === "owner");
      const alice = owners.find((r) => "text" in r.object && r.object.text === "alice")!;
      const bob = owners.find((r) => "text" in r.object && r.object.text === "bob")!;
      assert.equal(alice.status, "superseded");
      assert.equal(alice.invalidAt, "2026-06-01T00:00:00.000Z");
      assert.ok(alice.expiredAt);
      assert.equal(bob.status, "active");
      assert.notEqual((await statusCommand(ctx(), {})).nextAction.type === "command" && (await statusCommand(ctx(), {})).nextAction.run, "legion-flow learn --resume");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reject keeps the old fact; an expired decision lapses; --supersedes names a fact explicitly", async () => {
    const { root, ws, ctx } = await project();
    try {
      await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "one" });
      const p1 = await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "two" });
      const i1 = p1.nextAction.type === "human_decision" ? p1.nextAction.interruptId : "";
      await decideCommand(ctx(true), { interruptId: i1, reject: true, approver: "lead" });
      const r1 = await learnCommand(ctx(), { resume: true });
      assert.ok(r1.diagnostics.some((d) => d.code === "fact_rejected"));
      assert.deepEqual((await facts(ws)).filter((r) => r.predicate === "owner").map((r) => [("text" in r.object ? r.object.text : ""), r.status]).sort(), [["one", "active"], ["two", "rejected"]]);

      const p2 = await learnCommand(ctx(), { subject: "topic:a", predicate: "owner", text: "three" });
      const i2 = p2.nextAction.type === "human_decision" ? p2.nextAction.interruptId : "";
      // Expire it: the interrupt file's expiry moves into the past.
      const runId = p2.runId!;
      const interruptPath = join(ws.paths.runsDir, runId, "interrupts", `${i2}.json`);
      const record = JSON.parse(await readFile(interruptPath, "utf8"));
      record.expiresAt = "2000-01-01T00:00:00.000Z";
      await writeFile(interruptPath, JSON.stringify(record, null, 2));
      const r2 = await learnCommand(ctx(), { resume: true });
      assert.ok(r2.diagnostics.some((d) => d.code === "fact_expired"), JSON.stringify(r2.diagnostics));
      assert.equal((await facts(ws)).find((r) => "text" in r.object && r.object.text === "three")?.status, "rejected");

      const one = (await facts(ws)).find((r) => "text" in r.object && r.object.text === "one")!;
      const explicit = await learnCommand(ctx(), { subject: "topic:b", predicate: "note", text: "replaces one", supersedes: [one.id] });
      assert.equal(explicit.status, "awaiting_decision", "an explicit --supersedes opens a supersession whatever the predicate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (b): retro", () => {
  test("a release's deterministic facts, written once", async () => {
    const { root, ws, ctx } = await project();
    try {
      assert.equal((await retroCommand(ctx(), {})).diagnostics[0]?.code, "no_release");
      const created = await specCommand(ctx(), { new: "Retro" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: "a runs", kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2));
      await approveCommand(ctx(), { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx(), { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: "noop", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [`${node} -e 0`] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2));
      await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} -e 0`] });
      const shipped = await shipCommand(ctx(true), { commit: true, approver: "lead" });
      assert.equal(shipped.status, "ok", JSON.stringify(shipped.diagnostics));

      const retro = await retroCommand(ctx(), {});
      assert.equal(retro.status, "ok", JSON.stringify(retro.diagnostics));
      const rows = (await facts(ws)).filter((r) => r.subject.startsWith("release:"));
      assert.ok(rows.every((r) => r.origin === "deterministic" && r.status === "active"));
      const preds = rows.map((r) => r.predicate).sort();
      assert.ok(preds.includes("decided_by"));
      assert.ok(preds.includes("gate_approved_spec"));
      assert.ok(preds.includes("usage"));
      assert.equal((await retroCommand(ctx(), {})).diagnostics[0]?.code, "retro_exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
