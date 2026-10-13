import { createHash } from "node:crypto";
import { loopbackUrlProblem, type EvalCase, type EvalMetric } from "@9thlevelsoftware/legion-flow-schema";

/** One metric score: a number in [0, 1] with its reason, or unevaluable with the reason it could not be scored. Never a silent 0. */
export type ScoreOutcome = { ok: true; score: number; reason: string; promptHash: string | null } | { ok: false; reason: string; promptHash: string | null };

export interface ScoreInput {
  metric: EvalMetric;
  evalCase: EvalCase;
  stdout: string;
  exitCode: number | null;
  signal?: AbortSignal;
}

export type MetricScorer = (input: ScoreInput) => Promise<ScoreOutcome>;

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

/** The four deterministic scorers: 1 or 0 with a reason; a missing expectation is unevaluable. */
export function scoreDeterministic(input: ScoreInput): ScoreOutcome {
  const e = input.evalCase.expected;
  switch (input.metric.scorer) {
    case "exact":
      if (e.stdout === undefined) return { ok: false, reason: "exact needs expected.stdout", promptHash: null };
      return norm(input.stdout) === norm(e.stdout)
        ? { ok: true, score: 1, reason: "stdout matches expected.stdout", promptHash: null }
        : { ok: true, score: 0, reason: `stdout differs from expected.stdout (got '${norm(input.stdout).slice(0, 80)}')`, promptHash: null };
    case "contains": {
      if (!e.contains || e.contains.length === 0) return { ok: false, reason: "contains needs expected.contains", promptHash: null };
      const missing = e.contains.filter((c) => !input.stdout.includes(c));
      return missing.length === 0
        ? { ok: true, score: 1, reason: `stdout contains all ${e.contains.length} expected string(s)`, promptHash: null }
        : { ok: true, score: 0, reason: `stdout lacks: ${missing.map((m) => `'${m.slice(0, 40)}'`).join(", ")}`, promptHash: null };
    }
    case "regex": {
      if (!e.pattern) return { ok: false, reason: "regex needs expected.pattern", promptHash: null };
      let re: RegExp;
      try {
        re = new RegExp(e.pattern, "m");
      } catch (err) {
        return { ok: false, reason: `expected.pattern is not a valid regular expression: ${(err as Error).message}`, promptHash: null };
      }
      return re.test(input.stdout)
        ? { ok: true, score: 1, reason: `stdout matches /${e.pattern}/`, promptHash: null }
        : { ok: true, score: 0, reason: `stdout does not match /${e.pattern}/`, promptHash: null };
    }
    case "exit_code": {
      const want = e.exitCode ?? 0;
      return input.exitCode === want
        ? { ok: true, score: 1, reason: `exited ${want} as expected`, promptHash: null }
        : { ok: true, score: 0, reason: `exited ${input.exitCode ?? "without a code"}, expected ${want}`, promptHash: null };
    }
    case "judge":
      return { ok: false, reason: "the judge scorer is not deterministic", promptHash: null };
  }
}

export interface JudgeConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A judge must be on this machine (the shared loopback rule) and its URL the API root. */
export function judgeUrlProblem(baseUrl: string): string | null {
  const problem = loopbackUrlProblem(baseUrl, "judge.baseUrl");
  if (problem) return problem;
  if (/\/chat\/completions\/?$/.test(new URL(baseUrl).pathname)) return "judge.baseUrl must be the API root (for example http://127.0.0.1:11434/v1); /chat/completions is appended";
  return null;
}

export function buildJudgePrompt(metric: EvalMetric, evalCase: EvalCase, stdout: string): string {
  const rubric = metric.rubric;
  return [
    `You are scoring one output of a program against a rubric for the metric '${metric.metric}'.`,
    "Answer with a single JSON object and nothing else: {\"score\": <number from 0 to 1>, \"reason\": \"<one sentence>\"}.",
    "",
    "Rubric steps:",
    ...(rubric?.steps ?? ["Judge whether the output satisfies the case."]).map((s, i) => `${i + 1}. ${s}`),
    ...(rubric?.buckets.length ? ["", "Score buckets:", ...rubric.buckets.map((b) => `- ${b.range[0]} to ${b.range[1]}: ${b.expectedOutcome}`)] : []),
    "",
    "Case:",
    evalCase.input ?? "(no input given)",
    "",
    "Output:",
    stdout.slice(0, 16_000),
  ].join("\n");
}

/** Score with an OpenAI-compatible chat completions endpoint. Any malformed answer, timeout, or non-2xx is unevaluable with the cause. */
export async function judgeScore(config: JudgeConfig, prompt: string, signal?: AbortSignal): Promise<ScoreOutcome> {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const url = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (config.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
      signal: combined,
    });
  } catch (err) {
    return { ok: false, reason: `the judge did not answer: ${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}`, promptHash };
  }
  if (!res.ok) return { ok: false, reason: `the judge answered HTTP ${res.status}`, promptHash };
  let content: unknown;
  try {
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    content = body.choices?.[0]?.message?.content;
  } catch {
    return { ok: false, reason: "the judge's response is not JSON", promptHash };
  }
  if (typeof content !== "string") return { ok: false, reason: "the judge's response has no message content", promptHash };
  let parsed: { score?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(content) as { score?: unknown; reason?: unknown };
  } catch {
    return { ok: false, reason: `the judge's message is not a JSON object (got '${content.slice(0, 60)}')`, promptHash };
  }
  if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 1) return { ok: false, reason: "the judge's score is not a number from 0 to 1", promptHash };
  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) return { ok: false, reason: "the judge gave no reason", promptHash };
  return { ok: true, score: parsed.score, reason: parsed.reason.trim(), promptHash };
}

/** All five scorers behind one function; `judge` metrics need a judge configuration. */
export function createMetricScorer(judge?: JudgeConfig): MetricScorer {
  return async (input) => {
    if (input.metric.scorer !== "judge") return scoreDeterministic(input);
    if (!judge) return { ok: false, reason: "no judge is configured", promptHash: null };
    return judgeScore(judge, buildJudgePrompt(input.metric, input.evalCase, input.stdout), input.signal);
  };
}

/** Per-metric pass over repetitions: the mean meets the threshold; any unscorable repetition makes the metric unevaluable. */
export function aggregateMetric(scores: (number | null)[], threshold: number): { mean: number | null; status: "pass" | "fail" | "unevaluable" } {
  if (scores.length === 0 || scores.some((s) => s === null)) return { mean: null, status: "unevaluable" };
  const mean = (scores as number[]).reduce((a, b) => a + b, 0) / scores.length;
  return { mean, status: mean >= threshold ? "pass" : "fail" };
}
