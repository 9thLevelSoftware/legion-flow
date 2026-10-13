import { writeFile, rename, unlink, mkdir, lstat } from "node:fs/promises";
import { dirname } from "node:path";

export class SymlinkRefusedError extends Error {
  constructor(path: string) {
    super(`Symlink mutation refused: '${path}' is a symlink or links to one.`);
    this.name = "SymlinkRefusedError";
  }
}

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<AtomicWriteOptions> = {
  encoding: "utf8",
  mode: 0o666,
  maxRetries: 10,
  retryDelayMs: 50,
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function assertNoSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new SymlinkRefusedError(path);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  options?: AtomicWriteOptions
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const dir = dirname(targetPath);

  await assertNoSymlink(targetPath);
  await mkdir(dir, { recursive: true });

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  try {
    await writeFile(tempPath, content, {
      encoding: typeof content === "string" ? opts.encoding : undefined,
      mode: opts.mode,
    });

    let attempt = 0;
    while (true) {
      try {
        await rename(tempPath, targetPath);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        // Windows file locking retry (EPERM, EACCES, EBUSY)
        if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
          attempt++;
          if (attempt >= opts.maxRetries) {
            throw err;
          }
          await sleep(opts.retryDelayMs * attempt);
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}
