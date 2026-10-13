/**
 * `learn` and `retro`: the only ways facts enter memory. A fact is structured
 * (typed subject, predicate, object), its origin is `llm` unless a decision
 * owner asserts it on a terminal, and it never overwrites another: a conflict
 * opens a `memory.supersede` interrupt that a human decides, and `learn --resume`
 * commits the decision. `retro` writes a release's deterministic facts.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEMA_VERSIONS,
  MEMORY_SUPERSEDE_ACTION,
  MEMORY_SUPERSEDE_WORKFLOW_ID,
  FactRefSchema,
  PredicateSchema,
  type Diagnostic,
  type Fact,
  type FactRow,
  type ProjectConfig,
  type ResultEnvelope,
} from "@9thlevelsoftware/legion-flow-schema";
import { newId, type HeldLock, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { runWorkflow, resumeWorkflow, type Workflow } from "@9thlevelsoftware/legion-flow-engine";
import { conflictsFor, mapStatus, MemoryIndex, recall, syncFacts, validEpisodes } from "@9thlevelsoftware/legion-flow-memory";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { atomicWriteFile } from "@9thlevelsoftware/legion-flow-persist";

export const SUPERSEDE_WORKFLOW_ID = MEMORY_SUPERSEDE_WORKFLOW_ID;
export const SUPERSEDE_ACTION = MEMORY_SUPERSEDE_ACTION;
const SUPERSEDE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

type Envelope = (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], runId?: string) => Promise<ResultEnvelope>;

export interface LearnOptions {
  subject?: string;
  predicate?: string;
  object?: string;
  text?: string;
  validAt?: string;
  supersedes?: string[];
  approver?: string;
  resume?: boolean;
}

const describe = (f: Pick<Fact, "subject" | "predicate" | "object">) => `${f.subject} ${f.predicate} ${"ref" in f.object ? f.object.ref : JSON.stringify(f.object.text)}`;

/** The supersession workflow: one interrupt, then commit or discard. Defined in code like every workflow. */
export function supersedeWorkflow(ws: Workspace, now: () => Date): Workflow {
  const record = async (state: Record<string, unknown>, ctx: { runId: string; held: HeldLock; decision?: { interruptId: string } }, outcome: "approved" | "rejected") => {
    const interruptId = ctx.decision?.interruptId ?? "";
    const decided = (await ws.interrupts.list(ctx.runId, now())).find((i) => i.interrupt.id === interruptId);
    const decidedBy = decided?.decision?.decidedBy.id;
    await ws.episodes.record(
      { schema: SCHEMA_VERSIONS.EPISODE, kind: "supersession", createdAt: now().toISOString(), newFactId: String(state.newFactId), oldFactIds: state.oldFactIds as string[], outcome, interruptId, ...(decidedBy ? { decidedBy } : {}) },
      ctx.held
    );
    await syncFacts(ws, ctx.held);
    await ws.audit.append({ type: outcome === "approved" ? "fact_superseded" : "fact_rejected", runId: ctx.runId, newFactId: state.newFactId, oldFactIds: state.oldFactIds, interruptId, decidedBy: decidedBy ?? null }, ctx.held);
    return { writes: { outcome } };
  };
  return {
    id: SUPERSEDE_WORKFLOW_ID,
    version: "1",
    entry: "propose",
    state: {},
    nodes: {
      propose: {
        retry: { maxAttempts: 1 },
        run: (state) => ({
          writes: {},
          interrupt: {
            kind: "approve_action",
            action: { name: SUPERSEDE_ACTION, riskClass: "retention", args: { newFactId: state.newFactId, oldFactIds: state.oldFactIds } },
            payload: { newFact: state.newFact, oldFacts: state.oldFacts },
            expiresInMs: SUPERSEDE_EXPIRES_MS,
            onTimeout: "cancel",
            resume: { onApprove: "commit", onReject: "discard" },
          },
        }),
      },
      commit: { retry: { maxAttempts: 1 }, run: (state, ctx) => record(state, ctx, "approved") },
      discard: { retry: { maxAttempts: 1 }, run: (state, ctx) => record(state, ctx, "rejected") },
    },
  };
}

/** Check a module or symbol subject against the map when it is fresh; otherwise say it went unchecked. */
async function verifySubject(ws: Workspace, subject: string): Promise<{ verified: boolean; unknown?: string; note?: Diagnostic }> {
  const m = /^(module|symbol):(.+)$/.exec(subject);
  if (!m) return { verified: true };
  const status = await mapStatus(ws);
  if (status.freshness !== "fresh") return { verified: false, note: { code: "subject_unverified", severity: "warning", message: `The map is ${status.freshness}, so ${subject} was not checked against it.`, hint: "Run legion-flow map to have subjects checked." } };
  const index = await MemoryIndex.openExisting(ws.paths.indexSqlite);
  try {
    if (!index) return { verified: false };
    if (m[1] === "module") return index.hasModule(m[2]!) ? { verified: true } : { verified: false, unknown: `${m[2]} is not a module in the map` };
    const [path, name] = [m[2]!.slice(0, m[2]!.lastIndexOf("#")), m[2]!.slice(m[2]!.lastIndexOf("#") + 1)];
    return index.readMapFacts().symbols.some((s) => s.module === path && s.name === name) ? { verified: true } : { verified: false, unknown: `${path} declares no exported symbol ${name}` };
  } finally {
    index?.close();
  }
}

export async function learnVerb(
  ws: Workspace,
  isTTY: boolean,
  config: ProjectConfig,
  opts: LearnOptions,
  envelope: Envelope,
  held: HeldLock,
  now: () => Date
): Promise<ResultEnvelope> {
  if (opts.resume) return resumeSupersessions(ws, envelope, held, now);
  const usage = (message: string): Promise<ResultEnvelope> => envelope("usage_error", [{ code: "learn_usage", severity: "error", message }], { type: "command", run: 'legion-flow learn <subject> <predicate> --object <ref> | --text "<text>"' });
  if (!opts.subject || !opts.predicate) return usage("learn needs a subject and a predicate.");
  if ((opts.object === undefined) === (opts.text === undefined)) return usage("Give exactly one of --object <ref> or --text <text>.");
  const subject = FactRefSchema.safeParse(opts.subject);
  if (!subject.success) return usage(`Subject: ${subject.error.issues[0]?.message}`);
  const predicate = PredicateSchema.safeParse(opts.predicate);
  if (!predicate.success) return usage(`Predicate: ${predicate.error.issues[0]?.message}`);
  let object: Fact["object"];
  if (opts.object !== undefined) {
    const ref = FactRefSchema.safeParse(opts.object);
    if (!ref.success) return usage(`--object: ${ref.error.issues[0]?.message}`);
    object = { ref: ref.data };
  } else {
    if (opts.text!.length === 0 || opts.text!.length > 2000) return usage("--text must be 1 to 2000 characters.");
    object = { text: opts.text! };
  }
  const nowIso = now().toISOString();
  const validAt = opts.validAt ?? nowIso;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(validAt) || Number.isNaN(Date.parse(validAt))) return usage(`--valid-at must be an ISO-8601 date or time (got '${validAt}').`);

  let origin: Fact["origin"] = "llm";
  let assertedBy: string | undefined;
  if (opts.approver !== undefined) {
    if (!isTTY) return envelope("refused", [{ code: "human_assertion_requires_tty", severity: "error", message: "A fact asserted as human (--approver) is recorded only from a terminal.", hint: "Run it yourself on a terminal, or omit --approver to record it as llm-origin." }], { type: "none", reason: "A human assertion is a human act." });
    if (!config.decisionOwners.some((o) => o.id === opts.approver)) {
      return envelope("refused", [{ code: "approver_not_owner", severity: "error", message: `'${opts.approver}' is not a decision owner of this project (owners: ${config.decisionOwners.map((o) => o.id).join(", ")}).` }], { type: "none", reason: "Only a decision owner asserts a human fact." });
    }
    origin = "human";
    assertedBy = opts.approver;
  }

  const check = await verifySubject(ws, subject.data);
  if (check.unknown) return envelope("refused", [{ code: "fact_subject_unknown", severity: "error", message: `${check.unknown}; the map is fresh, so the subject is refused.`, hint: "Check the path or name with legion-flow map --deps <path> or --who-uses <name>." }], { type: "command", run: "legion-flow map" });

  const rows = await syncFacts(ws, held);
  for (const id of opts.supersedes ?? []) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.status !== "active") return envelope("refused", [{ code: "fact_not_active", severity: "error", message: `--supersedes ${id}: ${row ? `that fact is ${row.status}` : "no such fact"}; only an active fact can be replaced.` }], { type: "command", run: "legion-flow status" });
  }
  const draft = { subject: subject.data, predicate: predicate.data, object, ...(opts.supersedes?.length ? { supersedes: [...opts.supersedes] } : {}) };
  const same = rows.find((r) => (r.status === "active" || r.status === "proposed") && r.subject === draft.subject && r.predicate === draft.predicate && JSON.stringify(r.object) === JSON.stringify(object));
  if (same && !opts.supersedes?.length) {
    // An active fact said again is corroborated (M4 slice i): no second fact, a link from a new episode, so clustering can see the repetition.
    if (same.status === "active") {
      const { episode } = await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "corroboration", createdAt: nowIso, factId: same.id, origin, ...(assertedBy ? { assertedBy } : {}) }, held);
      await ws.audit.append({ type: "fact_corroborated", factId: same.id, episodeId: episode.id, origin }, held);
      return envelope("ok", [{ code: "fact_exists", severity: "info", message: `${same.id} already records this (${same.origin}): ${describe(same)}; corroborated by ${episode.id} (${origin}), no second fact written.`, path: join(ws.paths.episodesDir, `${episode.id}.json`) }], { type: "command", run: "legion-flow observe", hint: "A repeated statement may now form an observation candidate." });
    }
    return envelope("ok", [{ code: "fact_exists", severity: "info", message: `${same.id} already records this (${same.status}, ${same.origin}): ${describe(same)}; nothing new was written.` }], { type: "command", run: "legion-flow status" });
  }
  const singleValued = config.memory?.singleValued ?? [];
  const conflicts = conflictsFor(rows, draft, singleValued);
  const fact: Fact = {
    id: newId("fct"),
    ...draft,
    ...(conflicts.length ? { supersedes: conflicts.map((c) => c.id) } : {}),
    validAt: new Date(validAt).toISOString(),
    createdAt: nowIso,
    origin,
    ...(assertedBy ? { assertedBy } : {}),
  };
  const notes: Diagnostic[] = check.note ? [check.note] : [];

  if (conflicts.length === 0) {
    const { episode } = await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "learn", createdAt: nowIso, fact, status: "active", subjectVerified: check.verified }, held);
    await syncFacts(ws, held);
    await ws.audit.append({ type: "fact_learned", factId: fact.id, episodeId: episode.id, origin, assertedBy: assertedBy ?? null }, held);
    return envelope("ok", [...notes, { code: "fact_learned", severity: "info", message: `Learned ${fact.id} (${origin}): ${describe(fact)}, valid from ${fact.validAt}.`, path: join(ws.paths.episodesDir, `${episode.id}.json`) }], { type: "command", run: "legion-flow status" });
  }

  // A conflict never overwrites: the new fact waits as proposed, and a human decides.
  const { episode } = await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "learn", createdAt: nowIso, fact, status: "proposed", subjectVerified: check.verified }, held);
  const result = await runWorkflow(ws, supersedeWorkflow(ws, now), held, { input: { newFactId: fact.id, oldFactIds: conflicts.map((c) => c.id), newFact: fact, oldFacts: conflicts }, now, durability: "sync" });
  await ws.audit.append({ type: "fact_proposed", factId: fact.id, episodeId: episode.id, supersedes: conflicts.map((c) => c.id), runId: result.kind === "refused" ? null : result.runId }, held);
  if (result.kind !== "awaiting_decision") {
    return envelope("blocked", [...notes, { code: "supersession_not_opened", severity: "error", message: `The supersession workflow ended ${result.kind} instead of awaiting a decision; ${fact.id} stays proposed.` }], { type: "command", run: "legion-flow status" });
  }
  const i = result.interrupt;
  return envelope(
    "awaiting_decision",
    [
      ...notes,
      ...conflicts.map((c) => ({ code: "fact_conflict", severity: "warning" as const, message: `${fact.id} would replace ${c.id} (${c.origin}): ${describe(c)}.` })),
      { code: "supersession_pending", severity: "warning", message: `${fact.id} is proposed until a decision owner decides ${i.id}; recall does not return it meanwhile. Expires ${i.expiresAt}.`, path: join(ws.paths.project, ...i.payloadRef.path.split("/")) },
    ],
    { type: "human_decision", interruptId: i.id, decisionKind: i.kind, run: `legion-flow decide ${i.id} --approve --approver <id>`, payloadRef: i.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION },
    result.runId
  );
}

/** Every supersession run whose interrupt was decided or expired is resumed; pending ones are named. */
async function resumeSupersessions(ws: Workspace, envelope: Envelope, held: HeldLock, now: () => Date): Promise<ResultEnvelope> {
  const runs = (await ws.runs.list()).filter((r) => r.run.kind === "workflow" && r.run.workflowId === SUPERSEDE_WORKFLOW_ID && (r.run.status === "running" || r.run.status === "awaiting_decision"));
  if (runs.length === 0) {
    const orphans = (await syncFacts(ws, held)).filter((r) => r.status === "proposed");
    return envelope("refused", [{ code: "no_run_to_resume", severity: "error", message: "No supersession is waiting to be resumed." }, ...orphans.map((o) => ({ code: "fact_proposal_orphaned", severity: "warning" as const, message: `${o.id} is proposed but no supersession run is waiting on it; it stays out of recall.` }))], { type: "command", run: "legion-flow status" });
  }
  const diagnostics: Diagnostic[] = [];
  let pendingFirst: { id: string; kind: string; payloadRef: { path: string; sha256: string } } | null = null;
  let resumed = 0;
  for (const r of runs) {
    const open = (await ws.interrupts.list(r.run.id, now())).find((i) => !i.interrupt.consumedAt && i.effectiveStatus !== "cancelled");
    if (!open) continue;
    if (open.effectiveStatus === "pending") {
      pendingFirst ??= { id: open.interrupt.id, kind: open.interrupt.kind, payloadRef: open.interrupt.payloadRef };
      diagnostics.push({ code: "decision_pending", severity: "warning", message: `${open.interrupt.id} still awaits a decision.`, path: open.path });
      continue;
    }
    // The interrupt keeps a fingerprint of its arguments; the facts themselves are in its payload evidence.
    const payload = JSON.parse(await readFile(join(ws.paths.project, ...open.interrupt.payloadRef.path.split("/")), "utf8")) as { payload: { newFact: Fact; oldFacts: FactRow[] } };
    const args = { newFactId: payload.payload.newFact.id, oldFactIds: payload.payload.oldFacts.map((o) => o.id) };
    const result = await resumeWorkflow(ws, supersedeWorkflow(ws, now), r.run.id, open.interrupt.id, held, { now });
    resumed++;
    if (result.kind === "complete") {
      const outcome = String(result.values.outcome);
      diagnostics.push({ code: outcome === "approved" ? "fact_superseded" : "fact_rejected", severity: "info", message: outcome === "approved" ? `${args.newFactId} replaces ${args.oldFactIds.join(", ")}; the old fact(s) stay on record, invalid from the new fact's valid time.` : `${args.newFactId} was rejected; the existing fact(s) stand.` });
    } else if (result.kind === "cancelled") {
      // An expired supersession with onTimeout cancel: the proposal lapses, recorded as such.
      await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "supersession", createdAt: now().toISOString(), newFactId: args.newFactId, oldFactIds: args.oldFactIds, outcome: "expired", interruptId: open.interrupt.id }, held);
      await syncFacts(ws, held);
      await ws.audit.append({ type: "fact_rejected", runId: r.run.id, newFactId: args.newFactId, oldFactIds: args.oldFactIds, interruptId: open.interrupt.id, reason: "expired" }, held);
      diagnostics.push({ code: "fact_expired", severity: "info", message: `${args.newFactId} lapsed: its decision expired, so the existing fact(s) stand.` });
    } else {
      diagnostics.push({ code: "supersession_run_failed", severity: "error", message: `Run ${r.run.id} ended ${result.kind}${result.kind === "failed" ? `: ${result.error}` : ""}.` });
    }
  }
  const live = new Set<string>();
  for (const r of runs) {
    for (const i of await ws.interrupts.list(r.run.id, now())) {
      try {
        const p = JSON.parse(await readFile(join(ws.paths.project, ...i.interrupt.payloadRef.path.split("/")), "utf8")) as { payload: { newFact: Fact } };
        live.add(p.payload.newFact.id);
      } catch {
        // an unreadable payload cannot vouch for anything
      }
    }
  }
  for (const orphan of (await syncFacts(ws, held)).filter((r) => r.status === "proposed" && !live.has(r.id))) {
    diagnostics.push({ code: "fact_proposal_orphaned", severity: "warning", message: `${orphan.id} is proposed but no supersession run is waiting on it (the run ended or was never opened); it stays out of recall.`, hint: `Learn it again to open a new supersession, or leave it: a proposed fact is never returned.` });
  }
  if (resumed === 0 && pendingFirst) {
    return envelope("awaiting_decision", diagnostics, { type: "human_decision", interruptId: pendingFirst.id, decisionKind: pendingFirst.kind as "approve_action", run: `legion-flow decide ${pendingFirst.id} --approve --approver <id>`, payloadRef: pendingFirst.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION });
  }
  return envelope(diagnostics.some((d) => d.severity === "error") ? "blocked" : "ok", diagnostics, { type: "command", run: "legion-flow status" });
}

/** Facts in a release's retro: gate verdicts, applied tasks, the review, evals, and usage, all read from records. */
export async function retroVerb(ws: Workspace, opts: { release?: string }, envelope: Envelope, held: HeldLock, now: () => Date): Promise<ResultEnvelope> {
  const releases = await ws.releases.list();
  if (releases.length === 0) return envelope("refused", [{ code: "no_release", severity: "error", message: "No release has been recorded; retro describes a release." }], { type: "command", run: "legion-flow status" });
  const release = opts.release ? releases.find((r) => r.id === opts.release) : [...releases].sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1)).at(-1);
  if (!release) return envelope("refused", [{ code: "release_unknown", severity: "error", message: `No release ${opts.release} (known: ${releases.map((r) => r.id).join(", ")}).` }], { type: "command", run: "legion-flow retro" });
  const existing = (await validEpisodes(ws)).find((e) => e.kind === "retro" && e.releaseId === release.id);
  if (existing) return envelope("ok", [{ code: "retro_exists", severity: "info", message: `Release ${release.id} already has its retro (${existing.id}); a retro is written once.`, path: join(ws.paths.episodesDir, `${existing.id}.json`) }], { type: "command", run: "legion-flow status" });

  const subject = `release:${release.id}`;
  const facts: Fact[] = [];
  const add = (predicate: string, object: Fact["object"]) => facts.push({ id: newId("fct"), subject, predicate, object, validAt: release.decidedAt, createdAt: now().toISOString(), origin: "deterministic" });
  add("decided_by", { text: release.decidedBy.id });
  const ship = await ws.runs.load(release.runId);
  for (const v of ship?.verdicts ?? []) add(`gate_${v.gateId}`, { text: `${v.status}${v.waiver ? " (waived)" : ""}` });

  const runs = await ws.runs.list();
  const plan = await ws.plans.current();
  const planMatches = plan?.kind === "valid" && plan.fingerprint === release.fingerprints.plan;
  let known = 0;
  let unknown = 0;
  let turns = 0;
  let costUsd = 0;
  if (planMatches) {
    for (const r of runs) {
      if (r.run.kind !== "workflow" || r.run.task?.planId !== plan.id || !r.run.applied) continue;
      add("task_applied", { ref: `task:${r.run.task.taskId}` });
      let names: string[] = [];
      try {
        names = await readdir(join(r.dir, "evidence"));
      } catch {
        continue;
      }
      for (const name of names) {
        const rec = JSON.parse(await readFile(join(r.dir, "evidence", name), "utf8").catch(() => "{}")) as { kind?: string; usage?: { known: boolean; turns?: number | null; costUsd?: number | null } };
        if (rec.kind !== "adapter_outcome") continue;
        if (rec.usage?.known) {
          known++;
          turns += rec.usage.turns ?? 0;
          costUsd += rec.usage.costUsd ?? 0;
        } else unknown++;
      }
    }
    add("usage", { text: known > 0 ? `${turns} turns, ${costUsd.toFixed(4)} USD across ${known} adapter run(s)${unknown ? `; unknown for ${unknown}` : ""}` : `unknown for ${unknown} adapter run(s)` });
  } else {
    add("tasks", { text: "unknown: the current plan is not the one this release shipped" });
  }
  const review = runs.flatMap((r) => (r.run.kind === "workflow" && r.run.review && r.run.review.fingerprints.plan === release.fingerprints.plan ? [r.run.review] : [])).at(-1);
  if (review) add("review_result", { text: review.verdict });
  for (const r of runs) {
    if (r.run.kind === "workflow" && r.run.eval && r.run.eval.fingerprints.plan === release.fingerprints.plan) add(`eval_${r.run.eval.datasetId.replace(/[^a-z0-9_]/g, "_")}`, { text: `${r.run.eval.passed ? "pass" : "fail"} v${r.run.eval.version}` });
  }
  const { episode } = await ws.episodes.record({ schema: SCHEMA_VERSIONS.EPISODE, kind: "retro", createdAt: now().toISOString(), releaseId: release.id, facts }, held);
  await syncFacts(ws, held);
  await ws.audit.append({ type: "retro_recorded", releaseId: release.id, episodeId: episode.id, facts: facts.length }, held);
  return envelope("ok", [{ code: "retro_recorded", severity: "info", message: `Recorded ${facts.length} deterministic fact(s) about ${release.id}.`, path: join(ws.paths.episodesDir, `${episode.id}.json`) }, ...facts.slice(0, 25).map((f) => ({ code: "fact", severity: "info" as const, message: describe(f) }))], { type: "command", run: "legion-flow status" });
}

export type { FactRow };

export interface RecallOptions {
  query?: string;
  subject?: string;
  predicate?: string;
  asOf?: string;
  knownAt?: string;
  budget?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;

/** `recall`: read-only; writes only its answer document under var/cache/recall/. */
export async function recallVerb(ws: Workspace, opts: RecallOptions, envelope: Envelope, statusNext: () => Promise<ResultEnvelope["nextAction"]>): Promise<ResultEnvelope> {
  const usage = (message: string) => envelope("usage_error", [{ code: "recall_usage", severity: "error", message }], { type: "command", run: 'legion-flow recall "<text>" [--subject <ref>] [--as-of <t>]' });
  if (!opts.query && !opts.subject) return usage("Recall needs text, --subject, or both.");
  if (opts.subject !== undefined && !/^(module|symbol|package|task|release|topic):/.test(opts.subject)) return usage("--subject is a typed reference (module:, symbol:, package:, task:, release:, topic:), optionally ending in / or # for a prefix.");
  if (opts.predicate !== undefined && !PredicateSchema.safeParse(opts.predicate).success) return usage("--predicate is a lowercase slug.");
  for (const [flag, v] of [["--as-of", opts.asOf], ["--known-at", opts.knownAt]] as const) if (v !== undefined && (!ISO.test(v) || Number.isNaN(Date.parse(v)))) return usage(`${flag} must be an ISO-8601 date or time (got '${v}').`);
  const budget = opts.budget === undefined ? undefined : Number(opts.budget);
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 50 || budget > 20000)) return usage("--budget is an integer number of estimated tokens per block, 50 to 20000.");
  const doc = await recall(ws, { ...(opts.query ? { text: opts.query } : {}), ...(opts.subject ? { subject: opts.subject } : {}), ...(opts.predicate ? { predicate: opts.predicate } : {}), ...(opts.asOf ? { asOf: opts.asOf } : {}), ...(opts.knownAt ? { knownAt: opts.knownAt } : {}), ...(budget ? { budget } : {}) });
  const bytes = JSON.stringify(doc, null, 2) + "\n";
  const dir = join(ws.paths.varDir, "cache", "recall");
  const path = join(dir, `recall-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(path, bytes);
  const diagnostics: Diagnostic[] = [
    { code: "recall_document", severity: "info", message: `Recall written (facts ${doc.factsIndexed ? "by BM25 over the index" : "by term count over the replay; the index is behind"}, map ${doc.mapFreshness}${doc.query.asOf ? `, as of ${doc.query.asOf}` : ""}${doc.query.knownAt ? `, as known at ${doc.query.knownAt}` : ""}).`, path },
  ];
  for (const b of doc.blocks) {
    diagnostics.push({ code: `recall_${b.source}`, severity: b.status === "ERROR" ? "warning" : "info", message: `${b.source}: ${b.status}, ${b.answer}${b.missing.length ? ` (missing: ${b.missing.join("; ")})` : ""}.` });
    for (const i of b.items.slice(0, 5)) diagnostics.push({ code: "recall_item", severity: "info", message: `[${b.source}] ${i.text}` });
  }
  return envelope("ok", diagnostics, await statusNext());
}
