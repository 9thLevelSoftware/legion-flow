/**
 * The spec challenge agent (M4 slice j3). It reads the spec in a disposable copy
 * of the checkout and writes at most three concerns as JSON. Legion checks each
 * one: a quoted line must occur verbatim at its path in the copy or the concern
 * is kept as unverified; anything past three is dropped and counted; output that
 * does not parse is one note, never a failed run. The copy is disposed on every
 * path. It applies nothing and decides nothing: a human resolves every concern.
 */
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHALLENGE_AGENT_MAX, ChallengeEvidenceSchema, SPEC_CHALLENGE_OUTPUT_FILE, SPEC_CHALLENGE_WORKFLOW_ID, type AcceptanceCriterion, type ChallengeConcern } from "@9thlevelsoftware/legion-flow-schema";
import { fingerprintTree, type TreeMode, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import type { Adapter, Materializer } from "./ports.js";
import { TaskExecutionError, redact } from "./task-workflow.js";
import type { Workflow } from "./types.js";

const QUOTED_FILE_MAX = 1024 * 1024;
const NO_RETRY = { maxAttempts: 1 };

export interface ChallengePorts {
  ws: Workspace;
  materializer: Materializer;
  adapter: Adapter;
  adapterTimeoutMs?: number;
  envMode?: "host" | "container";
  tierEvidence?: Record<string, unknown>;
  /** Secret values blanked from the agent's output and tails before they become evidence; held in memory only. */
  redactValues?: string[];
}

export interface ChallengeInput {
  workspaceRoot: string;
  sourceMode: TreeMode;
  sourceFingerprint: string;
  specId: string;
  specTitle: string;
  /** Workspace-relative paths of spec.json and SPEC.md, so the agent can quote them. */
  specPaths: { json: string; markdown: string };
  acceptanceCriteria: AcceptanceCriterion[];
  model?: string;
}

export interface ChallengeResult {
  ran: boolean;
  note?: "agent_failed" | "agent_output_invalid";
  dropped: number;
  concerns: Omit<ChallengeConcern, "id" | "source">[];
}

export function renderChallengePrompt(input: ChallengeInput, outputFile: string): string {
  return [
    "# Legion Flow spec challenge",
    "",
    `You are reviewing a specification before a human approves it. The tree you are in is a disposable copy; nothing you change in it counts. The only output that counts is \`${outputFile}\` next to this file.`,
    "",
    `Write \`${outputFile}\` as JSON: { "concerns": [ { "question": "...", "why": "...", "evidence": [ { "path": "<workspace-relative file>", "quote": "<a line copied exactly>" } or { "assumption": "..." } ] } ] }. At most ${CHALLENGE_AGENT_MAX} concerns, the ones a careful reviewer would most want answered; zero is a valid answer. A quote that does not appear verbatim at its path is marked unverified.`,
    "",
    `## Spec ${input.specId}: ${input.specTitle}`,
    `Typed half: ${input.specPaths.json}. Prose half: ${input.specPaths.markdown}.`,
    "",
    "### Acceptance criteria",
    ...input.acceptanceCriteria.map((c) => `- ${c.id} (${c.kind}, ${c.surface}, ${c.priority}): ${c.statement}`),
    "",
  ].join("\n");
}

/** Validate the agent's output against the copy; never throws. */
export async function parseChallengeOutput(text: string | null, treeDir: string): Promise<Omit<ChallengeResult, "ran">> {
  if (text === null) return { note: "agent_output_invalid", dropped: 0, concerns: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { note: "agent_output_invalid", dropped: 0, concerns: [] };
  }
  const list = (raw as { concerns?: unknown })?.concerns;
  if (!Array.isArray(list)) return { note: "agent_output_invalid", dropped: 0, concerns: [] };
  const concerns: ChallengeResult["concerns"] = [];
  let dropped = 0;
  for (const item of list) {
    const c = item as { question?: unknown; why?: unknown; evidence?: unknown };
    if (typeof c.question !== "string" || typeof c.why !== "string" || !c.question.trim() || !c.why.trim()) {
      dropped++;
      continue;
    }
    if (concerns.length >= CHALLENGE_AGENT_MAX) {
      dropped++;
      continue;
    }
    const evidence: ChallengeConcern["evidence"] = [];
    let unverified = false;
    for (const e of (Array.isArray(c.evidence) ? c.evidence : []).slice(0, 3)) {
      const asQuote = e as { path?: unknown; quote?: unknown };
      if (typeof asQuote.path === "string" && typeof asQuote.quote === "string") {
        const shaped = ChallengeEvidenceSchema.safeParse({ path: asQuote.path, quote: asQuote.quote.slice(0, 500), verified: false });
        if (!shaped.success || !("path" in shaped.data)) {
          unverified = true;
          continue;
        }
        let found = false;
        try {
          const abs = join(treeDir, ...shaped.data.path.split("/"));
          const st = await lstat(abs);
          if (st.isFile() && st.size <= QUOTED_FILE_MAX) found = (await readFile(abs, "utf8")).includes(shaped.data.quote);
        } catch {
          found = false;
        }
        if (!found) unverified = true;
        evidence.push({ ...shaped.data, verified: found });
        continue;
      }
      const asAssumption = ChallengeEvidenceSchema.safeParse({ assumption: String((e as { assumption?: unknown }).assumption ?? "").slice(0, 1000) });
      if (asAssumption.success && "assumption" in asAssumption.data && asAssumption.data.assumption) evidence.push(asAssumption.data);
    }
    concerns.push({ question: c.question.trim().slice(0, 1000), why: c.why.trim().slice(0, 1000), evidence, ...(unverified ? { unverified: true } : {}) });
  }
  return { dropped, concerns };
}

export function challengeWorkflow(ports: ChallengePorts): Workflow {
  const paths = ports.ws.paths;
  return {
    id: SPEC_CHALLENGE_WORKFLOW_ID,
    version: "1",
    entry: "materialize",
    state: { log: { kind: "append" } },
    nodes: {
      materialize: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as ChallengeInput;
          const { treeDir } = await ports.materializer.materialize({ runId: ctx.runId, sourceRoot: input.workspaceRoot, sourceMode: input.sourceMode });
          const copy = await fingerprintTree(treeDir, { mode: "fs" });
          if (copy.fingerprint !== input.sourceFingerprint) {
            await ports.materializer.dispose(treeDir);
            throw new TaskExecutionError("materialize_mismatch", `the challenge copy (${copy.fingerprint}) does not match the checkout (${input.sourceFingerprint})`);
          }
          // The copy leaves .legion-flow/ out, so the spec under challenge is placed into it, at its usual paths, after the fingerprint check.
          for (const rel of [input.specPaths.json, input.specPaths.markdown]) {
            const target = join(treeDir, ...rel.split("/"));
            await mkdir(dirname(target), { recursive: true });
            await copyFile(join(input.workspaceRoot, ...rel.split("/")), target);
          }
          if (ports.tierEvidence) await ports.ws.runs.writeEvidence(ctx.runId, { kind: "sandbox_tier", tier: ports.materializer.tier, ...ports.tierEvidence }, ctx.held, "materialize");
          return { writes: { treeDir, log: "materialized" }, next: ["spawn"] };
        },
      },
      spawn: {
        retry: NO_RETRY,
        effect: "challenger_spawn",
        run: async (state, ctx) => {
          const input = state as unknown as ChallengeInput;
          const runDir = join(paths.cacheRunsDir, ctx.runId);
          await mkdir(runDir, { recursive: true });
          const promptPath = join(runDir, "prompt.md");
          await writeFile(promptPath, renderChallengePrompt(input, SPEC_CHALLENGE_OUTPUT_FILE), "utf8");
          await writeFile(join(runDir, "brief.json"), JSON.stringify({ kind: "challenge", outputFile: SPEC_CHALLENGE_OUTPUT_FILE, specId: input.specId, specPaths: input.specPaths, acceptanceCriteria: input.acceptanceCriteria }, null, 2) + "\n", "utf8");
          const outcome = await ports.adapter.run({ runId: ctx.runId, workspaceRoot: input.workspaceRoot, treeDir: state.treeDir as string, promptPath, signal: ctx.signal, timeoutMs: ports.adapterTimeoutMs ?? 30 * 60 * 1000, exec: ports.materializer.exec, envMode: ports.envMode ?? "host", outputFile: SPEC_CHALLENGE_OUTPUT_FILE, ...(input.model ? { model: input.model } : {}) });
          const tail = (s: string) => redact(s.length > 2000 ? s.slice(-2000) : s, ports.redactValues ?? []).text;
          await ports.ws.runs.writeEvidence(ctx.runId, { kind: "adapter_outcome", adapter: ports.adapter.id, role: "challenger", ...outcome, stdoutTail: tail(outcome.stdoutTail), stderrTail: tail(outcome.stderrTail) }, ctx.held, "spawn");
          // A challenger that fails is a note on the round, never a failed run: the lint stands without it.
          return { writes: { challengerOk: !outcome.spawnError && !outcome.timedOut && outcome.exitCode === 0, log: "challenger finished" }, next: ["collect"] };
        },
      },
      collect: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const treeDir = state.treeDir as string;
          let result: ChallengeResult;
          try {
            if (!state.challengerOk) {
              result = { ran: false, note: "agent_failed", dropped: 0, concerns: [] };
            } else {
              const text = await readFile(join(paths.cacheRunsDir, ctx.runId, SPEC_CHALLENGE_OUTPUT_FILE), "utf8").catch(() => null);
              if (text !== null) await ports.ws.runs.writeEvidence(ctx.runId, { kind: "challenge_output", text: redact(text.slice(0, 64 * 1024), ports.redactValues ?? []).text }, ctx.held, "collect");
              result = { ran: true, ...(await parseChallengeOutput(text, treeDir)) };
            }
          } finally {
            await ports.materializer.dispose(treeDir);
          }
          return { writes: { challenge: result, log: result.note ?? `${result.concerns.length} concern(s)` } };
        },
      },
    },
  };
}
