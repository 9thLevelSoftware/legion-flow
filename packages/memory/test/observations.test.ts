import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Episode, FactRow } from "@9thlevelsoftware/legion-flow-schema";
import { clusterObservations, replayObservations, statementKey, normalizeStatementText } from "../dist/index.js";

let n = 0;
const fact = (episodeId: string, subject: string, predicate: string, object: FactRow["object"], extra: Partial<FactRow> = {}): FactRow => ({
  id: `fct_${(++n).toString(36).padStart(4, "0")}`,
  subject,
  predicate,
  object,
  validAt: `2026-01-0${(n % 9) + 1}T00:00:00.000Z`,
  createdAt: "2026-01-01T00:00:00.000Z",
  origin: "llm",
  status: "active",
  episodeId,
  ...extra,
});

describe("M4 slice (i): clustering by statement key", () => {
  test("one statement learned twice is one candidate; once is none; ref and text with one spelling never meet; text is normalized", () => {
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "flaky_in", { ref: "module:src/a.ts" })]).length, 0);
    const twice = clusterObservations([fact("ep_a", "topic:ci", "flaky_in", { ref: "module:src/a.ts" }), fact("ep_b", "topic:ci", "flaky_in", { ref: "module:src/a.ts" })]);
    assert.equal(twice.length, 1);
    assert.match(twice[0]!.id, /^obc_[0-9a-f]{12}$/);
    assert.equal(twice[0]!.name, "flaky_in module:src/a.ts");
    assert.deepEqual(twice[0]!.origins, { deterministic: 0, human: 0, llm: 2 });
    assert.equal(normalizeStatementText("  Foo   BAR\n"), "foo bar");
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "note", { text: "Foo  bar" }), fact("ep_b", "topic:ci", "note", { text: "foo bar" })]).length, 1);
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "about", { ref: "topic:x" }), fact("ep_b", "topic:ci", "about", { text: "topic:x" })]).length, 0);
    assert.notEqual(statementKey({ subject: "topic:ci", predicate: "about", object: { ref: "topic:x" } }), statementKey({ subject: "topic:ci", predicate: "about", object: { text: "topic:x" } }));
  });

  test("a corroboration links a second episode to an existing fact: one fact, two episodes, one candidate; a corroboration of an inactive fact counts for nothing", async () => {
    const { corroborationsOf } = await import("../dist/index.js");
    const f = fact("ep_a", "topic:ci", "flaky_in", { ref: "module:src/a.ts" });
    const links = corroborationsOf([{ schema: "legion-flow-episode/v1", id: "ep_b", createdAt: "2026-01-02T00:00:00.000Z", kind: "corroboration", factId: f.id, origin: "human", assertedBy: "lead" } as Episode]);
    const c = clusterObservations([f], links);
    assert.equal(c.length, 1);
    assert.deepEqual([c[0]!.factIds.length, c[0]!.episodeIds], [1, ["ep_a", "ep_b"]]);
    assert.deepEqual(c[0]!.origins, { deterministic: 0, human: 1, llm: 1 }, "origins count mentions");
    assert.equal(clusterObservations([{ ...f, status: "superseded" }], links).length, 0);
  });

  test("two facts in one episode do not cluster; proposed and superseded facts are left out", () => {
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "x", { text: "y" }), fact("ep_a", "topic:ci", "x", { text: "y" })]).length, 0);
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "x", { text: "y" }), fact("ep_b", "topic:ci", "x", { text: "y" }, { status: "proposed" })]).length, 0);
    assert.equal(clusterObservations([fact("ep_a", "topic:ci", "x", { text: "y" }), fact("ep_b", "topic:ci", "x", { text: "y" }, { status: "superseded" })]).length, 0);
  });

  test("a retro alone yields nothing, and a learn repeating one retro fact links that statement only", () => {
    const retro = [fact("ep_r", "release:rel_1", "decided_by", { text: "lead" }), fact("ep_r", "release:rel_1", "gate_approved_spec", { text: "satisfied" }), fact("ep_r", "release:rel_1", "usage", { text: "unknown" })];
    assert.equal(clusterObservations(retro).length, 0);
    const c = clusterObservations([...retro, fact("ep_l", "release:rel_1", "usage", { text: "Unknown" })]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.keys.length, 1, "only the repeated statement, not the retro's other facts");
    assert.equal(c[0]!.factIds.length, 2);
  });

  test("components join through shared episodes, and the id does not depend on order", () => {
    const rows = [
      fact("ep_a", "topic:ci", "p", { text: "one" }),
      fact("ep_b", "topic:ci", "p", { text: "one" }),
      fact("ep_b", "topic:db", "q", { text: "two" }),
      fact("ep_c", "topic:db", "q", { text: "two" }),
    ];
    const a = clusterObservations(rows);
    const b = clusterObservations([...rows].reverse());
    assert.equal(a.length, 1, "ep_b links both statements into one component");
    assert.equal(a[0]!.keys.length, 2);
    assert.match(a[0]!.name, /^2 related statements about topic:ci, topic:db$/);
    assert.deepEqual(a, b);
  });

  test("replay: a later overlapping commit retires the earlier one; a member that stopped being active marks it stale", () => {
    const base = { schema: "legion-flow-episode/v1" as const, kind: "observation" as const, candidateId: "obc_000000000000", name: "n", summary: "s", origins: { deterministic: 0, human: 0, llm: 2 }, edited: false, decidedBy: "lead", interruptId: "int_x" };
    const episodes = [
      { ...base, id: "ep_o1", createdAt: "2026-02-01T00:00:00.000Z", keys: ["k1"], factIds: ["fct_a", "fct_b"], episodeIds: ["ep_a", "ep_b"] },
      { ...base, id: "ep_o2", createdAt: "2026-03-01T00:00:00.000Z", keys: ["k1", "k2"], factIds: ["fct_a", "fct_b", "fct_c"], episodeIds: ["ep_a", "ep_b", "ep_c"] },
      { ...base, id: "ep_o3", createdAt: "2026-03-02T00:00:00.000Z", keys: ["k9"], factIds: ["fct_x", "fct_y"], episodeIds: ["ep_x", "ep_y"] },
    ] as unknown as Episode[];
    const rows = ["fct_a", "fct_b", "fct_c", "fct_x"].map((id) => ({ id, status: "active" }) as FactRow).concat([{ id: "fct_y", status: "superseded" } as FactRow]);
    const out = replayObservations(episodes, rows);
    assert.deepEqual(out.map((o) => [o.episode.id, o.status, o.retiredBy ?? null]), [["ep_o1", "retired", "ep_o2"], ["ep_o2", "active", null], ["ep_o3", "active", null]]);
    assert.equal(out[2]!.stale, "member fct_y is superseded");
  });
});
