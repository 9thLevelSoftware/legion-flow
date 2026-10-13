import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EvalCaseSchema, type EvalMetric } from "@9thlevelsoftware/legion-flow-schema";
import { scoreDeterministic, judgeScore, judgeUrlProblem, createMetricScorer, aggregateMetric, buildJudgePrompt } from "../dist/index.js";

const caseWith = (expected: Record<string, unknown>) => EvalCaseSchema.parse({ id: "c", argv: "node -e 0", expected, metrics: [{ metric: "m", scorer: "exact", threshold: 1 }] });
const metric = (scorer: EvalMetric["scorer"], threshold = 1): EvalMetric => ({ metric: "m", scorer, threshold });

describe("deterministic scorers and aggregation", () => {
  test("exact trims and normalizes line endings; contains, regex, exit_code score 1 or 0 with a reason; a missing expectation is unevaluable", () => {
    assert.equal(scoreDeterministic({ metric: metric("exact"), evalCase: caseWith({ stdout: "hello\nworld" }), stdout: "hello\r\nworld\r\n", exitCode: 0 }).ok && 1, 1);
    const exact = scoreDeterministic({ metric: metric("exact"), evalCase: caseWith({ stdout: "a" }), stdout: "b", exitCode: 0 });
    assert.equal(exact.ok && exact.score, 0);
    const contains = scoreDeterministic({ metric: metric("contains"), evalCase: caseWith({ contains: ["x", "y"] }), stdout: "x alone", exitCode: 0 });
    assert.equal(contains.ok && contains.score, 0);
    assert.match(contains.reason, /lacks: 'y'/);
    const regex = scoreDeterministic({ metric: metric("regex"), evalCase: caseWith({ pattern: "^v\\d+" }), stdout: "v12\n", exitCode: 0 });
    assert.equal(regex.ok && regex.score, 1);
    const exit = scoreDeterministic({ metric: metric("exit_code"), evalCase: caseWith({ exitCode: 3 }), stdout: "", exitCode: 3 });
    assert.equal(exit.ok && exit.score, 1);
    assert.equal(scoreDeterministic({ metric: metric("exact"), evalCase: caseWith({}), stdout: "x", exitCode: 0 }).ok, false);
    assert.equal(scoreDeterministic({ metric: metric("regex"), evalCase: caseWith({ pattern: "(" }), stdout: "x", exitCode: 0 }).ok, false);
  });

  test("per-metric pass is the mean over repetitions against the threshold; any unscorable repetition is unevaluable", () => {
    assert.deepEqual(aggregateMetric([1, 0], 0.5), { mean: 0.5, status: "pass" });
    assert.deepEqual(aggregateMetric([1, 0], 0.6), { mean: 0.5, status: "fail" });
    assert.deepEqual(aggregateMetric([1, null], 0.1), { mean: null, status: "unevaluable" });
    assert.deepEqual(aggregateMetric([], 0), { mean: null, status: "unevaluable" });
  });
});

describe("the judge client against a fake OpenAI-compatible server on loopback", () => {
  let server: Server;
  let base: string;
  let mode = "good";
  let lastAuth: string | undefined;
  let lastBody: Record<string, unknown> = {};

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastAuth = req.headers.authorization;
        lastBody = JSON.parse(body);
        if (mode === "500") {
          res.writeHead(500);
          res.end("boom");
          return;
        }
        if (mode === "slow") return; // never answers
        const content = mode === "good" ? JSON.stringify({ score: 0.8, reason: "mostly right" }) : mode === "range" ? JSON.stringify({ score: 7, reason: "x" }) : "I think it is fine";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  after(() => server.close());

  test("loopback only, API root only", () => {
    assert.equal(judgeUrlProblem("http://127.0.0.1:11434/v1"), null);
    assert.equal(judgeUrlProblem("http://[::1]:8080/v1"), null);
    assert.equal(judgeUrlProblem("http://localhost:1234/v1"), null);
    assert.match(judgeUrlProblem("https://api.openai.com/v1") ?? "", /not loopback/);
    assert.match(judgeUrlProblem("http://127.0.0.1:1/v1/chat/completions") ?? "", /API root/);
  });

  test("a valid answer scores with its reason and prompt hash; garbage, out of range, a 500, and a timeout are unevaluable", async () => {
    const prompt = buildJudgePrompt({ metric: "helpful", scorer: "judge", threshold: 0.5, rubric: { steps: ["Is it helpful?"], buckets: [] } }, caseWith({}), "the output");
    mode = "good";
    const good = await judgeScore({ baseUrl: base, model: "judge-model", apiKey: "k" }, prompt);
    assert.deepEqual(good.ok && [good.score, good.reason], [0.8, "mostly right"]);
    assert.match(good.promptHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(lastAuth, "Bearer k");
    assert.equal(lastBody.model, "judge-model");
    assert.deepEqual(lastBody.response_format, { type: "json_object" });
    mode = "garbage";
    assert.match((await judgeScore({ baseUrl: base, model: "m" }, prompt)).reason, /not a JSON object/);
    mode = "range";
    assert.match((await judgeScore({ baseUrl: base, model: "m" }, prompt)).reason, /0 to 1/);
    mode = "500";
    assert.match((await judgeScore({ baseUrl: base, model: "m" }, prompt)).reason, /HTTP 500/);
    mode = "slow";
    const slow = await judgeScore({ baseUrl: base, model: "m", timeoutMs: 200 }, prompt);
    assert.equal(slow.ok, false);
    assert.match(slow.reason, /timed out/);
    const noJudge = await createMetricScorer()({ metric: metric("judge", 0.5), evalCase: caseWith({}), stdout: "x", exitCode: 0 });
    assert.match(noJudge.reason, /no judge is configured/);
  });
});
