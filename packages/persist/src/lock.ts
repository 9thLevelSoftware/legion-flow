import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  acquiredAt: string;
  command?: string;
}

/**
 * Proof that the engine lock is held. Only this module can create one: the
 * constructor is private and the #brand field makes the type nominal, so a
 * structurally similar object does not satisfy it. Mutating operations
 * (AuditChain.append, rebaseline) require a HeldLock, which makes an
 * unguarded write a type error at the call site.
 */
let createHeldLock!: (info: LockInfo, lockPath: string) => HeldLock;

export class HeldLock {
  readonly #brand = true;

  private constructor(
    public readonly info: LockInfo,
    public readonly lockPath: string
  ) {}

  static {
    createHeldLock = (info, lockPath) => new HeldLock(info, lockPath);
  }

  /** Runtime guard for callers that cannot rely on the type alone. */
  static isHeld(value: unknown): value is HeldLock {
    return value instanceof HeldLock && value.#brand === true;
  }
}

export class LockAcquisitionError extends Error {
  constructor(public readonly holder: LockInfo | null) {
    super(
      holder
        ? `engine.lock held by active process PID ${holder.pid} since ${holder.acquiredAt}${holder.command ? ` (${holder.command})` : ""}. Refusing concurrent execution.`
        : "engine.lock is held by another process whose record could not be read. Refusing concurrent execution."
    );
    this.name = "LockAcquisitionError";
  }
}

export class LockReentrancyError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `engine.lock is already held by this process (PID ${holder.pid}${holder.command ? `, ${holder.command}` : ""}). Nested acquisition is a bug.`
    );
    this.name = "LockReentrancyError";
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // Process exists, but permission denied
  }
}

export class ProcessLock {
  constructor(public readonly lockPath: string) {}

  /** The current holder's record, or null when the file is absent, mid-write, or unparseable. */
  private async readHolder(): Promise<LockInfo | null> {
    let content: string;
    try {
      content = await readFile(this.lockPath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(content) as Partial<LockInfo>;
      if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "string") {
        return null;
      }
      return { pid: parsed.pid, acquiredAt: parsed.acquiredAt, command: parsed.command };
    } catch {
      return null;
    }
  }

  /**
   * Acquire exclusively. The lock file is created with the `wx` flag, so two
   * processes cannot both succeed. A lock whose holder is provably dead is
   * stolen with one retry; a live holder, an unreadable record, or our own PID
   * is refused. Every other error propagates.
   */
  async acquire(command?: string): Promise<HeldLock> {
    await mkdir(dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      const info: LockInfo = { pid: process.pid, acquiredAt: new Date().toISOString(), command };
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf8");
        } finally {
          await handle.close();
        }
        return createHeldLock(info, this.lockPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }

      const holder = await this.readHolder();
      if (holder === null) {
        // Absent again (lost a race) or mid-write by another process: never steal.
        throw new LockAcquisitionError(null);
      }
      if (holder.pid === process.pid) {
        throw new LockReentrancyError(holder);
      }
      if (isPidAlive(holder.pid)) {
        throw new LockAcquisitionError(holder);
      }
      // Stale: the holder is dead. Remove it and retry the exclusive create once.
      try {
        await unlink(this.lockPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }

    throw new LockAcquisitionError(null);
  }

  /** Release only if the lock on disk is ours; a lock taken by another process is left alone. */
  async release(lock: HeldLock): Promise<void> {
    if (!HeldLock.isHeld(lock)) {
      throw new TypeError("release requires a HeldLock obtained from acquire()");
    }
    const holder = await this.readHolder();
    if (holder === null || holder.pid !== process.pid) {
      return;
    }
    try {
      await unlink(this.lockPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  async withLock<T>(fn: (lock: HeldLock) => Promise<T>, command?: string): Promise<T> {
    const lock = await this.acquire(command);
    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }
}
