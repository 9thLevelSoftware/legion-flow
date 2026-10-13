import { ZodError } from "zod";
import type { RetryPolicy } from "./types.js";

export const DEFAULT_RETRY: Required<Omit<RetryPolicy, "retryOn">> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  factor: 2,
  maxDelayMs: 128_000,
  jitter: true,
};

/** Deterministic errors never get a second attempt: the same input would fail the same way. */
export function isDeterministicError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError || error instanceof ZodError;
}

export interface RetryHooks {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy | undefined, hooks: RetryHooks): Promise<T> {
  const p = { ...DEFAULT_RETRY, ...policy };
  const retryOn = policy?.retryOn ?? ((e: unknown) => !isDeterministicError(e));
  let attempt = 0;
  let delay = p.initialDelayMs;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= p.maxAttempts || !retryOn(error)) throw error;
      const wait = p.jitter ? Math.round(delay * (0.5 + hooks.random())) : delay;
      await hooks.sleep(Math.min(wait, p.maxDelayMs));
      delay = Math.min(delay * p.factor, p.maxDelayMs);
    }
  }
}
