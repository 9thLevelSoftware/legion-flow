import type { ProposalArchitecture, ProposalImpact } from "@9thlevelsoftware/legion-flow-schema";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptanceCriterion, AgentIdentity, PlanTask, ReviewResult } from "@9thlevelsoftware/legion-flow-schema";
import { fingerprintTree, sha256Hex, type TreeMode, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import type { Adapter, AdapterOutcome, Materializer } from "./ports.js";
import { TaskExecutionError } from "./task-workflow.js";
import type { State, Workflow } from "./types.js";

export const REVIEW_WORKFLOW_ID = "review";
export const REVIEW_OUTPUT_FILE = "review.md";
const PROMPT_CAP = 24_000;

export interface ReviewPorts {
  ws: Workspace;
  materializer: Materializer;
  adapter: Adapter;
  adapterTimeoutMs?: number;
  envMode?: "host" | "container";
  tierEvidence?: Record<string, unknown>;
  now?: () => Date;
}

export interface AppliedProposalSummary {
  taskId: string;
  runId: string;
  proposalSha256: string;
  files: string[];
  /** From the proposal (M4 slice a2): rule violations introduced or resolved, and the blast radius. */
  architecture?: ProposalArchitecture;
  impact?: ProposalImpact;
}

/** The input state `review` hands the workflow. */
export interface ReviewInput {
  workspaceRoot: string;
  sourceMode: TreeMode;
  /** The checkout's fingerprint when review began; the copy must match it. */
  sourceFingerprint: string;
  fingerprints: ReviewResult["fingerprints"];
  acceptanceCriteria: AcceptanceCriterion[];
  tasks: PlanTask[];
  applied: AppliedProposalSummary[];
  reviewer: AgentIdentity;
  executor: AgentIdentity;
  independent: boolean;
  model?: string;
  waiver?: { reason: string; waivedBy: string };
}

export interface ReviewBrief {
  kind: "review";
  outputFile: string;
  acceptanceCriteria: AcceptanceCriterion[];
  tasks: { id: string; title: string; acceptanceIds: string[]; filesAllowed: string[]; verificationCommands: string[] }[];
  applied: AppliedProposalSummary[];
}

export function renderReviewPrompt(brief: ReviewBrief): string {
  const lines = [
    "# Legion Flow review",
    "",
    `You are an independent reviewer. The tree you are in is a disposable copy: nothing you change in it counts and it is deleted afterwards. The only output that counts is \`${brief.outputFile}\` next to this file.`,
    "",
    `Write \`${brief.outputFile}\` as free-form review notes, then end it with exactly one final line, either \`Verdict: PASS\` or \`Verdict: FAIL\`. PASS means every acceptance criterion below is met by the applied changes; anything less is FAIL.`,
    "",
    "## Acceptance criteria",
    ...brief.acceptanceCriteria.map((c) => `- ${c.id} (${c.kind}, ${c.surface}, ${c.priority}): ${c.statement}`),
    "",
    "## Plan tasks",
    ...brief.tasks.flatMap((t) => [`- ${t.id}: ${t.title} (criteria ${t.acceptanceIds.join(", ") || "none"})`, `  files allowed: ${t.filesAllowed.join(", ")}`, ...(t.verificationCommands.length ? [`  checks: ${t.verificationCommands.join("; ")}`] : [])]),
    "",
    "## Applied proposals, in plan order",
    ...brief.applied.map((a) => `- ${a.taskId} (run ${a.runId}, proposal ${a.proposalSha256.slice(0, 12)}): ${a.files.join(", ") || "no files"}`),
    "",
  ];
  const text = lines.join("\n");
  if (text.length <= PROMPT_CAP) return text;
  const marker = "\n\n[truncated: the brief exceeded the prompt cap; brief.json holds the full content]\n";
  return text.slice(0, PROMPT_CAP - marker.length) + marker;
}

/**
 * The strict PASS: the reviewer exited 0, wrote non-empty notes, and the last
 * non-blank line is exactly `Verdict: PASS`. Everything else, a crash
 * included, is FAIL with the reason stated.
 */
export function parseReviewVerdict(text: string | null, outcome: Pick<AdapterOutcome, "exitCode" | "timedOut" | "spawnError" | "signal">): { verdict: "PASS" | "FAIL"; reason: string } {
  if (outcome.spawnError) return { verdict: "FAIL", reason: `the reviewer could not be started: ${outcome.spawnError}` };
  if (outcome.timedOut) return { verdict: "FAIL", reason: "the reviewer exceeded its time limit" };
  if (outcome.exitCode !== 0) return { verdict: "FAIL", reason: `the reviewer exited ${outcome.exitCode ?? outcome.signal}` };
  if (text === null) return { verdict: "FAIL", reason: `no ${REVIEW_OUTPUT_FILE} was written` };
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  const notes = lines.slice(0, -1);
  if (last !== "Verdict: PASS" && last !== "Verdict: FAIL") return { verdict: "FAIL", reason: `the last non-blank line is not a verdict line (got '${(last ?? "").slice(0, 60)}')` };
  if (notes.length === 0) return { verdict: "FAIL", reason: "the review has a verdict but no notes" };
  if (last === "Verdict: FAIL") return { verdict: "FAIL", reason: "the reviewer found the acceptance criteria unmet" };
  return { verdict: "PASS", reason: `the reviewer passed the change with ${notes.length} line(s) of notes` };
}

/**
 * The review workflow: materialize a read-only copy of the checkout, run the
 * reviewer against it (a failure of the reviewer is a FAIL verdict, never a
 * failed run), then read the verdict strictly, store the notes as evidence,
 * record the result on the run, and dispose the copy on every path.
 */
export function reviewWorkflow(ports: ReviewPorts): Workflow {
  const now = ports.now ?? (() => new Date());
  const paths = ports.ws.paths;
  return {
    id: REVIEW_WORKFLOW_ID,
    version: "1",
    entry: "materialize",
    state: { log: { kind: "append" } },
    nodes: {
      materialize: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const input = state as unknown as ReviewInput;
          const { treeDir } = await ports.materializer.materialize({ runId: ctx.runId, sourceRoot: input.workspaceRoot, sourceMode: input.sourceMode });
          const copy = await fingerprintTree(treeDir, { mode: "fs" });
          if (copy.fingerprint !== input.sourceFingerprint) {
            await ports.materializer.dispose(treeDir);
            throw new TaskExecutionError("materialize_mismatch", `the review copy (${copy.fingerprint}) does not match the checkout (${input.sourceFingerprint})`);
          }
          if (ports.tierEvidence) await ports.ws.runs.writeEvidence(ctx.runId, { kind: "sandbox_tier", tier: ports.materializer.tier, ...ports.tierEvidence }, ctx.held, "materialize");
          await ports.ws.audit.append({ type: "review_started", runId: ctx.runId, reviewer: input.reviewer, independent: input.independent, sourceFingerprint: input.sourceFingerprint }, ctx.held);
          return { writes: { treeDir, log: "materialized" }, next: ["spawn"] };
        },
      },
      spawn: {
        retry: { maxAttempts: 1 },
        effect: "reviewer_spawn",
        run: async (state, ctx) => {
          const input = state as unknown as ReviewInput;
          const treeDir = state.treeDir as string;
          const runDir = join(paths.cacheRunsDir, ctx.runId);
          await mkdir(runDir, { recursive: true });
          const brief: ReviewBrief = {
            kind: "review",
            outputFile: REVIEW_OUTPUT_FILE,
            acceptanceCriteria: input.acceptanceCriteria,
            tasks: input.tasks.map((t) => ({ id: t.id, title: t.title, acceptanceIds: t.acceptanceIds, filesAllowed: t.contract.filesAllowed, verificationCommands: t.contract.verificationCommands })),
            applied: input.applied,
          };
          const promptPath = join(runDir, "prompt.md");
          await writeFile(promptPath, renderReviewPrompt(brief), "utf8");
          await writeFile(join(runDir, "brief.json"), JSON.stringify(brief, null, 2) + "\n", "utf8");
          const outcome = await ports.adapter.run({
            runId: ctx.runId,
            workspaceRoot: input.workspaceRoot,
            treeDir,
            promptPath,
            signal: ctx.signal,
            timeoutMs: ports.adapterTimeoutMs ?? 30 * 60 * 1000,
            exec: ports.materializer.exec,
            envMode: ports.envMode ?? "host",
            outputFile: REVIEW_OUTPUT_FILE,
            ...(input.model ? { model: input.model } : {}),
          });
          const tail = (s: string) => (s.length > 2000 ? s.slice(-2000) : s);
          await ports.ws.runs.writeEvidence(ctx.runId, { kind: "adapter_outcome", adapter: ports.adapter.id, role: "reviewer", ...outcome, stdoutTail: tail(outcome.stdoutTail), stderrTail: tail(outcome.stderrTail) }, ctx.held, "spawn");
          // A reviewer that fails is a FAIL verdict, not a failed run: the outcome travels to the verdict node.
          return {
            writes: { reviewerOutcome: { exitCode: outcome.exitCode, timedOut: outcome.timedOut, signal: outcome.signal, ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}) }, log: "reviewer finished" },
            next: ["verdict"],
          };
        },
      },
      verdict: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const input = state as unknown as ReviewInput;
          const treeDir = state.treeDir as string;
          const outcome = state.reviewerOutcome as Pick<AdapterOutcome, "exitCode" | "timedOut" | "signal" | "spawnError">;
          let text: string | null = null;
          let notesSha256: string | null = null;
          try {
            const bytes = await readFile(join(paths.cacheRunsDir, ctx.runId, REVIEW_OUTPUT_FILE));
            text = bytes.toString("utf8");
            notesSha256 = sha256Hex(bytes);
            await ports.ws.runs.writeEvidence(ctx.runId, { kind: "review_notes", sha256: notesSha256, text }, ctx.held, "verdict");
          } catch {
            // no review.md: the parse below says so
          }
          const parsed = parseReviewVerdict(text, outcome);
          const result: ReviewResult = {
            fingerprints: input.fingerprints,
            sourceFingerprint: input.sourceFingerprint,
            treeMode: input.sourceMode,
            reviewer: input.reviewer,
            executor: input.executor,
            independent: input.independent,
            verdict: parsed.verdict,
            reason: parsed.reason,
            notesSha256,
            ...(input.waiver ? { waiver: input.waiver } : {}),
          };
          await ports.ws.runs.recordReview(ctx.runId, result, ctx.held);
          await ports.ws.audit.append({ type: "review_recorded", runId: ctx.runId, verdict: parsed.verdict, reason: parsed.reason, reviewer: input.reviewer, independent: input.independent, notesSha256, at: now().toISOString() }, ctx.held);
          await ports.materializer.dispose(treeDir);
          return { writes: { verdict: parsed.verdict, log: `verdict ${parsed.verdict}` } satisfies State };
        },
      },
    },
  };
}
