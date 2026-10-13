/**
 * The drafter (after M4 slice aa): `spec --draft` and `plan --draft`. It reads a disposable copy of the checkout, with
 * the current spec (and plan) placed into it, and writes one JSON answer. Legion parses and validates the answer; the
 * caller writes the files. The copy is disposed on every path. It approves nothing: a human approves every draft.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DRAFT_OUTPUT_FILE, DRAFT_STRIPPED_TASK_FIELDS, PLAN_DRAFT_WORKFLOW_ID, PlanDraftSchema, SPEC_DRAFT_WORKFLOW_ID, SpecDraftSchema, type AcceptanceCriterion, type PlanDraft, type SpecDraft } from "@9thlevelsoftware/legion-flow-schema";
import { fingerprintTree, type TreeMode, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import type { Adapter, Materializer } from "./ports.js";
import { TaskExecutionError, redact } from "./task-workflow.js";
import type { Workflow } from "./types.js";

const NO_RETRY = { maxAttempts: 1 };

export interface DraftPorts {
  ws: Workspace;
  materializer: Materializer;
  adapter: Adapter;
  adapterTimeoutMs?: number;
  envMode?: "host" | "container";
  tierEvidence?: Record<string, unknown>;
  redactValues?: string[];
}

export interface DraftInput {
  mode: "spec" | "plan";
  workspaceRoot: string;
  sourceMode: TreeMode;
  sourceFingerprint: string;
  /** The human's request (spec) or guidance (plan), verbatim. */
  request: string;
  /** Workspace-relative files placed into the copy after the fingerprint check (the current spec and plan). */
  place: string[];
  /** For a plan: the frozen spec the tasks must cover. */
  spec?: { id: string; title: string; acceptanceCriteria: AcceptanceCriterion[] };
  model?: string;
}

export type DraftParse =
  | { ok: true; mode: "spec"; draft: SpecDraft; stripped: string[] }
  | { ok: true; mode: "plan"; draft: PlanDraft; stripped: string[] }
  | { ok: false; reason: string };

export interface DraftResult {
  ran: boolean;
  parse: DraftParse;
}

const SPEC_SHAPE = '{ "title": "...", "intent": "<one or two paragraphs: what this change is for>", "acceptanceCriteria": [ { "id": "AC-01", "statement": "<one observable, checkable outcome>", "kind": "behavior" | "test" | "rubric", "surface": "unit" | "integration" | "real_interface" | "end_to_end", "priority": "P0" | "P1" | "P2" } ], "outOfScope": "<what this deliberately does not cover>" }';
const PLAN_SHAPE = '{ "tasks": [ { "id": "T-01", "title": "<what to do, specific enough to act on>", "acceptanceIds": ["AC-01"], "dependsOn": [], "contract": { "filesAllowed": ["<exact paths or dir/ prefixes the task may change>"], "verificationCommands": ["<a program and its arguments that exits 0 when the task is done>"] } } ], "checks": ["<a command a reviewer could freeze to verify the whole plan>"] }';

export function renderDraftPrompt(input: DraftInput, outputFile: string): string {
  const common = [
    `The tree you are in is a disposable copy of the project; nothing you change in it counts. The only output that counts is the file \`${outputFile}\` next to this prompt. Write it with your file-writing tool; do not just reply with it. It must be one JSON document and nothing else.`,
    "A human reviews and approves what you write; be concrete, and do not invent files the project does not have.",
    "",
  ];
  if (input.mode === "spec") {
    return [
      "# Legion Flow: draft a specification",
      "",
      ...common,
      `Write \`${outputFile}\` as: ${SPEC_SHAPE}`,
      "Each criterion is one outcome a reviewer can check; prefer a few precise criteria over many vague ones. Read the code before you write.",
      ...(input.place.length ? ["", `The current draft is at ${input.place.join(" and ")}; revise it to fit the request.`] : []),
      "",
      "## The request (from the person who will approve it)",
      "",
      input.request,
      "",
    ].join("\n");
  }
  return [
    "# Legion Flow: draft a plan",
    "",
    ...common,
    `Write \`${outputFile}\` as: ${PLAN_SHAPE}`,
    "Every acceptance criterion should be covered by at least one task. `filesAllowed` is the task's whole contract: changes outside it are discarded, so list every file the task must change, and nothing more. Each verification command runs without a shell: one program and its arguments, no &&, |, ;, redirection, globs, or $VARS.",
    ...(input.place.length ? ["", `The frozen spec, and any current draft plan, are at ${input.place.join(", ")}.`] : []),
    "",
    `## Spec ${input.spec?.id}: ${input.spec?.title}`,
    "",
    ...(input.spec?.acceptanceCriteria ?? []).map((c) => `- ${c.id} (${c.kind}, ${c.surface}, ${c.priority}): ${c.statement}`),
    "",
    ...(input.request.trim() ? ["## Guidance from the person who will approve it", "", input.request, ""] : []),
  ].join("\n");
}

/** Parse the drafter's answer; a fenced block is unwrapped, unknown task fields are stripped and named; never throws. */
export function parseDraftOutput(mode: "spec" | "plan", text: string | null): DraftParse {
  if (text === null || text.trim() === "") return { ok: false, reason: "no output file was written" };
  let body = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(body);
  if (fence) body = fence[1]!.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err: unknown) {
    return { ok: false, reason: `the output is not JSON (${(err as Error).message.slice(0, 120)})` };
  }
  if (mode === "spec") {
    // Criteria are strict: keep only their known fields, so a stray key costs nothing but itself.
    const r = raw as { acceptanceCriteria?: unknown };
    if (Array.isArray(r?.acceptanceCriteria)) {
      r.acceptanceCriteria = r.acceptanceCriteria.map((c: Record<string, unknown>) => (c && typeof c === "object" ? Object.fromEntries(Object.entries(c).filter(([k]) => ["id", "statement", "kind", "surface", "priority"].includes(k))) : c));
    }
    const parsed = SpecDraftSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
    const ids = parsed.data.acceptanceCriteria.map((c) => c.id);
    if (new Set(ids).size !== ids.length) return { ok: false, reason: "acceptance criterion ids repeat" };
    return { ok: true, mode, draft: parsed.data, stripped: [] };
  }
  const stripped: string[] = [];
  const tasks = (raw as { tasks?: unknown })?.tasks;
  if (Array.isArray(tasks)) {
    for (const t of tasks as Record<string, unknown>[]) {
      if (!t || typeof t !== "object") continue;
      for (const f of DRAFT_STRIPPED_TASK_FIELDS) if (f in t) {
        stripped.push(`${String(t.id ?? "?")}.${f}`);
        delete t[f];
      }
    }
  }
  const parsed = PlanDraftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  const ids = parsed.data.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "task ids repeat" };
  return { ok: true, mode, draft: parsed.data, stripped };
}

export function draftWorkflow(ports: DraftPorts, mode: "spec" | "plan"): Workflow {
  const paths = ports.ws.paths;
  return {
    id: mode === "spec" ? SPEC_DRAFT_WORKFLOW_ID : PLAN_DRAFT_WORKFLOW_ID,
    version: "1",
    entry: "materialize",
    state: { log: { kind: "append" } },
    nodes: {
      materialize: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as DraftInput;
          const { treeDir } = await ports.materializer.materialize({ runId: ctx.runId, sourceRoot: input.workspaceRoot, sourceMode: input.sourceMode });
          const copy = await fingerprintTree(treeDir, { mode: "fs" });
          if (copy.fingerprint !== input.sourceFingerprint) {
            await ports.materializer.dispose(treeDir);
            throw new TaskExecutionError("materialize_mismatch", `the drafting copy (${copy.fingerprint}) does not match the checkout (${input.sourceFingerprint})`);
          }
          // The copy leaves .legion-flow/ out, so the current spec and plan are placed into it at their usual paths.
          for (const rel of input.place) {
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
        effect: "drafter_spawn",
        run: async (state, ctx) => {
          const input = state as unknown as DraftInput;
          const runDir = join(paths.cacheRunsDir, ctx.runId);
          await mkdir(runDir, { recursive: true });
          const promptPath = join(runDir, "prompt.md");
          await writeFile(promptPath, renderDraftPrompt(input, DRAFT_OUTPUT_FILE), "utf8");
          await writeFile(join(runDir, "brief.json"), JSON.stringify({ kind: "draft", mode: input.mode, outputFile: DRAFT_OUTPUT_FILE }, null, 2) + "\n", "utf8");
          const outcome = await ports.adapter.run({ runId: ctx.runId, workspaceRoot: input.workspaceRoot, treeDir: state.treeDir as string, promptPath, signal: ctx.signal, timeoutMs: ports.adapterTimeoutMs ?? 30 * 60 * 1000, exec: ports.materializer.exec, envMode: ports.envMode ?? "host", outputFile: DRAFT_OUTPUT_FILE, ...(input.model ? { model: input.model } : {}) });
          const tail = (s: string) => redact(s.length > 2000 ? s.slice(-2000) : s, ports.redactValues ?? []).text;
          await ports.ws.runs.writeEvidence(ctx.runId, { kind: "adapter_outcome", adapter: ports.adapter.id, role: "drafter", ...outcome, stdoutTail: tail(outcome.stdoutTail), stderrTail: tail(outcome.stderrTail) }, ctx.held, "spawn");
          return { writes: { drafterOk: !outcome.spawnError && !outcome.timedOut && outcome.exitCode === 0, log: "drafter finished" }, next: ["collect"] };
        },
      },
      collect: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          const input = state as unknown as DraftInput;
          const treeDir = state.treeDir as string;
          let result: DraftResult;
          try {
            const text = await readFile(join(paths.cacheRunsDir, ctx.runId, DRAFT_OUTPUT_FILE), "utf8").catch(() => null);
            // The raw answer is evidence whether or not it parses, so a refusal can be read back.
            if (text !== null) await ports.ws.runs.writeEvidence(ctx.runId, { kind: "draft_output", mode: input.mode, text: redact(text.slice(0, 64 * 1024), ports.redactValues ?? []).text }, ctx.held, "collect");
            result = !state.drafterOk && text === null ? { ran: false, parse: { ok: false, reason: "the drafting agent did not finish" } } : { ran: true, parse: parseDraftOutput(input.mode, text) };
          } finally {
            await ports.materializer.dispose(treeDir);
          }
          return { writes: { draft: result, log: result.parse.ok ? "draft parsed" : `draft refused: ${result.parse.reason}` } };
        },
      },
    },
  };
}
