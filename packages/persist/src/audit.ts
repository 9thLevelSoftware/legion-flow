import { createHash } from "node:crypto";
import { readFile, appendFile, mkdir, open, stat, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { HeldLock } from "./lock.js";
import type { AuditEventType } from "@9thlevelsoftware/legion-flow-schema";

/**
 * A recorded rebaseline. Everything before `byteOffset` is an archived region
 * whose bytes are pinned by `priorBytesSha256`; the chain restarts from that
 * hash. History is never rewritten; the only repair is this recorded baseline.
 */
export interface AuditBaseline {
  /** Lines kept before the baseline event. */
  seq: number;
  byteOffset: number;
  priorBytesSha256: string;
  at: string;
  reason: string;
  operator: string;
}

export interface AuditChainState {
  length: number;
  lastDigest: string;
  byteOffset: number;
  baseline?: AuditBaseline;
}

export interface RebaselineOutcome {
  state: AuditChainState;
  keptLines: number;
  quarantinedLines: number;
  quarantinedBytes: number;
  quarantinePath: string | null;
  archivedChainPath: string | null;
  priorVerify: VerificationResult | { valid: false; error: string };
}

export interface VerificationResult {
  valid: boolean;
  verifiedCount: number;
  expectedCount: number;
  /** One committed event sits after the indexed tail; the next locked write folds it in. */
  unindexedTail?: boolean;
  error?: string;
}

export const INITIAL_DIGEST = "0".repeat(64);

export class AuditChainRewindRefusedError extends Error {
  constructor(msg: string) {
    super(`audit chain rewind refused: ${msg}`);
    this.name = "AuditChainRewindRefusedError";
  }
}

export class AuditChainInconsistentTailError extends Error {
  constructor(msg: string) {
    super(`audit chain tail is inconsistent: ${msg}`);
    this.name = "AuditChainInconsistentTailError";
  }
}

type TailState =
  | { kind: "clean" }
  | { kind: "orphan"; line: string; digest: string; bytes: number }
  | { kind: "rewound"; size: number }
  | { kind: "inconsistent"; reason: string };

function digestLine(prevDigest: string, line: string): string {
  return createHash("sha256").update(prevDigest + line + "\n").digest("hex");
}

/**
 * Append-only, hash-chained event log. `events.jsonl` holds one JSON event per
 * line, each carrying its sequence number and the previous digest; `chain.json`
 * indexes the committed tail. Mutations require a HeldLock (see lock.ts), so no
 * caller can append without the engine lock.
 */
export class AuditChain {
  constructor(
    public readonly eventsPath: string,
    public readonly chainPath: string
  ) {}

  async readChain(): Promise<AuditChainState> {
    try {
      const content = await readFile(this.chainPath, "utf8");
      return JSON.parse(content) as AuditChainState;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { length: 0, lastDigest: INITIAL_DIGEST, byteOffset: 0 };
      }
      throw err;
    }
  }

  /** The hash of the events file's bytes in [0, end). */
  private async hashPrefix(end: number): Promise<string> {
    const bytes = await readFile(this.eventsPath);
    return createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
  }

  /** Classify what sits on disk after the indexed tail, reading only from byteOffset. */
  private async readTail(state: AuditChainState): Promise<TailState> {
    let size: number;
    try {
      size = (await stat(this.eventsPath)).size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return state.length === 0
          ? { kind: "clean" }
          : { kind: "rewound", size: 0 };
      }
      throw err;
    }

    if (size < state.byteOffset) {
      return { kind: "rewound", size };
    }
    if (size === state.byteOffset) {
      return { kind: "clean" };
    }

    const handle = await open(this.eventsPath, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - state.byteOffset);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, state.byteOffset + filled);
        if (bytesRead === 0) {
          return { kind: "inconsistent", reason: "events file shrank while its tail was being read" };
        }
        filled += bytesRead;
      }
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    if (!text.endsWith("\n")) {
      return { kind: "inconsistent", reason: "partial line after the indexed tail" };
    }
    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length !== 1) {
      return { kind: "inconsistent", reason: `${lines.length} unindexed lines after the indexed tail` };
    }

    const line = lines[0]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { kind: "inconsistent", reason: "unparseable line after the indexed tail" };
    }
    if (parsed._seq !== state.length + 1 || parsed._prevDigest !== state.lastDigest) {
      return { kind: "inconsistent", reason: "unindexed line does not chain from the recorded tail" };
    }
    return {
      kind: "orphan",
      line,
      digest: digestLine(state.lastDigest, line),
      bytes: Buffer.byteLength(line + "\n", "utf8"),
    };
  }

  private async writeState(state: AuditChainState): Promise<void> {
    await atomicWriteFile(this.chainPath, JSON.stringify(state, null, 2) + "\n");
  }

  /**
   * Append one event under the engine lock. Before writing, the tail is
   * checked: a truncated log is refused (rewind), a single committed-but-
   * unindexed event is folded into the index, and any other inconsistency is
   * refused so the log never gets worse.
   */
  async append(event: { type: AuditEventType } & Record<string, unknown>, lock: HeldLock): Promise<AuditChainState> {
    if (!HeldLock.isHeld(lock)) {
      throw new TypeError("AuditChain.append requires a HeldLock obtained from ProcessLock.acquire()");
    }
    // The lock keeps other processes out; within one process, parallel runs (execute --jobs) append
    // concurrently, and a read-tail-then-append is a lost update unless the appends are chained.
    return serializeAppends(this.eventsPath, () => this.appendNow(event, lock));
  }

  private async appendNow(event: Record<string, unknown>, lock: HeldLock): Promise<AuditChainState> {
    void lock;

    let chainState = await this.readChain();
    const tail = await this.readTail(chainState);
    switch (tail.kind) {
      case "rewound":
        throw new AuditChainRewindRefusedError(
          `events file is ${tail.size} bytes but the index records ${chainState.byteOffset}`
        );
      case "inconsistent":
        throw new AuditChainInconsistentTailError(tail.reason);
      case "orphan":
        chainState = {
          ...chainState,
          length: chainState.length + 1,
          lastDigest: tail.digest,
          byteOffset: chainState.byteOffset + tail.bytes,
        };
        await this.writeState(chainState);
        break;
      case "clean":
        break;
    }

    await mkdir(dirname(this.eventsPath), { recursive: true });
    await mkdir(dirname(this.chainPath), { recursive: true });

    const eventPayload = {
      ...event,
      _seq: chainState.length + 1,
      _prevDigest: chainState.lastDigest,
      _timestamp: new Date().toISOString(),
    };

    const serializedLine = JSON.stringify(eventPayload) + "\n";
    const lineDigest = digestLine(chainState.lastDigest, serializedLine.slice(0, -1));

    await appendFile(this.eventsPath, serializedLine, "utf8");

    // The baseline, when one exists, rides along forever: every later state still pins the archived region.
    const nextState: AuditChainState = {
      ...chainState,
      length: chainState.length + 1,
      lastDigest: lineDigest,
      byteOffset: chainState.byteOffset + Buffer.byteLength(serializedLine, "utf8"),
    };

    await this.writeState(nextState);
    return nextState;
  }

  /** Read-only full replay. Never writes, so a foldable orphan is reported, not folded. */
  async verify(): Promise<VerificationResult> {
    let chainState: AuditChainState;
    try {
      chainState = await this.readChain();
    } catch (err: unknown) {
      return { valid: false, verifiedCount: 0, expectedCount: 0, error: `chain.json is unreadable: ${(err as Error).message}` };
    }

    let fileBytes: Buffer;
    let fileContent: string;
    try {
      fileBytes = await readFile(this.eventsPath);
      fileContent = fileBytes.toString("utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return chainState.length === 0
          ? { valid: true, verifiedCount: 0, expectedCount: 0 }
          : {
              valid: false,
              verifiedCount: 0,
              expectedCount: chainState.length,
              error: `Events file missing or unreadable: ${(err as Error).message}`,
            };
      }
      return {
        valid: false,
        verifiedCount: 0,
        expectedCount: chainState.length,
        error: `Events file missing or unreadable: ${(err as Error).message}`,
      };
    }

    // A baseline pins the archived region by hash and restarts the chain after it.
    const baseline = chainState.baseline;
    let startSeq = 0;
    let runningDigest = INITIAL_DIGEST;
    let body = fileContent;
    if (baseline) {
      if (fileBytes.length < baseline.byteOffset) {
        return { valid: false, verifiedCount: 0, expectedCount: chainState.length, error: `events file is shorter than the archived region (${fileBytes.length} < ${baseline.byteOffset})` };
      }
      const prior = createHash("sha256").update(fileBytes.subarray(0, baseline.byteOffset)).digest("hex");
      if (prior !== baseline.priorBytesSha256) {
        return { valid: false, verifiedCount: 0, expectedCount: chainState.length, error: "the archived region before the audit baseline was altered" };
      }
      startSeq = baseline.seq;
      runningDigest = baseline.priorBytesSha256;
      body = fileBytes.subarray(baseline.byteOffset).toString("utf8");
    }
    const lines = body.split("\n").filter((line) => line.length > 0);
    const totalLines = startSeq + lines.length;
    if (totalLines < chainState.length) {
      return {
        valid: false,
        verifiedCount: totalLines,
        expectedCount: chainState.length,
        error: `Line count mismatch: expected ${chainState.length}, found ${totalLines} (log was rewound)`,
      };
    }
    if (totalLines > chainState.length + 1) {
      return {
        valid: false,
        verifiedCount: chainState.length,
        expectedCount: chainState.length,
        error: `${totalLines - chainState.length} unindexed lines after the indexed tail`,
      };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const seq = startSeq + i + 1;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { valid: false, verifiedCount: seq - 1, expectedCount: chainState.length, error: `Unparseable JSON at line ${seq}` };
      }
      if (parsed._seq !== seq) {
        return {
          valid: false,
          verifiedCount: seq - 1,
          expectedCount: chainState.length,
          error: `Sequence mismatch at line ${seq}: expected ${seq}, found ${parsed._seq}`,
        };
      }
      if (parsed._prevDigest !== runningDigest) {
        return { valid: false, verifiedCount: seq - 1, expectedCount: chainState.length, error: `Previous digest mismatch at line ${seq}` };
      }
      runningDigest = digestLine(runningDigest, line);

      if (seq === chainState.length && runningDigest !== chainState.lastDigest) {
        return {
          valid: false,
          verifiedCount: seq,
          expectedCount: chainState.length,
          error: `Final digest mismatch: computed ${runningDigest}, expected ${chainState.lastDigest}`,
        };
      }
    }

    if (chainState.length === 0 && totalLines === 0) {
      return { valid: true, verifiedCount: 0, expectedCount: 0 };
    }

    const unindexedTail = totalLines === chainState.length + 1;
    return {
      valid: true,
      verifiedCount: totalLines,
      expectedCount: chainState.length,
      ...(unindexedTail ? { unindexedTail: true } : {}),
    };
  }

  /**
   * The one repair. The log is never rewritten: every parseable line is kept
   * as an archived region pinned by the hash of its bytes; an unparseable line
   * and everything after it is moved to a quarantine file; the old chain.json
   * is archived; and a recorded `audit_rebaselined` event restarts the chain
   * from the region's hash. `verify` passes afterwards and fails again the
   * moment the archived region is touched.
   */
  async rebaseline(reason: string, operator: string, lock: HeldLock, now: Date = new Date()): Promise<RebaselineOutcome> {
    if (!HeldLock.isHeld(lock)) {
      throw new TypeError("AuditChain.rebaseline requires a HeldLock obtained from ProcessLock.acquire()");
    }
    if (reason.length < 24) {
      throw new Error("Audit rebaseline reason must be at least 24 characters.");
    }
    let priorVerify: RebaselineOutcome["priorVerify"];
    try {
      priorVerify = await this.verify();
    } catch (err: unknown) {
      priorVerify = { valid: false, error: (err as Error).message };
    }
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    await mkdir(dirname(this.eventsPath), { recursive: true });
    await mkdir(dirname(this.chainPath), { recursive: true });

    let bytes: Buffer;
    try {
      bytes = await readFile(this.eventsPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      bytes = Buffer.alloc(0);
    }
    // Keep every parseable line; quarantine from the first unparseable one (or a partial last line).
    let keptEnd = 0;
    let keptLines = 0;
    let cursor = 0;
    while (cursor < bytes.length) {
      const nl = bytes.indexOf(0x0a, cursor);
      if (nl < 0) break; // partial line: quarantined
      const line = bytes.subarray(cursor, nl).toString("utf8");
      try {
        JSON.parse(line);
      } catch {
        break;
      }
      keptEnd = nl + 1;
      keptLines += 1;
      cursor = nl + 1;
    }
    let quarantinePath: string | null = null;
    const quarantinedBytes = bytes.length - keptEnd;
    let quarantinedLines = 0;
    if (quarantinedBytes > 0) {
      const tail = bytes.subarray(keptEnd);
      quarantinedLines = tail.toString("utf8").split("\n").filter((l) => l.length > 0).length;
      quarantinePath = join(dirname(this.eventsPath), `events.quarantined-${stamp}.jsonl`);
      await atomicWriteFile(quarantinePath, tail);
      await atomicWriteFile(this.eventsPath, bytes.subarray(0, keptEnd));
    }
    let archivedChainPath: string | null = null;
    try {
      await stat(this.chainPath);
      archivedChainPath = join(dirname(this.chainPath), `chain.before-${stamp}.json`);
      await copyFile(this.chainPath, archivedChainPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const priorBytesSha256 = createHash("sha256").update(bytes.subarray(0, keptEnd)).digest("hex");
    const event = {
      type: "audit_rebaselined",
      operator,
      reason,
      keptLines,
      quarantinedLines,
      quarantinedBytes,
      quarantinePath,
      archivedChainPath,
      priorVerify: priorVerify.valid ? "valid" : priorVerify.error,
      priorBytesSha256,
      _seq: keptLines + 1,
      _prevDigest: priorBytesSha256,
      _timestamp: now.toISOString(),
    };
    const serializedLine = JSON.stringify(event) + "\n";
    // append() would refuse exactly the state being repaired; this is the one direct write.
    await appendFile(this.eventsPath, serializedLine, "utf8");
    const state: AuditChainState = {
      length: keptLines + 1,
      lastDigest: digestLine(priorBytesSha256, serializedLine.slice(0, -1)),
      byteOffset: keptEnd + Buffer.byteLength(serializedLine, "utf8"),
      baseline: { seq: keptLines, byteOffset: keptEnd, priorBytesSha256, at: now.toISOString(), reason, operator },
    };
    await this.writeState(state);
    return { state, keptLines, quarantinedLines, quarantinedBytes, quarantinePath, archivedChainPath, priorVerify };
  }
}

const appendQueues = new Map<string, Promise<unknown>>();
function serializeAppends<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  appendQueues.set(key, tail);
  void tail.then(() => {
    if (appendQueues.get(key) === tail) appendQueues.delete(key);
  });
  return next;
}
