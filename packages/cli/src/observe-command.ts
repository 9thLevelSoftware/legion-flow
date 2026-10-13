/**
 * `observe` (M4 slice i): list the clusters the algorithm finds in memory, propose
 * one for a human decision, and commit decided ones. The algorithm decides what is
 * grouped; a template names it; a decision owner may reword it but never change
 * its members. Since slice (p), `--agent` first runs a separate naming workflow
 * whose suggestion travels in the proposal's payload; approving commits those words.
 */
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  SCHEMA_VERSIONS,
  MEMORY_OBSERVE_ACTION,
  MEMORY_OBSERVE_WORKFLOW_ID,
  ObservationEditSchema,
  type Diagnostic,
  type FactRow,
  type ObservationCandidate,
  type ObservationSuggestion,
  type ResultEnvelope,
} from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, type HeldLock, type LoadedInterrupt, type LoadedRun, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { resumeWorkflow, runWorkflow, type Workflow } from "@9thlevelsoftware/legion-flow-engine";
import { clusterObservations, corroborationsOf, currentFacts, replayObservations, syncFacts, validEpisodes } from "@9thlevelsoftware/legion-flow-memory";

export const OBSERVE_WORKFLOW_ID = MEMORY_OBSERVE_WORKFLOW_ID;
export const OBSERVE_ACTION = MEMORY_OBSERVE_ACTION;
const OBSERVE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

type Envelope = (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], runId?: string) => Promise<ResultEnvelope>;

export interface ObserveOptions {
  propose?: string;
  resume?: boolean;
  /** M4 slice p: have the namer member suggest the words before proposing. */
  agent?: boolean;
}

/** The namer's suggestion as it travels in the proposal: the words plus whose they are. */
export interface ObservationSuggestionRecord extends ObservationSuggestion {
  by: { adapter: string; model?: string; runId: string };
}

/** What `--agent` needs from the composition root: run the naming workflow in the right tier, or answer a refusal. */
export type ObservationSuggester = (candidate: ObservationCandidate, facts: FactRow[]) => Promise<{ envelope: ResultEnvelope } | { suggestion?: ObservationSuggestionRecord; note?: string; runId?: string }>;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
/** Members are the facts and the episodes that mention them: a new mention is a different cluster. */
const sameMembers = (a: Pick<ObservationCandidate, "factIds" | "episodeIds">, b: Pick<ObservationCandidate, "factIds" | "episodeIds">) => sameSet(a.factIds, b.factIds) && sameSet(a.episodeIds, b.episodeIds);

/**
 * The observation workflow: one interrupt, then commit (if the members still hold) or discard.
 * Version "1" on purpose through slice (p): the graph is unchanged and a run without a suggestion in its state
 * (every run recorded before slice p) commits exactly what it did, so pending decisions still resume.
 */
export function observeWorkflow(ws: Workspace, now: () => Date): Workflow {
  const decider = async (runId: string, interruptId: string) => (await ws.interrupts.list(runId, now())).find((i) => i.interrupt.id === interruptId)?.decision?.decidedBy.id;
  return {
    id: OBSERVE_WORKFLOW_ID,
    version: "1",
    entry: "propose",
    state: {},
    nodes: {
      propose: {
        retry: { maxAttempts: 1 },
        run: (state) => {
          const c = state.candidate as ObservationCandidate;
          const suggestion = state.suggestion as ObservationSuggestionRecord | undefined;
          return {
            writes: {},
            interrupt: {
              kind: "approve_action",
              action: { name: OBSERVE_ACTION, riskClass: "retention", args: { candidateId: c.id, factIds: c.factIds } },
              payload: { candidate: c, ...(suggestion ? { suggestion } : {}) },
              expiresInMs: OBSERVE_EXPIRES_MS,
              onTimeout: "cancel",
              resume: { onApprove: "commit", onReject: "discard" },
            },
          };
        },
      },
      commit: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const c = state.candidate as ObservationCandidate;
          const interruptId = ctx.decision?.interruptId ?? "";
          // The algorithm is asked again: a member that changed since the proposal means the human decided on something that no longer exists.
          const current = clusterObservations(await syncFacts(ws, ctx.held), corroborationsOf(await validEpisodes(ws))).find((x) => x.id === c.id);
          if (!current || !sameMembers(current, c)) {
            await ws.audit.append({ type: "observation_rejected", runId: ctx.runId, candidateId: c.id, interruptId, reason: "members_changed" }, ctx.held);
            return { writes: { outcome: "members_changed" } };
          }
          const edit = ctx.decision?.decision === "edit" ? ObservationEditSchema.safeParse(ctx.decision.editedArgs) : null;
          const words = edit?.success ? edit.data : {};
          const suggestion = state.suggestion as ObservationSuggestionRecord | undefined;
          const decidedBy = (await decider(ctx.runId, interruptId)) ?? "unknown";
          // A human's words win; then the namer's (approved as shown in the payload); then the template's. The record says
          // "human" only when none of the namer's words remain: a partial edit keeps "agent", with edited telling the rest.
          const edited = Boolean(words.name || words.summary);
          const base = suggestion ?? { name: c.name, summary: c.summary };
          const modelWordsRemain = suggestion !== undefined && !(words.name && words.summary);
          const wording = modelWordsRemain ? { by: "agent" as const, adapter: suggestion.by.adapter, ...(suggestion.by.model ? { model: suggestion.by.model } : {}), runId: suggestion.by.runId } : edited ? { by: "human" as const } : { by: "template" as const };
          const { episode } = await ws.episodes.record(
            { schema: SCHEMA_VERSIONS.EPISODE, kind: "observation", createdAt: now().toISOString(), candidateId: c.id, name: words.name ?? base.name, summary: words.summary ?? base.summary, keys: c.keys, factIds: c.factIds, episodeIds: c.episodeIds, origins: c.origins, edited, decidedBy, interruptId, wording },
            ctx.held
          );
          await ws.audit.append({ type: "observation_committed", runId: ctx.runId, candidateId: c.id, episodeId: episode.id, facts: c.factIds.length, decidedBy, interruptId }, ctx.held);
          return { writes: { outcome: "approved", episodeId: episode.id } };
        },
      },
      discard: {
        retry: { maxAttempts: 1 },
        run: async (state, ctx) => {
          const c = state.candidate as ObservationCandidate;
          await ws.audit.append({ type: "observation_rejected", runId: ctx.runId, candidateId: c.id, interruptId: ctx.decision?.interruptId ?? null, reason: "rejected" }, ctx.held);
          return { writes: { outcome: "rejected" } };
        },
      },
    },
  };
}

/** Open observation runs, each with its live interrupt and the candidate it names (read from the payload evidence). */
async function openObserveRuns(ws: Workspace, now: Date): Promise<{ run: LoadedRun; open: LoadedInterrupt; candidate: ObservationCandidate }[]> {
  const out: { run: LoadedRun; open: LoadedInterrupt; candidate: ObservationCandidate }[] = [];
  for (const r of await ws.runs.list()) {
    if (r.run.kind !== "workflow" || r.run.workflowId !== OBSERVE_WORKFLOW_ID || (r.run.status !== "running" && r.run.status !== "awaiting_decision")) continue;
    const open = (await ws.interrupts.list(r.run.id, now)).find((i) => !i.interrupt.consumedAt && i.effectiveStatus !== "cancelled");
    if (!open) continue;
    try {
      const p = JSON.parse(await readFile(join(ws.paths.project, ...open.interrupt.payloadRef.path.split("/")), "utf8")) as { payload: { candidate: ObservationCandidate } };
      out.push({ run: r, open, candidate: p.payload.candidate });
    } catch {
      // an unreadable payload names nothing
    }
  }
  return out;
}

export async function observeVerb(ws: Workspace, opts: ObserveOptions, envelope: Envelope, held: HeldLock, now: () => Date, statusNext: () => Promise<ResultEnvelope["nextAction"]>, suggest?: ObservationSuggester): Promise<ResultEnvelope> {
  if (opts.agent && opts.propose === undefined) return envelope("usage_error", [{ code: "observe_usage", severity: "error", message: "--agent goes with --propose <id>: the namer suggests words for one cluster." }], { type: "command", run: "legion-flow observe" });
  if (opts.resume && opts.propose) return envelope("usage_error", [{ code: "observe_usage", severity: "error", message: "Give --propose <id> or --resume, not both." }], { type: "command", run: "legion-flow observe" });
  if (opts.resume) return resumeObservations(ws, envelope, held, now);

  const { rows } = await currentFacts(ws);
  const episodes = await validEpisodes(ws);
  const candidates = clusterObservations(rows, corroborationsOf(episodes));
  const observations = replayObservations(episodes, rows);
  const open = await openObserveRuns(ws, now());
  const committed = (c: ObservationCandidate) => observations.find((o) => o.status === "active" && o.episode.candidateId === c.id && sameMembers(o.episode, c));
  const pending = (c: ObservationCandidate) => open.find((o) => o.candidate.id === c.id);

  if (opts.propose !== undefined) {
    const c = candidates.find((x) => x.id === opts.propose);
    if (!c) return envelope("refused", [{ code: "observation_unknown", severity: "error", message: `No current candidate is ${opts.propose}; candidates change as facts do.`, hint: "Run legion-flow observe to list them." }], { type: "command", run: "legion-flow observe" });
    const done = committed(c);
    if (done) return envelope("refused", [{ code: "observation_exists", severity: "error", message: `${c.id} is already committed as ${done.episode.id} with these members.` }], await statusNext());
    const waiting = pending(c);
    if (waiting) return envelope("refused", [{ code: "observation_pending", severity: "error", message: `${c.id} already awaits decision ${waiting.open.interrupt.id}.`, path: waiting.open.path }], { type: "human_decision", interruptId: waiting.open.interrupt.id, decisionKind: waiting.open.interrupt.kind, run: `legion-flow decide ${waiting.open.interrupt.id} --approve --approver <id>`, payloadRef: waiting.open.interrupt.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION });
    // M4 slice p: the namer's suggestion, from a run of its own; a failure is a note and the template stands.
    let suggestion: ObservationSuggestionRecord | undefined;
    const namingNotes: Diagnostic[] = [];
    if (opts.agent) {
      if (!suggest) return envelope("refused", [{ code: "observe_agent_unavailable", severity: "error", message: "This build cannot run the observation namer." }], { type: "command", run: `legion-flow observe --propose ${c.id}` });
      const named = await suggest(c, rows.filter((r) => c.factIds.includes(r.id)));
      if ("envelope" in named) return named.envelope;
      if (named.suggestion) {
        suggestion = named.suggestion;
        namingNotes.push({ code: "observation_suggestion", severity: "info", message: `The namer (${suggestion.by.adapter}${suggestion.by.model ? ` ${suggestion.by.model}` : ""}, run ${suggestion.by.runId}) suggests: <untrusted-content source="observation-namer">${suggestion.name}: ${suggestion.summary}</untrusted-content> Approving commits these words; --edit replaces them.` });
      } else namingNotes.push({ code: "observation_naming_failed", severity: "warning", message: `No suggestion: ${named.note ?? "the namer did not finish"}${named.runId ? ` (run ${named.runId})` : ""}. The template's words stand.` });
    }
    const result = await runWorkflow(ws, observeWorkflow(ws, now), held, { input: { candidate: c, ...(suggestion ? { suggestion } : {}) }, now, durability: "sync" });
    await ws.audit.append({ type: "observation_proposed", candidateId: c.id, facts: c.factIds.length, runId: result.kind === "refused" ? null : result.runId, suggested: suggestion ? suggestion.by.runId : null }, held);
    if (result.kind !== "awaiting_decision") return envelope("blocked", [{ code: "observation_not_opened", severity: "error", message: `The observation workflow ended ${result.kind} instead of awaiting a decision.` }], { type: "command", run: "legion-flow status" });
    const i = result.interrupt;
    return envelope(
      "awaiting_decision",
      [
        { code: "observation_pending", severity: "warning", message: `${c.id} "${c.name}" (${c.factIds.length} fact(s), ${c.episodeIds.length} episodes) awaits a decision owner on ${i.id} until ${i.expiresAt}. --edit may change only {"name", "summary"}.`, path: join(ws.paths.project, ...i.payloadRef.path.split("/")) },
        ...namingNotes,
        ...(c.origins.deterministic + c.origins.human === 0 ? [{ code: "observation_unverified", severity: "warning" as const, message: "Every member was recorded by an agent (origin llm): the cluster repeats an unverified statement." }] : []),
      ],
      { type: "human_decision", interruptId: i.id, decisionKind: i.kind, run: `legion-flow decide ${i.id} --approve --approver <id>`, payloadRef: i.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION },
      result.runId
    );
  }

  const doc = { candidates: candidates.map((c) => ({ ...c, state: committed(c) ? "committed" : pending(c) ? "pending" : "new" })), observations: observations.map((o) => ({ id: o.episode.id, candidateId: o.episode.candidateId, name: o.episode.name, status: o.status, ...(o.retiredBy ? { retiredBy: o.retiredBy } : {}), ...(o.stale ? { stale: o.stale } : {}) })) };
  const bytes = JSON.stringify(doc, null, 2) + "\n";
  const dir = join(ws.paths.varDir, "cache", "observe");
  const path = join(dir, `candidates-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(path, bytes);
  const fresh = doc.candidates.filter((c) => c.state === "new");
  const diagnostics: Diagnostic[] = [
    { code: "observe_document", severity: "info", message: `${candidates.length} candidate(s) from ${rows.filter((r) => r.status === "active").length} active fact(s), grouped by statement key with no model; ${observations.filter((o) => o.status === "active").length} committed observation(s) in force.`, path },
    ...doc.candidates.slice(0, 20).map((c) => ({ code: "observation_candidate", severity: "info" as const, message: `${c.id} [${c.state}] ${c.name}: ${c.factIds.length} fact(s) mentioned in ${c.episodeIds.length} episodes; mentions ${c.origins.deterministic} deterministic, ${c.origins.human} human, ${c.origins.llm} llm.` })),
    ...observations.filter((o) => o.status === "active" && o.stale).map((o) => ({ code: "observation_stale", severity: "warning" as const, message: `${o.episode.id} "${o.episode.name}" is stale: ${o.stale}.` })),
  ];
  return envelope("ok", diagnostics, fresh.length ? { type: "command", run: `legion-flow observe --propose ${fresh[0]!.id}`, hint: "Proposing asks a decision owner to commit it; agents may propose, never decide." } : await statusNext());
}

/** Every observation run whose interrupt was decided or expired is resumed; pending ones are named. */
async function resumeObservations(ws: Workspace, envelope: Envelope, held: HeldLock, now: () => Date): Promise<ResultEnvelope> {
  const open = await openObserveRuns(ws, now());
  if (open.length === 0) return envelope("refused", [{ code: "no_run_to_resume", severity: "error", message: "No observation is waiting to be resumed." }], { type: "command", run: "legion-flow status" });
  const diagnostics: Diagnostic[] = [];
  let pendingFirst: LoadedInterrupt | null = null;
  let resumed = 0;
  for (const { run, open: i, candidate } of open) {
    if (i.effectiveStatus === "pending") {
      pendingFirst ??= i;
      diagnostics.push({ code: "decision_pending", severity: "warning", message: `${i.interrupt.id} still awaits a decision.`, path: i.path });
      continue;
    }
    const result = await resumeWorkflow(ws, observeWorkflow(ws, now), run.run.id, i.interrupt.id, held, { now });
    resumed++;
    if (result.kind === "complete") {
      const outcome = String(result.values.outcome);
      diagnostics.push(
        outcome === "approved"
          ? { code: "observation_committed", severity: "info", message: `${candidate.id} is committed as ${String(result.values.episodeId)}.`, path: join(ws.paths.episodesDir, `${String(result.values.episodeId)}.json`) }
          : outcome === "members_changed"
            ? { code: "observation_members_changed", severity: "warning", message: `${candidate.id} was not committed: its members changed after it was proposed.`, hint: "Run legion-flow observe and propose the current candidate." }
            : { code: "observation_rejected", severity: "info", message: `${candidate.id} was rejected; nothing is recorded.` }
      );
    } else if (result.kind === "cancelled") {
      await ws.audit.append({ type: "observation_expired", runId: run.run.id, candidateId: candidate.id, interruptId: i.interrupt.id }, held);
      diagnostics.push({ code: "observation_expired", severity: "info", message: `${candidate.id} lapsed: its decision expired.` });
    } else {
      diagnostics.push({ code: "observation_run_failed", severity: "error", message: `Run ${run.run.id} ended ${result.kind}${result.kind === "failed" ? `: ${result.error}` : ""}.` });
    }
  }
  if (resumed === 0 && pendingFirst) {
    return envelope("awaiting_decision", diagnostics, { type: "human_decision", interruptId: pendingFirst.interrupt.id, decisionKind: pendingFirst.interrupt.kind, run: `legion-flow decide ${pendingFirst.interrupt.id} --approve --approver <id>`, payloadRef: pendingFirst.interrupt.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION });
  }
  return envelope(diagnostics.some((d) => d.severity === "error") ? "blocked" : "ok", diagnostics, { type: "command", run: "legion-flow status" });
}
