import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { runWorkflow, forkRun, spawnFrozen, type Workflow } from "../dist/index.js";

const twoNodes: Workflow = {
  id: "slice-r",
  version: "1",
  entry: "a",
  state: { trail: { kind: "append" } },
  nodes: {
    a: { run: () => ({ writes: { trail: "a" }, next: ["b"] }) },
    b: { run: () => ({ writes: { trail: "b" } }) },
  },
};

describe("M4 slice (r): forks stay outside task accounting; the POSIX process-group kill", () => {
  // Pinned on purpose: a fork starts running and undriven, so carrying the task would make it read as open work.
  test("a fork records where it came from and carries none of the parent's task, member, steps, or broadcast role", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-fork-"));
    const ws = Workspace.at(root);
    try {
      const member = { id: "tester", adapter: "fake", model: "m", reason: "coordinate" };
      const steps = [member, { id: "default", adapter: "fake", reason: "coordinate step 2" }];
      const done = await ws.lock.withLock((held) => runWorkflow(ws, twoNodes, held, { task: { planId: "pln_x1", taskId: "T-01" }, member, coordinate: { steps }, broadcast: { id: "bcs_x1", role: "member" } }), "test");
      assert.equal(done.kind, "complete");
      const fork = await ws.lock.withLock((held) => forkRun(ws, twoNodes, done.runId!, 1, undefined, held), "test");
      const forked = (await ws.runs.load(fork.runId!))!.run;
      assert.ok(forked.kind === "workflow");
      if (forked.kind !== "workflow") return;
      assert.deepEqual(forked.forkedFrom, { runId: done.runId, seq: 1 });
      assert.deepEqual([forked.task, forked.member, forked.coordinate, forked.broadcast], [undefined, undefined, undefined, undefined]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a timeout signals the whole process group, and SIGKILL follows for a group that ignores SIGTERM", { skip: process.platform === "win32" ? "POSIX only (verified here inside a Linux container)" : undefined }, async () => {
    const out = await spawnFrozen({ command: "sh", args: ["-c", "trap '' TERM; sleep 100 & sleep 100 & wait"], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, signal: new AbortController().signal, timeoutMs: 1000 });
    assert.equal(out.timedOut, true);
    await new Promise((r) => setTimeout(r, 4500));
    const live = execSync("ps -eo pid,stat,args | grep '[s]leep 100' | grep -v ' Z' | wc -l").toString().trim();
    assert.equal(Number(live), 0, "no grandchild outlives the kill");
  });
});
