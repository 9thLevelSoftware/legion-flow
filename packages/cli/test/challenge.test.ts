import { test, describe } from "node:test";
import { execFile as execFileU } from "node:child_process";
import { promisify as promisifyU } from "node:util";
import { resolveDockerSettings as resolveDockerSettingsU } from "@9thlevelsoftware/legion-flow-sandbox";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, RecallDocSchema, SpecChallengeSchema, type Spec } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, approveCommand, recallCommand } from "../dist/index.js";
import { lintSpec } from "../dist/spec-challenge.js";

const spec = (criteria: Partial<Spec["acceptanceCriteria"][number]>[]): Spec => ({ schema: "legion-flow-spec/v1", id: "spc_x", title: "T", createdAt: "2026-01-01T00:00:00.000Z", acceptanceCriteria: criteria.map((c, i) => ({ id: `AC-0${i + 1}`, statement: "s", kind: "behavior", surface: "unit", priority: "P1", ...c })) as Spec["acceptanceCriteria"] });
const PROSE = "# T\n\nThis change lets a user export a report.\n";

describe("M4 slice (j3): the spec lint", () => {
  test("each rule fires on its case and the clean spec raises nothing", () => {
    const rules = (s: Spec, md = PROSE) => lintSpec(s, md).map((c) => `${c.rule}${c.criterionId ? `:${c.criterionId}` : ""}`);
    const clean = spec([{ statement: "export returns a CSV with one row per order" }, { statement: "export refuses a missing date range with exit 2" }]);
    assert.deepEqual(rules(clean), []);
    assert.deepEqual(rules(spec([{ statement: "the report looks good", kind: "rubric", priority: "P0" }, { statement: "export refuses an empty range" }])), ["p0_rubric:AC-01"]);
    assert.deepEqual(rules(spec([{ statement: "export is fast and secure" }, { statement: "export refuses an empty range" }])), ["unmeasurable:AC-01"]);
    assert.deepEqual(rules(spec([{ statement: "export is fast: under 2 seconds" }, { statement: "export refuses an empty range" }])), [], "a number makes it measurable");
    assert.deepEqual(rules(spec([{ statement: "export returns a CSV" }])), ["no_failure_case"]);
    assert.deepEqual(rules(spec([{ statement: "Export refuses an empty range" }, { statement: "export  refuses an empty range" }])), ["duplicate:AC-02"]);
    assert.deepEqual(rules(clean, "# T\n\n## Intent\n"), ["scaffold_prose"], "headings alone are no prose");
  });
});

async function project(patch: (cfg: Record<string, any>) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-challenge-"));
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Challenge", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  patch(cfg);
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx(), { new: "Export" });
  const dir = created.diagnostics.find((d) => d.code === "spec_created")!.path!;
  const s = JSON.parse(await readFile(join(dir, "spec.json"), "utf8"));
  s.acceptanceCriteria = [{ id: "AC-01", statement: "export is fast", kind: "behavior" }, { id: "AC-02", statement: "export returns a CSV with one row per order", kind: "behavior" }];
  await writeFile(join(dir, "spec.json"), JSON.stringify(s, null, 2));
  await writeFile(join(dir, "SPEC.md"), "# Export\n\nThis change lets a user export orders.\n");
  const script = async (plan: unknown) => writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify(plan));
  const challenge = (opts: Record<string, unknown> = {}) => specCommand(ctx(), { challenge: true, sandbox: "unhardened", allowNoSandbox: true, ...opts });
  return { root, ws, ctx, dir, script, challenge };
}

describe("M4 slice (j3): spec --challenge", () => {
  test("an agent round: a verified quote, a wrong quote kept as unverified, an assumption, a fourth concern dropped; ids are stable across rounds", async () => {
    const { root, dir, script, challenge } = await project();
    try {
      const specRel = `.legion-flow/project/specs/${dir.split(/[\\/]/).pop()}`;
      await script({ challenge: { concerns: [
        { question: "Which orders count?", why: "Cancelled orders are ambiguous.", evidence: [{ path: `${specRel}/SPEC.md`, quote: "export orders" }] },
        { question: "Is CSV quoted?", why: "Commas in names.", evidence: [{ path: `${specRel}/SPEC.md`, quote: "this sentence is not there" }] },
        { question: "Who may export?", why: "No permission stated.", evidence: [{ assumption: "any signed-in user" }] },
        { question: "A fourth", why: "over the cap", evidence: [] },
      ] } });
      const env = ResultEnvelopeSchema.parse(await challenge({ agent: true }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const record = SpecChallengeSchema.parse(JSON.parse(await readFile(join(dir, "challenge.json"), "utf8")));
      const round = record.rounds[0]!;
      assert.deepEqual(round.concerns.map((c) => `${c.id}:${c.source}:${c.rule ?? (c.unverified ? "unverified" : "verified")}`), ["C-1:lint:unmeasurable", "C-2:lint:no_failure_case", "C-3:agent:verified", "C-4:agent:unverified", "C-5:agent:verified"]);
      assert.equal(round.agent.dropped, 1);
      assert.match(env.diagnostics.find((d) => d.message.startsWith("C-4"))!.message, /\[agent, unverified\]: <untrusted-content source="challenge-agent">/);
      await challenge({ agent: true });
      const again = SpecChallengeSchema.parse(JSON.parse(await readFile(join(dir, "challenge.json"), "utf8")));
      assert.equal(again.rounds.length, 2, "every round is kept");
      assert.deepEqual(again.rounds[1]!.concerns.slice(0, 2).map((c) => c.rule), ["unmeasurable", "no_failure_case"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed output and a failed agent leave the lint standing", async () => {
    const { root, dir, script, challenge } = await project();
    try {
      await script({ challengeRaw: "not json" });
      assert.match((await challenge({ agent: true })).diagnostics.find((d) => d.code === "challenge_agent")!.message, /did not parse/);
      await script({ exitCode: 3 });
      assert.match((await challenge({ agent: true })).diagnostics.find((d) => d.code === "challenge_agent")!.message, /did not finish/);
      const record = SpecChallengeSchema.parse(JSON.parse(await readFile(join(dir, "challenge.json"), "utf8")));
      assert.deepEqual(record.rounds.map((r) => r.agent.note), ["agent_output_invalid", "agent_failed"]);
      assert.ok(record.rounds.every((r) => r.concerns.length === 2), "the two lint concerns stand in both rounds");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolving: terminal only, a decision owner, a known unresolved concern, a current round; an accepted risk is a human fact recall returns", async () => {
    const { root, ctx, dir, challenge } = await project();
    try {
      await challenge();
      const resolve = (opts: Record<string, unknown>, tty = true) => specCommand(ctx(tty), { challenge: true, approver: "lead", ...opts });
      assert.equal((await resolve({ resolve: "C-1", answer: "under 2 s" }, false)).diagnostics[0]?.code, "challenge_resolution_requires_tty");
      assert.equal((await resolve({ resolve: "C-1", answer: "x", approver: "stranger" })).diagnostics[0]?.code, "approver_not_decision_owner");
      assert.equal((await resolve({ resolve: "C-9", answer: "x" })).diagnostics[0]?.code, "challenge_concern_unknown");
      assert.equal((await resolve({ resolve: "C-1", answer: "x", dismiss: "y" })).status, "usage_error");
      assert.equal((await resolve({ resolve: "C-1", answer: "export finishes under 2 seconds" })).status, "ok");
      assert.equal((await resolve({ resolve: "C-1", answer: "again" })).diagnostics[0]?.code, "challenge_concern_resolved");
      const risk = await resolve({ resolve: "C-2", acceptRisk: "failure handling is out of scope for the first cut" });
      assert.match(risk.diagnostics[0]!.message, /recorded as human fact fct_/);
      const recalled = ResultEnvelopeSchema.parse(await recallCommand(ctx() as never, { query: "failure handling out of scope" }));
      const doc = RecallDocSchema.parse(JSON.parse(await readFile(recalled.diagnostics.find((d) => d.code === "recall_document")!.path!, "utf8")));
      assert.ok(doc.blocks.find((b) => b.source === "human")!.items.some((i) => i.text.includes("accepted_risk")));
      assert.match((await specCommand(ctx(), {})).diagnostics.find((d) => d.code === "spec_challenge")!.message, /complete, 2 concern\(s\) resolved/);
      await writeFile(join(dir, "SPEC.md"), "# Export\n\nThis change lets a user export orders, edited.\n");
      assert.equal((await resolve({ resolve: "C-1", answer: "x" })).diagnostics[0]?.code, "spec_challenge_stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("under spec.challenge required: approval waits for a complete round with the agent's output, records it on the receipt, and a spec edit makes it stale", async () => {
    const { root, ctx, dir, script, challenge } = await project((c) => (c.spec = { challenge: "required" }));
    try {
      const approve = () => approveCommand(ctx(), { subject: "spec", approver: "lead" });
      assert.equal((await approve()).diagnostics[0]?.code, "spec_challenge_incomplete", "no round yet");
      await script({ exitCode: 3 });
      await challenge();
      const resolve = (id: string) => specCommand(ctx(), { challenge: true, resolve: id, answer: "settled in review", approver: "lead" });
      await resolve("C-1");
      await resolve("C-2");
      assert.match((await approve()).diagnostics[0]!.message, /agent did not finish/, "a required challenge needs the agent's concerns");
      await script({ challenge: { concerns: [] } });
      await challenge();
      assert.equal((await approve()).diagnostics[0]?.code, "spec_challenge_incomplete", "the new round's lint concerns are open");
      await resolve("C-1");
      await resolve("C-2");
      await writeFile(join(dir, "SPEC.md"), "# Export\n\nThis change lets a user export orders. Edited.\n");
      assert.equal((await approve()).diagnostics[0]?.code, "spec_challenge_stale");
      await writeFile(join(dir, "SPEC.md"), "# Export\n\nThis change lets a user export orders.\n");
      const ok = await approve();
      assert.equal(ok.status, "ok", JSON.stringify(ok.diagnostics));
      const receipt = JSON.parse(await readFile(ok.diagnostics.find((d) => d.path?.includes("approvals"))!.path!, "utf8"));
      assert.deepEqual(receipt.challenge, { round: 2, status: "complete", concerns: 2, unresolved: 0, agentRan: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a challenge run never sets the lifecycle phase", async () => {
    const { root, ws, ctx } = await project();
    try {
      const before = (await (await import("../dist/index.js")).statusCommand(ctx(), {})).phase;
      await ws.lock.withLock((held) => ws.runs.create({ kind: "workflow", workflowId: "spec_challenge", graphFingerprint: "sha256:" + "0".repeat(64), durability: "sync" } as never, held), "test");
      assert.equal((await (await import("../dist/index.js")).statusCommand(ctx(), {})).phase, before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without the setting, approval proceeds with a round open and the receipt still records it", async () => {
    const { root, ctx, challenge } = await project();
    try {
      await challenge();
      const ok = await approveCommand(ctx(), { subject: "spec", approver: "lead" });
      assert.equal(ok.status, "ok");
      const receipt = JSON.parse(await readFile(ok.diagnostics.find((d) => d.path?.includes("approvals"))!.path!, "utf8"));
      assert.equal(receipt.challenge.status, "open");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** M4 slice (u): the vm-docker variants run only where Docker and the default node image answer. */
const dockerReadyU = async (t: { skip: (m: string) => void }) => {
  const image = resolveDockerSettingsU(undefined).image;
  const ok = await promisifyU(execFileU)("docker", ["image", "inspect", image]).then(() => true, () => false);
  if (!ok) t.skip(`${image} is not present locally`);
  return ok;
};
/** Containers and networks this tool left behind (they are named lf-...). */
const leftoversU = async () => {
  const run = (args: string[]) => promisifyU(execFileU)("docker", args).then((r) => r.stdout.split("\n").filter((n) => n.startsWith("lf-")), () => [] as string[]);
  return [...(await run(["ps", "-a", "--format", "{{.Names}}"])), ...(await run(["network", "ls", "--format", "{{.Name}}"]))];
};
const evidenceOfU = async (ws: Workspace, runId: string) => {
  const loaded = (await ws.runs.load(runId))!;
  return Promise.all(loaded.evidenceIndex.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as Record<string, any>));
};

describe("M4 slice (u): spec --challenge --agent under vm-docker", () => {
  test("the challenger runs in the hardened container; its concerns land in the round", async (t) => {
    if (!(await dockerReadyU(t))) return;
    const { root, ws, dir, script, challenge } = await project();
    try {
      await script({ challenge: { concerns: [{ question: "Who may export?", why: "No permission stated.", evidence: [{ assumption: "any signed-in user" }] }] } });
      const env = ResultEnvelopeSchema.parse(await challenge({ agent: true, sandbox: "vm-docker", allowNoSandbox: false }));
      assert.equal(env.status, "ok", JSON.stringify(env.diagnostics));
      const round = SpecChallengeSchema.parse(JSON.parse(await readFile(join(dir, "challenge.json"), "utf8"))).rounds[0]!;
      assert.ok(round.concerns.some((c) => c.source === "agent" && /Who may export/.test(c.question)), JSON.stringify(round.concerns));
      const runId = (await ws.runs.list()).find((r) => r.run.kind === "workflow" && r.run.workflowId === "spec_challenge")!.run.id;
      const recs = await evidenceOfU(ws, runId);
      assert.equal(recs.find((r) => r.kind === "sandbox_tier")?.tier, "vm-docker");
      assert.match((recs.find((r) => r.kind === "adapter_outcome")!.argv as string[]).join(" "), /--network none/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
