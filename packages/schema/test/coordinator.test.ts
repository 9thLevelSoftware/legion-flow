import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorConfigSchema, routeTask, memberIds } from "../dist/index.js";

const config = (coordinator?: unknown) => ({ adapter: { default: "fake", http: { model: "base-model" } }, ...(coordinator ? { coordinator: CoordinatorConfigSchema.parse(coordinator) } : {}) });
const task = (filesAllowed: string[], member?: string) => ({ ...(member ? { member } : {}), contract: { filesAllowed } });

describe("M4 slice (j1): routing a task to a member", () => {
  const coord = { members: [{ id: "ui", adapter: "fake", model: "ui-model" }, { id: "db", adapter: "fake", model: "db-model", sandbox: "require" }], route: [{ match: ["src/ui/"], member: "ui" }, { match: ["src/db/", "migrations/**"], member: "db" }] };

  test("the plan's member wins over a matching rule; a rule covers a task only when it covers every entry; otherwise the default", () => {
    const c = config(coord);
    assert.deepEqual(routeTask(c, task(["src/ui/a.tsx"], "db")), { ok: true, member: { id: "db", adapter: "fake", model: "db-model", sandbox: "require", reason: "task" } });
    assert.equal((routeTask(c, task(["src/ui/a.tsx", "src/ui/b.tsx"])) as { member: { id: string } }).member.id, "ui");
    assert.equal((routeTask(c, task(["src/ui/"])) as { member: { id: string; reason: string } }).member.reason, "route src/ui/", "a directory entry matches a directory rule");
    assert.equal((routeTask(c, task(["src/db/x.ts", "migrations/001.sql"])) as { member: { id: string } }).member.id, "db");
    const mixed = routeTask(c, task(["src/ui/a.tsx", "src/db/x.ts"])) as { member: { id: string; model?: string; reason: string } };
    assert.deepEqual([mixed.member.id, mixed.member.model, mixed.member.reason], ["default", "base-model", "default"], "a task spanning two areas goes to the default, never to the first specialist");
    assert.deepEqual(routeTask(c, task(["src/ui/a.tsx"], "ghost")), { ok: false, reason: "member 'ghost' is not declared in project.json coordinator.members" });
    assert.deepEqual(memberIds(c.coordinator), ["default", "ui", "db"]);
  });

  test("the config refuses a member named default, a duplicate id, and a route to an undeclared member", () => {
    assert.throws(() => CoordinatorConfigSchema.parse({ members: [{ id: "default", adapter: "fake" }] }), /default adapter/);
    assert.throws(() => CoordinatorConfigSchema.parse({ members: [{ id: "a", adapter: "fake" }, { id: "a", adapter: "codex" }] }), /unique/);
    assert.throws(() => CoordinatorConfigSchema.parse({ members: [], route: [{ match: ["src/"], member: "nobody" }] }), /declared member/);
    assert.doesNotThrow(() => CoordinatorConfigSchema.parse({ route: [{ match: ["src/"], member: "default" }] }));
  });
});
