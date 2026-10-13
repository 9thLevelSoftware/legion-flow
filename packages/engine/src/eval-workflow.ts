import type { EvalCase, EvalMetric, EvalResult, GoldenDataset, MetricResult } from "@9thlevelsoftware/legion-flow-schema";
import { fingerprintTree, type TreeMode, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import type { CheckRunner, Materializer } from "./ports.js";
import { TaskExecutionError } from "./task-workflow.js";
import type { Workflow } from "./types.js";

export const EVAL_WORKFLOW_ID = "eval";

export type EvalScoreOutcome = { ok: true; score: number; reason: string; promptHash: string | null } | { ok: false; reason: string; promptHash: string | null };
/** Scores one metric of one repetition. `evals` provides it (deterministic scorers plus the judge); the engine never imports it. */
export type EvalScorer = (input: { metric: EvalMetric; evalCase: EvalCase; stdout: string; exitCode: number | null; signal?: AbortSignal }) => Promise<EvalScoreOutcome>;

export interface EvalPorts {
  ws: Workspace;
  materializer: Materializer;
  runCheck: CheckRunner;
  scorer: EvalScorer;
  checkTimeoutMs?: number;
  now?: () => Date;
}

export interface EvalInput {
  workspaceRoot: string;
  sourceMode: TreeMode;
  sourceFingerprint: string;
  fingerprints: EvalResult["fingerprints"];
  dataset: GoldenDataset;
  datasetFingerprint: string;
  judge?: string;
  distinctFromExecutor: boolean;
  waiver?: { reason: string; waivedBy: string };
}

function aggregate(scores: (number | null)[], threshold: number): { mean: number | null; status: MetricResult["status"] } {
  if (scores.length === 0 || scores.some((s) => s === null)) return { mean: null, status: "unevaluable" };
  const mean = (scores as number[]).reduce((a, b) => a + b, 0) / scores.length;
  return { mean, status: mean >= threshold ? "pass" : "fail" };
}

/**
 * The eval workflow: materialize a copy of the checkout, run every case's
 * frozen argv shell-free in it once per repetition, score each metric, and
 * record the result on the run. Per-metric pass on every case; zero cases is
 * FAIL; an unscorable metric makes the run unevaluable, never a pass.
 */
export function evalWorkflow(ports: EvalPorts): Workflow {
  const now = ports.now ?? (() => new Date());
  return {
    id: EVAL_WORKFLOW_ID,
    version: "1",
    entry: "materialize",
    state: { log: { kind: "append" } },
    nodes: {
      materialize: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const input = state as unknown as EvalInput;
          const { treeDir } = await ports.materializer.materialize({ runId: ctx.runId, sourceRoot: input.workspaceRoot, sourceMode: input.sourceMode });
          const copy = await fingerprintTree(treeDir, { mode: "fs" });
          if (copy.fingerprint !== input.sourceFingerprint) {
            await ports.materializer.dispose(treeDir);
            throw new TaskExecutionError("materialize_mismatch", `the eval copy (${copy.fingerprint}) does not match the checkout (${input.sourceFingerprint})`);
          }
          return { writes: { treeDir, log: "materialized" }, next: ["score"] };
        },
      },
      score: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const input = state as unknown as EvalInput;
          const treeDir = state.treeDir as string;
          const cases: EvalResult["cases"] = [];
          for (const c of input.dataset.cases) {
            const perMetric = new Map<string, { scores: (number | null)[]; reasons: string[]; hashes: (string | null)[] }>();
            for (const m of c.metrics) perMetric.set(m.metric, { scores: [], reasons: [], hashes: [] });
            for (let rep = 0; rep < c.repeat; rep++) {
              const outcome = await ports.runCheck(c.argv, { cwd: treeDir, source: "eval", taskId: undefined, timeoutMs: ports.checkTimeoutMs });
              await ports.ws.runs.writeEvidence(ctx.runId, outcome.evidence, ctx.held, "score");
              for (const m of c.metrics) {
                const slot = perMetric.get(m.metric)!;
                if (outcome.status === "unevaluable") {
                  slot.scores.push(null);
                  slot.reasons.push(`the case could not run: ${outcome.reason}`);
                  slot.hashes.push(null);
                  continue;
                }
                const s = await ports.scorer({ metric: m, evalCase: c, stdout: outcome.evidence.stdout, exitCode: outcome.evidence.exitCode, signal: ctx.signal });
                slot.scores.push(s.ok ? s.score : null);
                slot.reasons.push(s.reason);
                slot.hashes.push(s.promptHash);
              }
            }
            cases.push({
              id: c.id,
              metrics: c.metrics.map((m) => {
                const slot = perMetric.get(m.metric)!;
                const agg = aggregate(slot.scores, m.threshold);
                return { metric: m.metric, scorer: m.scorer, threshold: m.threshold, scores: slot.scores, reasons: slot.reasons, promptHashes: slot.hashes, mean: agg.mean, status: agg.status };
              }),
            });
          }
          const all = cases.flatMap((c) => c.metrics);
          const unevaluable = all.some((m) => m.status === "unevaluable");
          const failedMetrics = all.filter((m) => m.status === "fail");
          const passed = cases.length > 0 && !unevaluable && failedMetrics.length === 0;
          const reason =
            cases.length === 0
              ? "the dataset has zero cases, which is a FAIL by rule"
              : unevaluable
                ? `${all.filter((m) => m.status === "unevaluable").length} metric result(s) could not be scored`
                : failedMetrics.length > 0
                  ? `${failedMetrics.length} metric result(s) below threshold`
                  : `all ${all.length} metric result(s) on ${cases.length} case(s) met their thresholds`;
          const result: EvalResult = {
            datasetId: input.dataset.id,
            version: input.dataset.version,
            datasetFingerprint: input.datasetFingerprint,
            fingerprints: input.fingerprints,
            sourceFingerprint: input.sourceFingerprint,
            acceptanceIds: [...new Set(input.dataset.cases.flatMap((c) => c.acceptanceIds))].sort(),
            ...(input.judge ? { judge: input.judge } : {}),
            distinctFromExecutor: input.distinctFromExecutor,
            ...(input.waiver ? { waiver: input.waiver } : {}),
            passed,
            unevaluable,
            reason,
            cases,
          };
          await ports.ws.runs.recordEval(ctx.runId, result, ctx.held);
          await ports.ws.audit.append({ type: "eval_recorded", runId: ctx.runId, datasetId: result.datasetId, version: result.version, passed, unevaluable, at: now().toISOString() }, ctx.held);
          await ports.materializer.dispose(treeDir);
          return { writes: { passed, log: reason } };
        },
      },
    },
  };
}
