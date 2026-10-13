import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, hooksCommand, doctorCommand } from "../dist/index.js";
import { flushHooks } from "../dist/hooks.js";

describe("M4 slice (u): hook cursors across an audit rebaseline", () => {
  test("after a rebaseline quarantines lines, events recorded after the repair are delivered although their numbers restart below the cursor; a cursor from before the rule is never clamped", async () => {
    const hits: string[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      hits.push((JSON.parse(body) as { event: { type: string; _seq: number } }).event.type);
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-u-"));
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    try {
      await initCommand(ctx(), { adapter: "fake", name: "Rebaseline", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.hooks = [{ name: "notify", on: ["spec_challenge_round"], url }];
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      await specCommand(ctx(), { new: "Rebaseline" });
      for (let i = 0; i < 3; i++) await specCommand(ctx(), { challenge: true });
      await flushHooks(ws);
      assert.equal(hits.length, 3);
      const cursorFile = join(ws.paths.varDir, "hooks", "cursor-notify.json");
      const before = JSON.parse(await readFile(cursorFile, "utf8")) as { seq: number; baseline: string | null };
      assert.equal(before.baseline, null, "a cursor records that it was taken under no baseline");

      // Make a line in the middle unparseable: it and every line after it are quarantined, so numbers restart below the cursor.
      const lines = (await readFile(ws.paths.eventsJsonl, "utf8")).split("\n").filter(Boolean);
      const broken = lines.findIndex((l) => l.includes('"spec_challenge_round"'));
      lines[broken] = lines[broken]!.slice(0, 25);
      await writeFile(ws.paths.eventsJsonl, lines.join("\n") + "\n");
      const repaired = await doctorCommand(ctx(), { rebaselineAudit: true, reason: "a disk incident truncated one line of the audit log", approver: "lead" });
      assert.equal(repaired.status, "ok", JSON.stringify(repaired.diagnostics));
      await specCommand(ctx(), { challenge: true });
      const newest = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; _seq: number }).filter((e) => e.type === "spec_challenge_round").at(-1)!;
      assert.ok(newest._seq <= before.seq, `the new event's number (${newest._seq}) is at or below the old cursor (${before.seq}), which is the hazard`);
      await flushHooks(ws);
      assert.equal(hits.length, 4, "the round recorded after the repair was delivered");
      const after = JSON.parse(await readFile(cursorFile, "utf8")) as { seq: number; baseline: string | null; fromSeqOverride?: unknown };
      assert.match(String(after.baseline), /^[0-9a-f]{64}$/);
      assert.ok(after.fromSeqOverride, "the consent's floor is held as an override, so the next flush does not jump back");
      await specCommand(ctx(), { challenge: true });
      await flushHooks(ws);
      assert.equal(hits.length, 5, "and the next one too");

      // A cursor written before this rule has no baseline field: it records the current one and is never clamped.
      const legacy = JSON.parse(await readFile(cursorFile, "utf8")) as Record<string, unknown>;
      delete legacy.baseline;
      delete legacy.fromSeqOverride;
      await writeFile(cursorFile, JSON.stringify(legacy));
      await flushHooks(ws);
      assert.equal(hits.length, 5, "nothing is redelivered");
      assert.match(String((JSON.parse(await readFile(cursorFile, "utf8")) as { baseline: unknown }).baseline), /^[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (u): the consent's starting point across a rebaseline", () => {
  test("a hook consented after the lines a rebaseline keeps still receives what is recorded after the repair; an idle flush leaves its cursor file untouched", async () => {
    const hits: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      hits.push("x");
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    const root = await mkdtemp(join(tmpdir(), "legion-flow-slice-u2-"));
    const ws = Workspace.at(root);
    const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
    try {
      await initCommand(ctx(), { adapter: "fake", name: "Late", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.hooks = [{ name: "notify", on: ["spec_challenge_round"], url }];
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
      await specCommand(ctx(), { new: "Late" });
      for (let i = 0; i < 2; i++) await specCommand(ctx(), { challenge: true });
      await hooksCommand(ctx(), { enable: "notify", approver: "lead" });
      const consent = JSON.parse(await readFile(join(ws.paths.project, "consents", (await readdir(join(ws.paths.project, "consents")))[0]!), "utf8")) as { fromSeq: number };
      for (let i = 0; i < 2; i++) await specCommand(ctx(), { challenge: true });
      await flushHooks(ws);
      assert.equal(hits.length, 2, "only rounds after the consent");
      // Quarantine from the spec_created line on: the rebaseline keeps one line, below the consent's starting point.
      const lines = (await readFile(ws.paths.eventsJsonl, "utf8")).split("\n").filter(Boolean);
      const broken = lines.findIndex((l) => l.includes('"spec_created"'));
      lines[broken] = lines[broken]!.slice(0, 25);
      await writeFile(ws.paths.eventsJsonl, lines.join("\n") + "\n");
      assert.equal((await doctorCommand(ctx(), { rebaselineAudit: true, reason: "a disk incident truncated one line of the audit log", approver: "lead" })).status, "ok");
      await specCommand(ctx(), { challenge: true });
      const newest = (await readFile(ws.paths.eventsJsonl, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string; _seq: number }).filter((e) => e.type === "spec_challenge_round").at(-1)!;
      assert.ok(newest._seq < consent.fromSeq, `the new round's number (${newest._seq}) is below the consent's starting point (${consent.fromSeq}), so only the override lets it through`);
      await flushHooks(ws);
      assert.equal(hits.length, 3, "the round recorded after the repair arrived");
      await specCommand(ctx(), { challenge: true });
      await flushHooks(ws);
      assert.equal(hits.length, 4, "and the next flush does not jump back to the consent's starting point");
      const cursorFile = join(ws.paths.varDir, "hooks", "cursor-notify.json");
      await flushHooks(ws); // moves past the hook_delivered event the previous flush recorded
      const stamp = (await stat(cursorFile)).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      await flushHooks(ws);
      assert.equal((await stat(cursorFile)).mtimeMs, stamp, "an idle flush does not rewrite the cursor");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
