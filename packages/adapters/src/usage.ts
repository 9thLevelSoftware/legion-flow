import type { AdapterUsage } from "@9thlevelsoftware/legion-flow-engine";

export interface ParsedVendorOutput {
  usage: AdapterUsage;
  /** The agent's final message, when the output carries one. */
  resultText: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * `claude -p --output-format json` prints one JSON document:
 * `{ type: "result", subtype, is_error, num_turns, result, total_cost_usd, usage: { input_tokens, output_tokens, ... } }`.
 * Anything else is reported as unknown, never guessed.
 */
export function parseClaudeOutput(stdout: string): ParsedVendorOutput {
  const text = stdout.trim();
  const start = text.lastIndexOf("\n{");
  const candidate = text.startsWith("{") ? text : start >= 0 ? text.slice(start + 1) : text;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return { usage: { known: false, reason: "stdout is not a JSON result document" }, resultText: null };
  }
  if (doc.type !== "result") return { usage: { known: false, reason: `unexpected document type ${String(doc.type)}` }, resultText: null };
  const usage = (doc.usage ?? {}) as Record<string, unknown>;
  return {
    usage: {
      known: true,
      turns: num(doc.num_turns),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      costUsd: num(doc.total_cost_usd),
    },
    resultText: typeof doc.result === "string" ? doc.result : null,
  };
}

/**
 * `codex exec --json` prints JSON lines: `thread.started`, `turn.started`,
 * `item.completed` (with `item.type: "agent_message"` and `text`), and
 * `turn.completed` with `usage: { input_tokens, cached_input_tokens, output_tokens }`.
 * Cost is never reported, so it is null even when tokens are known.
 */
export function parseCodexOutput(stdout: string): ParsedVendorOutput {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  let turns = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let resultText: string | null = null;
  let sawEvent = false;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawEvent = true;
    if (ev.type === "turn.completed") {
      turns += 1;
      const u = (ev.usage ?? {}) as Record<string, unknown>;
      inputTokens = (inputTokens ?? 0) + (num(u.input_tokens) ?? 0);
      outputTokens = (outputTokens ?? 0) + (num(u.output_tokens) ?? 0);
    }
    if (ev.type === "item.completed") {
      const item = (ev.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") resultText = item.text;
    }
  }
  if (!sawEvent) return { usage: { known: false, reason: "stdout carries no codex JSON events" }, resultText: null };
  return { usage: { known: true, turns, inputTokens, outputTokens, costUsd: null }, resultText };
}
