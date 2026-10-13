import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEMA_VERSIONS,
  type Approval,
  type EvidenceIndexEntry,
  type GateStatus,
  type GateVerdict,
  type RiskTier,
} from "@9thlevelsoftware/legion-flow-schema";
import {
  configFingerprint,
  fingerprintTree,
  detectTreeMode,
  projectRelative,
  sha256Hex,
  validatePlanAgainstSpec,
  type HeldLock,
  type LoadPlanResult,
  type LoadProjectResult,
  type LoadSpecResult,
  type Workspace,
} from "@9thlevelsoftware/legion-flow-persist";
import { GATE_CATALOG, requiredGates } from "./catalog.js";
import { checkArchitecture, rulesOf } from "@9thlevelsoftware/legion-flow-memory";
import { runCheck, type RunCheckOptions } from "./checks.js";

export interface WaiverInput {
  gateId: string;
  reason: string;
  waivedBy: string;
}

export interface ShipEvaluationOptions {
  tier?: RiskTier;
  waivers?: WaiverInput[];
  timeoutMs?: number;
  /** Test seam passed through to the check runner. */
  resolveWindowsCommand?: RunCheckOptions["resolveWindowsCommand"];
}

export interface ShipEvaluation {
  runId: string;
  runDir: string;
  tier: RiskTier;
  required: readonly string[];
  verdicts: GateVerdict[];
  /** Every required gate satisfied or waived. */
  ready: boolean;
  /** Waivers supplied for gates that were satisfied anyway, or not required at this tier. */
  unusedWaivers: WaiverInput[];
  fingerprints: { spec: string; plan: string; config: string };
}

export type ShipEvaluationResult =
  | { kind: "evaluated"; evaluation: ShipEvaluation }
  | { kind: "nothing_to_ship"; code: string; message: string };

interface GateContext {
  ws: Workspace;
  project: Extract<LoadProjectResult, { kind: "valid" }>;
  spec: Extract<LoadSpecResult, { kind: "valid" }>;
  plan: Extract<LoadPlanResult, { kind: "valid" }>;
  specReceipt: Approval | undefined;
  planReceipt: Approval | undefined;
  tier: RiskTier;
  runId: string;
  held: HeldLock;
  timeoutMs?: number;
  resolveWindowsCommand?: RunCheckOptions["resolveWindowsCommand"];
  evidenceIndex: EvidenceIndexEntry[];
  /** The whole-tree fingerprint, once a gate computed it; recorded on every verdict's inputs. */
  sourceFingerprint?: string;
}

interface GateOutcome {
  status: GateStatus;
  reason: string;
  evidence: { path: string; sha256: string }[];
  acceptanceIds: string[];
  /** The reviewer or judge the gate relied on, for the verdict's judge field. */
  judge?: GateVerdict["judge"];
  /** `<datasetId>@v<N>` pairs, for the verdict's inputs. */
  goldenDatasetVersion?: string;
}

async function fileEvidence(ctx: GateContext, absolutePath: string): Promise<{ path: string; sha256: string }> {
  const sha256 = sha256Hex(await readFile(absolutePath));
  return { path: projectRelative(ctx.ws.paths, absolutePath), sha256 };
}

const allAcceptanceIds = (ctx: GateContext) => ctx.spec.spec.acceptanceCriteria.map((c) => c.id);

const evaluators: Record<string, (ctx: GateContext) => Promise<GateOutcome>> = {
  /**
   * The rules judge the indexed map, and only a fresh one: a map that does not
   * describe the checkout cannot vouch for it. The gate never builds the map;
   * `legion-flow map` (or execute and review, which refresh it) does.
   */
  async architecture_conformance(ctx) {
    const rules = rulesOf(ctx.project.config);
    if (!rules) return { status: "unevaluable", reason: "the project declares no map.rules", evidence: [], acceptanceIds: [] };
    const check = await checkArchitecture(ctx.ws, rules, { requireFresh: true });
    if (check.kind === "not_fresh") {
      return { status: "unevaluable", reason: `the code map is ${check.status.freshness}${check.status.reason ? ` (${check.status.reason})` : ""}; run legion-flow map`, evidence: [], acceptanceIds: [] };
    }
    const record = { kind: "architecture_conformance", rulesSha256: check.rulesSha256, snapshotId: check.snapshotId, factsSha256: check.factsSha256, violations: check.violations };
    const written = await ctx.ws.runs.writeEvidence(ctx.runId, record, ctx.held);
    ctx.evidenceIndex.push({ path: written.path, sha256: written.sha256, producedBy: "architecture_conformance" });
    const evidence = [{ path: written.path, sha256: written.sha256 }];
    if (check.violations.length > 0) {
      const first = check.violations.slice(0, 3).map((v) => `${v.rule} ${v.from}${v.to ? ` -> ${v.to}` : v.specifier ? ` -> ${v.specifier}` : ""}`).join("; ");
      return { status: "unsatisfied", reason: `${check.violations.length} rule violation(s) in map snapshot ${check.snapshotId}: ${first}${check.violations.length > 3 ? "; ..." : ""}`, evidence, acceptanceIds: [] };
    }
    return { status: "satisfied", reason: `map snapshot ${check.snapshotId} breaks none of the rules (${check.rulesSha256.slice(0, 12)})`, evidence, acceptanceIds: [] };
  },
  async approved_spec(ctx) {
    if (!ctx.specReceipt) {
      return { status: "unsatisfied", reason: "no approval receipt matches the current spec and config fingerprints", evidence: [], acceptanceIds: allAcceptanceIds(ctx) };
    }
    const ev = await fileEvidence(ctx, join(ctx.ws.paths.approvalsDir, `${ctx.specReceipt.id}.json`));
    return { status: "satisfied", reason: `receipt ${ctx.specReceipt.id} by ${ctx.specReceipt.decidedBy.id} matches`, evidence: [ev], acceptanceIds: allAcceptanceIds(ctx) };
  },

  async approved_plan(ctx) {
    if (!ctx.planReceipt) {
      return { status: "unsatisfied", reason: "no approval receipt matches the current plan, spec, and config fingerprints", evidence: [], acceptanceIds: [] };
    }
    const ev = await fileEvidence(ctx, join(ctx.ws.paths.approvalsDir, `${ctx.planReceipt.id}.json`));
    return { status: "satisfied", reason: `receipt ${ctx.planReceipt.id} by ${ctx.planReceipt.decidedBy.id} matches, ${ctx.planReceipt.checks?.length ?? 0} receipt checks`, evidence: [ev], acceptanceIds: [] };
  },

  async acceptance_coverage(ctx) {
    const validation = validatePlanAgainstSpec(ctx.plan.plan, ctx.spec.spec);
    const uncovered = validation.warnings.find((w) => w.code === "plan_uncovered_criteria");
    const covered = new Set(ctx.plan.plan.tasks.flatMap((t) => t.acceptanceIds));
    if (uncovered) {
      return { status: "unsatisfied", reason: uncovered.message, evidence: [], acceptanceIds: allAcceptanceIds(ctx).filter((id) => !covered.has(id)) };
    }
    if (ctx.plan.plan.tasks.length === 0) {
      return { status: "unsatisfied", reason: "the plan has no tasks", evidence: [], acceptanceIds: allAcceptanceIds(ctx) };
    }
    return { status: "satisfied", reason: `all ${allAcceptanceIds(ctx).length} criteria covered`, evidence: [], acceptanceIds: allAcceptanceIds(ctx) };
  },

  async deterministic_verification(ctx) {
    if (!ctx.planReceipt) {
      return { status: "unevaluable", reason: "the plan is not approved, so the receipt checks are unknown", evidence: [], acceptanceIds: [] };
    }
    // The same-tree rule: once a task run applied a proposal, the checks are
    // meaningful only on the tree that apply produced. A checkout that has
    // drifted since is unevaluable, never a pass.
    const appliedRuns = (await ctx.ws.runs.list())
      .flatMap((r) => (r.run.kind === "workflow" && r.run.task?.planId === ctx.plan.id && r.run.applied ? [{ loaded: r, applied: r.run.applied }] : []))
      .sort((a, b) => a.applied.appliedAt.localeCompare(b.applied.appliedAt));
    const newest = appliedRuns[appliedRuns.length - 1];
    const mode = newest ? await detectTreeMode(ctx.ws.root) : "fs";
    const current = newest ? await fingerprintTree(ctx.ws.root, { mode }) : null;
    // Applies in one execute --jobs batch can share a timestamp; among the newest, the one that produced the checkout is the last.
    const tied = newest ? appliedRuns.filter((r) => r.applied.appliedAt === newest.applied.appliedAt) : [];
    const latest = tied.find((r) => r.applied.sourceFingerprint === current?.fingerprint) ?? newest;
    if (latest && current) {
      ctx.sourceFingerprint = current.fingerprint;
      if (current.fingerprint !== latest.applied.sourceFingerprint) {
        return {
          status: "unevaluable",
          reason: `the checkout (${current.fingerprint}, ${mode} listing) is not the tree the last applied proposal produced (${latest.applied.sourceFingerprint}); checks would not verify what was proposed`,
          evidence: [],
          acceptanceIds: [],
        };
      }
      // The run's own evidence (proposal, adapter outcome, span records) is re-hashed at read time: the family rule, now load-bearing.
      const verification = await ctx.ws.runs.verifyEvidence(latest.loaded);
      if (!verification.ok) {
        return {
          status: "unevaluable",
          reason: `evidence of the applied task run ${latest.loaded.run.id} no longer matches its index: ${[...verification.drifted.map((p) => `drifted ${p}`), ...verification.missing.map((p) => `missing ${p}`)].join("; ")}`,
          evidence: [],
          acceptanceIds: [],
        };
      }
    }
    const checks: { check: string; source: "task" | "receipt"; taskId?: string }[] = [];
    for (const task of ctx.plan.plan.tasks) {
      for (const check of task.contract.verificationCommands) checks.push({ check, source: "task", taskId: task.id });
    }
    for (const check of ctx.planReceipt.checks ?? []) checks.push({ check, source: "receipt" });
    if (checks.length === 0) {
      return { status: "unevaluable", reason: "no checks declared on any task or on the receipt", evidence: [], acceptanceIds: [] };
    }

    const evidence: { path: string; sha256: string }[] = [];
    const outcomes: { check: string; status: GateStatus; reason: string }[] = [];
    for (const c of checks) {
      const outcome = await runCheck(c.check, {
        cwd: ctx.ws.root,
        source: c.source,
        taskId: c.taskId,
        timeoutMs: ctx.timeoutMs,
        resolveWindowsCommand: ctx.resolveWindowsCommand,
        ...(ctx.planReceipt.browserScripts ? { browserScripts: ctx.planReceipt.browserScripts } : {}),
      });
      const written = await ctx.ws.runs.writeEvidence(ctx.runId, outcome.evidence, ctx.held);
      evidence.push({ path: written.path, sha256: written.sha256 });
      ctx.evidenceIndex.push({ path: written.path, sha256: written.sha256, producedBy: "deterministic_verification" });
      outcomes.push({ check: c.check, status: outcome.status, reason: outcome.reason });
    }

    const acceptanceIds = [...new Set(ctx.plan.plan.tasks.flatMap((t) => t.acceptanceIds))];
    const unevaluable = outcomes.filter((o) => o.status === "unevaluable");
    if (unevaluable.length > 0) {
      return { status: "unevaluable", reason: unevaluable.map((o) => `"${o.check}": ${o.reason}`).join("; "), evidence, acceptanceIds };
    }
    const failed = outcomes.filter((o) => o.status === "unsatisfied");
    if (failed.length > 0) {
      return { status: "unsatisfied", reason: failed.map((o) => `"${o.check}": ${o.reason}`).join("; "), evidence, acceptanceIds };
    }
    return { status: "satisfied", reason: `${outcomes.length} check(s) exited 0`, evidence, acceptanceIds };
  },

  /**
   * The latest complete review run at the current spec, plan, and config
   * fingerprints and the current checkout decides: none is unevaluable, FAIL is
   * unsatisfied, a reviewer equal to the executor is unsatisfied (only a ship
   * waiver can carry it; a waiver never changes a verdict), PASS without a
   * receipt is unsatisfied, and a matching receipt is satisfied.
   */
  async independent_review(ctx) {
    const fp = { spec: ctx.spec.fingerprint, plan: ctx.plan.fingerprint, config: configFingerprint(ctx.project.config) };
    if (!ctx.sourceFingerprint) {
      const mode = await detectTreeMode(ctx.ws.root);
      ctx.sourceFingerprint = (await fingerprintTree(ctx.ws.root, { mode })).fingerprint;
    }
    const source = ctx.sourceFingerprint;
    const same = (f: { spec: string; plan: string; config: string }) => f.spec === fp.spec && f.plan === fp.plan && f.config === fp.config;
    const runs = (await ctx.ws.runs.list()).flatMap((r) =>
      r.run.kind === "workflow" && r.run.workflowId === "review" && r.run.status === "complete" && r.run.review && same(r.run.review.fingerprints) && r.run.review.sourceFingerprint === source
        ? [{ dir: r.dir, id: r.run.id, review: r.run.review }]
        : []
    );
    const latest = runs[runs.length - 1];
    const acceptanceIds = allAcceptanceIds(ctx);
    if (!latest) {
      return { status: "unevaluable", reason: "no review run exists for the current spec, plan, config, and checkout; run legion-flow review", evidence: [], acceptanceIds };
    }
    const r = latest.review;
    const judge = { model: `${r.reviewer.adapter}:${r.reviewer.model}`, role: "judge" as const, distinctFromExecutor: r.independent };
    if (r.verdict === "FAIL") return { status: "unsatisfied", reason: `review run ${latest.id} failed: ${r.reason}`, evidence: [], acceptanceIds, judge };
    if (!r.independent) {
      return { status: "unsatisfied", reason: `review run ${latest.id} was made by the executor itself (${judge.model}) under a review-time waiver; only a ship waiver can carry this gate`, evidence: [], acceptanceIds, judge };
    }
    const receipt = (await ctx.ws.reviews.list()).find((x) => x.runId === latest.id && same(x.fingerprints) && x.sourceFingerprint === source);
    if (!receipt) return { status: "unsatisfied", reason: `review run ${latest.id} passed and awaits acceptance: legion-flow review --accept --approver <id>`, evidence: [], acceptanceIds, judge };
    const ev = await fileEvidence(ctx, join(ctx.ws.paths.reviewsDir, `${receipt.id}.json`));
    return { status: "satisfied", reason: `review run ${latest.id} by ${judge.model} passed and was accepted by ${receipt.decidedBy.id} (${receipt.id})`, evidence: [ev], acceptanceIds, judge };
  },

  /**
   * Every golden dataset's latest unarchived version has a latest eval run at
   * the current spec, plan, config, checkout, and dataset fingerprint; every
   * such run passed with a judge distinct from the executor; and the datasets
   * cover every criterion of kind test or rubric. One score sidecar per run is
   * written into this ship run as evidence of the verdict.
   */
  async eval_goldens(ctx) {
    const fp = { spec: ctx.spec.fingerprint, plan: ctx.plan.fingerprint, config: configFingerprint(ctx.project.config) };
    if (!ctx.sourceFingerprint) {
      const mode = await detectTreeMode(ctx.ws.root);
      ctx.sourceFingerprint = (await fingerprintTree(ctx.ws.root, { mode })).fingerprint;
    }
    const source = ctx.sourceFingerprint;
    const acceptanceIds = allAcceptanceIds(ctx);
    const listings = await ctx.ws.datasets.list();
    // The newest file that is not archived decides; if it cannot be read, the gate cannot judge, and says so.
    const unreadable = listings.flatMap((d) => {
      const live = d.versions.filter((v) => v.kind === "invalid" || !v.dataset.archived);
      const newest = live[live.length - 1];
      return newest && newest.kind === "invalid" ? [`${d.id}@v${newest.version}: ${newest.detail}`] : [];
    });
    if (unreadable.length > 0) return { status: "unevaluable", reason: `golden dataset version(s) cannot be read: ${unreadable.join("; ")}`, evidence: [], acceptanceIds };
    const datasets = listings.flatMap((d) => {
      const live = d.versions.filter((v) => v.kind === "valid" && !v.dataset.archived);
      const latest = live[live.length - 1];
      return latest && latest.kind === "valid" ? [{ id: d.id, version: latest.version, fingerprint: latest.fingerprint }] : [];
    });
    if (datasets.length === 0) return { status: "unevaluable", reason: "no golden dataset exists; create one with legion-flow eval --new <id>", evidence: [], acceptanceIds };
    const runs = await ctx.ws.runs.list();
    const used: { id: string; dir: string; result: NonNullable<Extract<(typeof runs)[number]["run"], { kind: "workflow" }>["eval"]> }[] = [];
    const missing: string[] = [];
    for (const d of datasets) {
      const candidates = runs.flatMap((r) =>
        r.run.kind === "workflow" && r.run.workflowId === "eval" && r.run.status === "complete" && r.run.eval &&
        r.run.eval.datasetId === d.id && r.run.eval.version === d.version && r.run.eval.datasetFingerprint === d.fingerprint &&
        r.run.eval.fingerprints.spec === fp.spec && r.run.eval.fingerprints.plan === fp.plan && r.run.eval.fingerprints.config === fp.config &&
        r.run.eval.sourceFingerprint === source
          ? [{ id: r.run.id, dir: r.dir, result: r.run.eval }]
          : []
      );
      const latest = candidates[candidates.length - 1];
      if (latest) used.push(latest);
      else missing.push(`${d.id}@v${d.version}`);
    }
    const goldenDatasetVersion = datasets.map((d) => `${d.id}@v${d.version}`).join(",");
    const judges = [...new Set(used.flatMap((u) => (u.result.judge ? [u.result.judge] : [])))];
    const judge = judges.length > 0 ? { model: judges.join(","), role: "judge" as const, distinctFromExecutor: used.every((u) => u.result.distinctFromExecutor) } : undefined;

    const evidence: { path: string; sha256: string }[] = [];
    for (const u of used) {
      const sidecar = {
        kind: "score_sidecar",
        evalRunId: u.id,
        datasetId: u.result.datasetId,
        version: u.result.version,
        entries: u.result.cases.flatMap((c) =>
          c.metrics.map((m) => ({ caseId: c.id, metric: m.metric, score: m.mean, threshold: m.threshold, failed: m.status !== "pass", explanation: m.reasons.join(" | "), scorer: m.scorer, prompt_hash: m.promptHashes.find((h) => h !== null) ?? null }))
        ),
      };
      const written = await ctx.ws.runs.writeEvidence(ctx.runId, sidecar, ctx.held);
      evidence.push({ path: written.path, sha256: written.sha256 });
      ctx.evidenceIndex.push({ path: written.path, sha256: written.sha256, producedBy: "eval_goldens" });
    }
    const base = { evidence, acceptanceIds, goldenDatasetVersion, ...(judge ? { judge } : {}) };
    if (missing.length > 0) return { status: "unevaluable", reason: `no eval run at the current fingerprints and checkout for: ${missing.join(", ")}`, ...base };
    const unevaluable = used.filter((u) => u.result.unevaluable);
    if (unevaluable.length > 0) return { status: "unevaluable", reason: unevaluable.map((u) => `${u.result.datasetId}: ${u.result.reason}`).join("; "), ...base };
    const failed = used.filter((u) => !u.result.passed);
    if (failed.length > 0) return { status: "unsatisfied", reason: failed.map((u) => `${u.result.datasetId}@v${u.result.version}: ${u.result.reason}`).join("; "), ...base };
    if (judge && !judge.distinctFromExecutor) return { status: "unsatisfied", reason: `the judge (${judge.model}) equals the executor under an eval-time waiver; only a ship waiver can carry this gate`, ...base };
    const toCover = ctx.spec.spec.acceptanceCriteria.filter((c) => c.kind === "test" || c.kind === "rubric").map((c) => c.id);
    const covered = new Set(used.flatMap((u) => u.result.acceptanceIds));
    const uncovered = toCover.filter((id) => !covered.has(id));
    if (uncovered.length > 0) return { status: "unsatisfied", reason: `the datasets do not cover criteria of kind test or rubric: ${uncovered.join(", ")}`, ...base };
    return { status: "satisfied", reason: `${used.length} dataset(s) passed (${goldenDatasetVersion}); ${toCover.length} criteria of kind test or rubric to cover, all covered`, ...base };
  },

  async audit_chain_intact(ctx) {
    const result = await ctx.ws.audit.verify();
    if (!result.valid) {
      return { status: "unsatisfied", reason: `audit chain verification failed: ${result.error}`, evidence: [], acceptanceIds: [] };
    }
    // An empty chain has no index file yet; that is valid and leaves no evidence file to cite.
    const evidence: { path: string; sha256: string }[] = [];
    try {
      evidence.push(await fileEvidence(ctx, ctx.ws.paths.chainJson));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return {
      status: "satisfied",
      reason: `${result.verifiedCount} events intact${result.unindexedTail ? " (one committed event not yet indexed)" : ""}`,
      evidence,
      acceptanceIds: [],
    };
  },
};

/**
 * Evaluate every gate the tier requires, writing evidence and verdicts into a
 * fresh ship run under the held lock. A waiver never changes a verdict's
 * status; it is recorded on the verdict and counts toward readiness.
 */
export async function evaluateShip(ws: Workspace, held: HeldLock, options: ShipEvaluationOptions = {}): Promise<ShipEvaluationResult> {
  const project = await ws.project.load();
  if (project.kind !== "valid") {
    return { kind: "nothing_to_ship", code: "project_unusable", message: "No valid project to evaluate." };
  }
  const spec = await ws.specs.current();
  if (!spec || spec.kind !== "valid") {
    return { kind: "nothing_to_ship", code: "no_current_spec", message: "There is no valid current spec; nothing to ship." };
  }
  const plan = await ws.plans.current();
  if (!plan || plan.kind !== "valid") {
    return { kind: "nothing_to_ship", code: "no_current_plan", message: "There is no valid current plan; a ship evaluation needs one to bind its verdicts to." };
  }

  const tier = options.tier ?? project.config.defaultRiskTier;
  const required = requiredGates(tier, { architectureRules: Boolean(rulesOf(project.config)) });
  const fingerprints = { spec: spec.fingerprint, plan: plan.fingerprint, config: configFingerprint(project.config) };

  const specReceipt = (await ws.approvals.forSubject("spec", spec.id)).find(
    (r) => r.fingerprints.spec === fingerprints.spec && r.fingerprints.config === fingerprints.config
  );
  const planReceipt = (await ws.approvals.forSubject("plan", plan.id)).find(
    (r) => r.fingerprints.plan === fingerprints.plan && r.fingerprints.spec === fingerprints.spec && r.fingerprints.config === fingerprints.config
  );

  const { run, dir } = await ws.runs.create({ kind: "ship", riskTier: tier, fingerprints, requiredGates: [...required] }, held);
  const ctx: GateContext = {
    ws,
    project,
    spec,
    plan,
    specReceipt,
    planReceipt,
    tier,
    runId: run.id,
    held,
    timeoutMs: options.timeoutMs,
    resolveWindowsCommand: options.resolveWindowsCommand,
    evidenceIndex: [],
  };

  const waivers = options.waivers ?? [];
  const usedWaivers = new Set<WaiverInput>();
  const verdicts: GateVerdict[] = [];
  let ready = true;

  for (const gateId of required) {
    const definition = GATE_CATALOG.find((g) => g.id === gateId)!;
    const evaluator = evaluators[gateId];
    const outcome: GateOutcome = evaluator
      ? await evaluator(ctx)
      : { status: "unevaluable", reason: `${definition.title}: evidence for this gate arrives in ${definition.evaluableFrom}`, evidence: [], acceptanceIds: [] };

    const waiver = outcome.status === "satisfied" ? undefined : waivers.find((w) => w.gateId === gateId);
    if (waiver) usedWaivers.add(waiver);

    const verdict: GateVerdict = {
      schema: SCHEMA_VERSIONS.GATE_VERDICT,
      gateId,
      riskTier: tier,
      acceptanceIds: outcome.acceptanceIds,
      status: outcome.status,
      reason: outcome.reason,
      evidence: outcome.evidence,
      judge: outcome.judge ?? null,
      inputs: {
        specFingerprint: fingerprints.spec,
        planFingerprint: fingerprints.plan,
        ...(ctx.sourceFingerprint ? { sourceFingerprint: ctx.sourceFingerprint } : {}),
        ...(outcome.goldenDatasetVersion ? { goldenDatasetVersion: outcome.goldenDatasetVersion } : {}),
      },
      evaluatedAt: new Date().toISOString(),
      waiver: waiver ? { reason: waiver.reason, waivedBy: waiver.waivedBy, waivedAt: new Date().toISOString() } : null,
    };
    const verdictPath = await ws.runs.writeVerdict(run.id, verdict, held);
    const verdictBytes = await readFile(join(ws.paths.project, ...verdictPath.split("/")));
    ctx.evidenceIndex.push({ path: verdictPath, sha256: sha256Hex(verdictBytes), producedBy: gateId });
    verdicts.push(verdict);
    if (outcome.status !== "satisfied" && !waiver) ready = false;
  }

  await ws.runs.writeIndex(run.id, ctx.evidenceIndex, held);
  await ws.runs.complete(run.id, ready, held);

  return {
    kind: "evaluated",
    evaluation: {
      runId: run.id,
      runDir: dir,
      tier,
      required,
      verdicts,
      ready,
      unusedWaivers: waivers.filter((w) => !usedWaivers.has(w)),
      fingerprints,
    },
  };
}
