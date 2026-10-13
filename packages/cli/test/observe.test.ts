import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema, RecallDocSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, learnCommand, decideCommand, statusCommand, observeCommand, recallCommand } from "../dist/index.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-observe-"));
  const ws = Workspace.at(root);
  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Observe", owner: "lead" });
  return { root, ws, ctx };
}
const flaky = { subject: "topic:ci", predicate: "flaky_in", object: "module:src/net.ts" };
const candidateOf = (env: { diagnostics: { code: string; message: string }[] }) => env.diagnostics.find((d) => d.code === "observation_candidate")?.message.match(/obc_[0-9a-f]{12}/)?.[0];

describe("M4 slice (i): observe", () => {
  test("a repeated statement becomes a candidate; propose, an edit that rewords it, resume; recall shows it with its members; the phase never moves", async () => {
    const { root, ws, ctx } = await project();
    try {
      await learnCommand(ctx(), flaky);
      const none = ResultEnvelopeSchema.parse(await observeCommand(ctx(), {}));
      assert.equal(candidateOf(none), undefined, "one statement once is not a cluster");
      const again1 = await learnCommand(ctx(), flaky);
      assert.match(again1.diagnostics[0]!.message, /corroborated by ep_/, "a repeated statement is corroborated, not duplicated");
      const listed = ResultEnvelopeSchema.parse(await observeCommand(ctx(), {}));
      const id = candidateOf(listed)!;
      assert.ok(id, JSON.stringify(listed.diagnostics));
      assert.match(listed.diagnostics.find((d) => d.code === "observation_candidate")!.message, /\[new\] flaky_in module:src\/net\.ts: 1 fact\(s\) mentioned in 2 episodes; mentions 0 deterministic, 0 human, 2 llm/);
      assert.equal((listed.nextAction as { run: string }).run, `legion-flow observe --propose ${id}`);

      const proposed = ResultEnvelopeSchema.parse(await observeCommand(ctx(), { propose: id }));
      assert.equal(proposed.status, "awaiting_decision");
      assert.ok(proposed.diagnostics.some((d) => d.code === "observation_unverified"), "an agent-only cluster says so");
      const interruptId = (proposed.nextAction as { interruptId: string }).interruptId;
      assert.equal((await observeCommand(ctx(), { propose: id })).diagnostics[0]?.code, "observation_pending");
      const status = ResultEnvelopeSchema.parse(await statusCommand(ctx(), {}));
      assert.equal(status.phase, "initialized", "a memory workflow never sets the lifecycle phase");
      assert.equal(status.nextAction.type, "human_decision");
      assert.match(status.diagnostics.find((d) => d.code === "decision_pending")!.message, /committed as an observation/);

      assert.equal((await decideCommand(ctx(true), { interruptId, edit: JSON.stringify({ factIds: [] }), approver: "lead" })).diagnostics[0]?.code, "edit_invalid", "members are never editable");
      const decided = await decideCommand(ctx(true), { interruptId, edit: JSON.stringify({ name: "CI is flaky around the network module" }), approver: "lead" });
      assert.equal(decided.status, "ok", JSON.stringify(decided.diagnostics));
      assert.match(decided.diagnostics.find((d) => d.code === "resume_pending")!.hint!, /observe --resume/);
      assert.equal(((await statusCommand(ctx(), {})).nextAction as { run: string }).run, "legion-flow observe --resume");

      const resumed = ResultEnvelopeSchema.parse(await observeCommand(ctx(), { resume: true }));
      assert.equal(resumed.status, "ok", JSON.stringify(resumed.diagnostics));
      assert.ok(resumed.diagnostics.some((d) => d.code === "observation_committed"));
      const events = await readFile(ws.paths.eventsJsonl, "utf8");
      assert.ok(events.includes("observation_proposed") && events.includes("observation_committed"));

      const recalled = ResultEnvelopeSchema.parse(await recallCommand(ctx() as never, { query: "flaky network" }));
      const doc = RecallDocSchema.parse(JSON.parse(await readFile(recalled.diagnostics.find((d) => d.code === "recall_document")!.path!, "utf8")));
      const human = doc.blocks.find((b) => b.source === "human")!;
      const item = human.items.find((i) => i.text.startsWith("observation: CI is flaky around the network module"))!;
      assert.ok(item, JSON.stringify(human));
      assert.equal(item.citations.filter((c) => c.label === "fact").length, 1, "one fact, said twice");
      assert.match(item.text, /committed .* by lead; worded by a decision owner; --as-of does not apply/);
      const before = ResultEnvelopeSchema.parse(await recallCommand(ctx() as never, { query: "flaky network", knownAt: "2020-01-01T00:00:00.000Z" }));
      const beforeDoc = RecallDocSchema.parse(JSON.parse(await readFile(before.diagnostics.find((d) => d.code === "recall_document")!.path!, "utf8")));
      assert.ok(!beforeDoc.blocks.find((b) => b.source === "human")!.items.some((i) => i.text.startsWith("observation:")), "not known before it was committed");

      const again = await observeCommand(ctx(), {});
      assert.match(again.diagnostics.find((d) => d.code === "observation_candidate")!.message, /\[committed\]/);
      assert.equal((await observeCommand(ctx(), { propose: id })).diagnostics[0]?.code, "observation_exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("members that change between proposal and resume are not committed; a larger cluster retires the older observation", async () => {
    const { root, ws, ctx } = await project();
    try {
      await learnCommand(ctx(), flaky);
      await learnCommand(ctx(), flaky);
      const first = (await observeCommand(ctx(), { propose: candidateOf(await observeCommand(ctx(), {}))! })).nextAction as { interruptId: string };
      await decideCommand(ctx(true), { interruptId: first.interruptId, approve: true, approver: "lead" });
      await observeCommand(ctx(), { resume: true });

      await learnCommand(ctx(), flaky);
      const id = candidateOf(await observeCommand(ctx(), {}))!;
      assert.match((await observeCommand(ctx(), {})).diagnostics.find((d) => d.code === "observation_candidate")!.message, /\[new\] .*mentioned in 3 episodes/, "the same statements with more members are a new candidate");
      const second = (await observeCommand(ctx(), { propose: id })).nextAction as { interruptId: string };
      await learnCommand(ctx(), flaky);
      await decideCommand(ctx(true), { interruptId: second.interruptId, approve: true, approver: "lead" });
      const changed = await observeCommand(ctx(), { resume: true });
      assert.ok(changed.diagnostics.some((d) => d.code === "observation_members_changed"), JSON.stringify(changed.diagnostics));

      const third = (await observeCommand(ctx(), { propose: id })).nextAction as { interruptId: string };
      await decideCommand(ctx(true), { interruptId: third.interruptId, approve: true, approver: "lead" });
      await observeCommand(ctx(), { resume: true });
      const doc = JSON.parse(await readFile((await observeCommand(ctx(), {})).diagnostics.find((d) => d.code === "observe_document")!.path!, "utf8")) as { observations: { status: string; retiredBy?: string }[] };
      assert.deepEqual(doc.observations.map((o) => o.status), ["retired", "active"]);
      const events = await readFile(ws.paths.eventsJsonl, "utf8");
      assert.ok(events.includes("members_changed"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("usage: --propose with --resume; an unknown candidate; nothing to resume", async () => {
    const { root, ctx } = await project();
    try {
      assert.equal((await observeCommand(ctx(), { propose: "obc_000000000000", resume: true })).status, "usage_error");
      assert.equal((await observeCommand(ctx(), { propose: "obc_000000000000" })).diagnostics[0]?.code, "observation_unknown");
      assert.equal((await observeCommand(ctx(), { resume: true })).diagnostics[0]?.code, "no_run_to_resume");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
