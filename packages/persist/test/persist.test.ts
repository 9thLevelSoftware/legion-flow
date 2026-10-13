import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  atomicWriteFile,
  AuditChain,
  AuditChainRewindRefusedError,
  AuditChainInconsistentTailError,
  INITIAL_DIGEST,
  ProcessLock,
  HeldLock,
  LockAcquisitionError,
  LockReentrancyError,
  ensureLegionFlowLayout,
} from "../dist/index.js";

function sleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

async function killAndWait(child: ChildProcess): Promise<number> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
  return child.pid!;
}

describe("Persistence Engine Tests", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "legion-flow-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A fresh audit chain plus a lock to write it with. */
  function chainIn(name: string) {
    const dir = join(tempDir, name);
    return {
      audit: new AuditChain(join(dir, "events.jsonl"), join(dir, "chain.json")),
      lock: new ProcessLock(join(dir, "engine.lock")),
      eventsPath: join(dir, "events.jsonl"),
      chainPath: join(dir, "chain.json"),
    };
  }

  test("atomicWriteFile writes and overwrites correctly", async () => {
    const filePath = join(tempDir, "sub", "test.txt");
    await atomicWriteFile(filePath, "Hello World 1");
    assert.equal(await readFile(filePath, "utf8"), "Hello World 1");

    await atomicWriteFile(filePath, "Hello World 2");
    assert.equal(await readFile(filePath, "utf8"), "Hello World 2");
  });

  test("AuditChain appends under the lock, verifies, and detects tampering", async () => {
    const { audit, lock, eventsPath } = chainIn("audit");

    const initialCheck = await audit.verify();
    assert.equal(initialCheck.valid, true);
    assert.equal(initialCheck.verifiedCount, 0);

    await lock.withLock(async (held) => {
      await audit.append({ action: "init", user: "dev" }, held);
      await audit.append({ action: "spec_frozen", specId: "SPC-01" }, held);
      await audit.append({ action: "plan_approved", planId: "PLN-01" }, held);
    });

    const checkAfterAppend = await audit.verify();
    assert.equal(checkAfterAppend.valid, true);
    assert.equal(checkAfterAppend.verifiedCount, 3);
    assert.equal(checkAfterAppend.unindexedTail, undefined);

    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    const tampered = JSON.parse(lines[1]!);
    tampered.specId = "SPC-TAMPERED";
    lines[1] = JSON.stringify(tampered);
    await writeFile(eventsPath, lines.join("\n") + "\n", "utf8");

    const tamperedCheck = await audit.verify();
    assert.equal(tamperedCheck.valid, false);
    assert.match(tamperedCheck.error || "", /digest mismatch/i);
  });

  test("AuditChain.append is a type-level and runtime error without a HeldLock", async () => {
    const { audit } = chainIn("unguarded");
    // @ts-expect-error append requires a HeldLock
    await assert.rejects(audit.append({ action: "x" }), TypeError);
    // A structurally similar object is not a HeldLock either.
    const fake = { info: { pid: process.pid, acquiredAt: "now" }, lockPath: "x" } as unknown as HeldLock;
    await assert.rejects(audit.append({ action: "x" }, fake), TypeError);
  });

  test("AuditChain rebaseline appends a valid record under the lock", async () => {
    const { audit, lock } = chainIn("rebaseline");
    await lock.withLock(async (held) => {
      await audit.append({ action: "action_1" }, held);
      await audit.rebaseline("Operator audit rebaseline after review", "admin", held);
    });
    const check = await audit.verify();
    assert.equal(check.valid, true);
    assert.equal(check.verifiedCount, 2);
  });

  test("torn tail: one committed-but-unindexed event is reported by verify and folded in by the next append", async () => {
    const { audit, lock, eventsPath, chainPath } = chainIn("torn");
    await lock.withLock(async (held) => {
      await audit.append({ action: "one" }, held);
      await audit.append({ action: "two" }, held);
    });

    // Simulate a crash after the event write and before the index write.
    const state = JSON.parse(await readFile(chainPath, "utf8")) as { length: number; lastDigest: string };
    const orphan = JSON.stringify({ action: "three", _seq: 3, _prevDigest: state.lastDigest, _timestamp: "t" }) + "\n";
    await appendFile(eventsPath, orphan, "utf8");

    const reported = await audit.verify();
    assert.equal(reported.valid, true);
    assert.equal(reported.verifiedCount, 3);
    assert.equal(reported.expectedCount, 2);
    assert.equal(reported.unindexedTail, true);

    const after = await lock.withLock((held) => audit.append({ action: "four" }, held));
    assert.equal(after.length, 4);
    const folded = await audit.verify();
    assert.equal(folded.valid, true);
    assert.equal(folded.verifiedCount, 4);
    assert.equal(folded.unindexedTail, undefined);
    assert.equal((await stat(eventsPath)).size, after.byteOffset);
  });

  test("rewind: a truncated log is refused on append and reported by verify", async () => {
    const { audit, lock, eventsPath } = chainIn("rewind");
    await lock.withLock(async (held) => {
      await audit.append({ action: "one" }, held);
      await audit.append({ action: "two" }, held);
    });
    const firstLine = (await readFile(eventsPath, "utf8")).split("\n")[0]! + "\n";
    await writeFile(eventsPath, firstLine, "utf8");

    await assert.rejects(
      lock.withLock((held) => audit.append({ action: "three" }, held)),
      AuditChainRewindRefusedError
    );
    const check = await audit.verify();
    assert.equal(check.valid, false);
    assert.match(check.error ?? "", /rewound/);
  });

  test("inconsistent tail: anything other than one chained orphan is refused, never appended onto", async () => {
    const { audit, lock, eventsPath } = chainIn("inconsistent");
    await lock.withLock((held) => audit.append({ action: "one" }, held));
    await appendFile(eventsPath, JSON.stringify({ action: "bad", _seq: 2, _prevDigest: "nope" }) + "\n", "utf8");

    await assert.rejects(
      lock.withLock((held) => audit.append({ action: "two" }, held)),
      AuditChainInconsistentTailError
    );
    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "nothing was appended onto the bad tail");
  });

  test("events without an index: one genesis-chained line is foldable, two are not", async () => {
    const { audit, eventsPath } = chainIn("noindex");
    await mkdir(join(tempDir, "noindex"), { recursive: true });
    await writeFile(eventsPath, JSON.stringify({ action: "a", _seq: 1, _prevDigest: INITIAL_DIGEST }) + "\n", "utf8");
    const one = await audit.verify();
    assert.equal(one.valid, true);
    assert.equal(one.unindexedTail, true);

    await appendFile(eventsPath, JSON.stringify({ action: "b", _seq: 2, _prevDigest: "x" }) + "\n", "utf8");
    const two = await audit.verify();
    assert.equal(two.valid, false);
  });

  test("ProcessLock: exclusive acquire, live holder refused, dead holder stolen, release is guarded", async () => {
    const lockPath = join(tempDir, "var", "engine.lock");
    const lock = new ProcessLock(lockPath);
    await mkdir(join(tempDir, "var"), { recursive: true });

    const child = sleeper();
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, acquiredAt: "2026-10-08T00:00:00Z", command: "sleeper" }) + "\n");

    await assert.rejects(lock.acquire("test"), (err: unknown) => {
      assert.ok(err instanceof LockAcquisitionError);
      assert.equal(err.holder?.pid, child.pid);
      return true;
    });

    // release() with a handle for a different lock never removes someone else's lock.
    const otherLock = new ProcessLock(join(tempDir, "var", "other.lock"));
    const otherHeld = await otherLock.acquire("other");
    await lock.release(otherHeld);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, child.pid);
    await otherLock.release(otherHeld);

    const deadPid = await killAndWait(child);
    const held = await lock.acquire("test");
    assert.equal(held.info.pid, process.pid);
    assert.notEqual(JSON.parse(await readFile(lockPath, "utf8")).pid, deadPid);

    // Re-entrancy is a bug, not a steal.
    await assert.rejects(lock.acquire("nested"), LockReentrancyError);

    await lock.release(held);
    await assert.rejects(stat(lockPath), /ENOENT/);

    let executed = false;
    await lock.withLock(async (inner) => {
      assert.ok(HeldLock.isHeld(inner));
      executed = true;
    }, "with-lock-cmd");
    assert.equal(executed, true);
    await assert.rejects(stat(lockPath), /ENOENT/);
  });

  test("ProcessLock: the exclusive create itself holds across two real processes", async () => {
    const lockPath = join(tempDir, "var3", "engine.lock");
    await mkdir(join(tempDir, "var3"), { recursive: true });
    const distUrl = new URL("../dist/index.js", import.meta.url).href;
    const script = [
      `import { ProcessLock } from ${JSON.stringify(distUrl)};`,
      `await new ProcessLock(process.env.LOCK_PATH).acquire("child");`,
      `process.stdout.write("held\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("held")) resolve();
        });
        child.once("exit", (code) => reject(new Error(`child exited early with ${code}`)));
      });

      const lock = new ProcessLock(lockPath);
      await assert.rejects(lock.acquire("parent"), (err: unknown) => {
        assert.ok(err instanceof LockAcquisitionError);
        assert.equal(err.holder?.pid, child.pid);
        assert.equal(err.holder?.command, "child");
        return true;
      });
    } finally {
      await killAndWait(child);
    }

    // The child never released; its lock is now stale and gets stolen.
    const lock = new ProcessLock(lockPath);
    const held = await lock.acquire("parent");
    assert.equal(held.info.pid, process.pid);
    await lock.release(held);
  });

  test("ProcessLock: an unreadable holder record is refused, never stolen", async () => {
    const lockPath = join(tempDir, "var2", "engine.lock");
    await mkdir(join(tempDir, "var2"), { recursive: true });
    await writeFile(lockPath, "", "utf8"); // another process mid-write
    await assert.rejects(new ProcessLock(lockPath).acquire("test"), (err: unknown) => {
      assert.ok(err instanceof LockAcquisitionError);
      assert.equal(err.holder, null);
      return true;
    });
    assert.equal(await readFile(lockPath, "utf8"), "");
  });

  test("ensureLegionFlowLayout sets up expected directories and var gitignore", async () => {
    const paths = await ensureLegionFlowLayout(tempDir);
    const gitignoreContent = await readFile(join(paths.root, ".gitignore"), "utf8");
    assert.match(gitignoreContent, /var\//);
  });
});
