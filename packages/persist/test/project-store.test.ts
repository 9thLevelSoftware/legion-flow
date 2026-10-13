import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, getLegionFlowPaths, type HeldLock } from "../dist/index.js";

describe("workspace handle and project store", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "legion-flow-workspace-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function workspace(name: string): Promise<Workspace> {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    return Workspace.at(root);
  }

  const create = (ws: Workspace, name: string, ownerId = "lead") =>
    ws.lock.withLock((held) => ws.project.create({ name, adapterId: "fake", ownerId }, held), "test");

  test("the handle exposes the layout's paths and binds audit and lock to the right files", async () => {
    const ws = await workspace("handle");
    const paths = getLegionFlowPaths(ws.root);
    assert.deepEqual(ws.paths, paths);
    assert.equal(ws.audit.eventsPath, paths.eventsJsonl);
    assert.equal(ws.audit.chainPath, paths.chainJson);
    assert.equal(ws.lock.lockPath, paths.engineLock);
  });

  test("absent: no record, and building the handle creates nothing on disk", async () => {
    const ws = await workspace("absent");
    assert.equal((await ws.project.load()).kind, "absent");
    await assert.rejects(stat(ws.paths.root), /ENOENT/);
  });

  test("create: writes a schema-valid record with defaults from the schema and derives the phase", async () => {
    const ws = await workspace("create");
    const created = await create(ws, "Demo");
    assert.equal(created.kind, "created");
    if (created.kind !== "created") return;
    assert.equal(created.phase, "initialized");
    assert.equal(created.config.controlMode, "guarded");
    assert.equal(created.config.defaultRiskTier, "R1");
    assert.equal(created.config.riskPolicyVersion, "risk-policy/v1");
    assert.equal(created.config.decisionOwners[0]?.displayName, "lead");

    const loaded = await ws.project.load();
    assert.equal(loaded.kind, "valid");
    if (loaded.kind !== "valid") return;
    assert.deepEqual(loaded.config, created.config);
    assert.equal(loaded.phase, "initialized");

    const gitignore = await readFile(join(ws.paths.root, ".gitignore"), "utf8");
    assert.match(gitignore, /var\//, "layout was created alongside the record");
  });

  test("create refuses an existing valid record and leaves it untouched", async () => {
    const ws = await workspace("exists");
    const first = await create(ws, "First", "a");
    const second = await create(ws, "Second", "b");
    assert.equal(second.kind, "exists");
    if (second.kind !== "exists" || first.kind !== "created") return;
    assert.equal(second.existing.kind, "valid");
    if (second.existing.kind !== "valid") return;
    assert.equal(second.existing.config.id, first.config.id);
    assert.equal(second.existing.config.name, "First");
  });

  test("malformed JSON: invalid with cause, create refuses rather than overwrites", async () => {
    const ws = await workspace("malformed");
    await mkdir(ws.paths.project, { recursive: true });
    await writeFile(ws.paths.projectConfig, "{ not json", "utf8");

    const loaded = await ws.project.load();
    assert.equal(loaded.kind, "invalid");
    if (loaded.kind !== "invalid") return;
    assert.equal(loaded.cause, "malformed_json");

    assert.equal((await create(ws, "X")).kind, "exists");
    assert.equal(await readFile(ws.paths.projectConfig, "utf8"), "{ not json");
  });

  test("schema violation: parseable JSON that breaks an invariant is invalid with the issue named", async () => {
    const ws = await workspace("schema");
    await mkdir(ws.paths.project, { recursive: true });
    await writeFile(
      ws.paths.projectConfig,
      JSON.stringify({
        schema: "legion-flow-project/v1",
        id: "prj_x",
        name: "X",
        decisionOwners: [{ id: "bot", displayName: "Bot", kind: "agent" }],
        adapter: { default: "fake", http: { apiKey: "sk-inline" } },
        createdAt: new Date().toISOString(),
      }),
      "utf8"
    );
    const loaded = await ws.project.load();
    assert.equal(loaded.kind, "invalid");
    if (loaded.kind !== "invalid") return;
    assert.equal(loaded.cause, "schema");
    assert.match(loaded.detail, /decisionOwners\.0\.kind/);
    assert.match(loaded.detail, /apiKey/);
  });

  test("create requires this workspace's HeldLock: a forged handle and another workspace's lock are both rejected", async () => {
    const ws = await workspace("unlocked");
    const fake = {} as unknown as HeldLock;
    await assert.rejects(ws.project.create({ name: "X", adapterId: "fake", ownerId: "o" }, fake), TypeError);

    const other = await workspace("other-root");
    await other.lock.withLock(async (foreignHeld) => {
      await assert.rejects(
        ws.project.create({ name: "X", adapterId: "fake", ownerId: "o" }, foreignHeld),
        /HeldLock of this workspace/
      );
    }, "test");

    assert.equal((await ws.project.load()).kind, "absent");
  });
});
