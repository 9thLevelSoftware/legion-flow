import { NON_LIFECYCLE_WORKFLOW_IDS } from "@9thlevelsoftware/legion-flow-schema";
import { requiredGates, type Phase, type ProjectConfig } from "@9thlevelsoftware/legion-flow-schema";
import type { LegionFlowPaths } from "./layout.js";
import { loadSpec, type LoadSpecResult } from "./spec-store.js";
import { loadPlan } from "./plan-store.js";
import { findApprovals } from "./approval-store.js";
import { configFingerprint } from "./fingerprint.js";
import { listRuns, verifyRunEvidence, readInvalidations } from "./run-store.js";
import { listReleases } from "./release-store.js";
import { listReviewReceipts } from "./review-store.js";
import { listInterrupts, type LoadedInterrupt } from "./interrupt-store.js";

export interface PhaseReason {
  code: string;
  message: string;
}

export interface PhaseResult {
  phase: Phase;
  /** Why the phase is what it is when that is not obvious: an invalidated approval, a dangling pointer. */
  reasons: PhaseReason[];
  /** When the phase is awaiting_decision: the interrupt a human must resolve. */
  pendingInterrupt?: LoadedInterrupt;
}

type SpecPhase = PhaseResult & { frozenSpec?: Extract<LoadSpecResult, { kind: "valid" }> };

/**
 * Derive the lifecycle phase from what is on disk. The one home of the rule;
 * each milestone extends the body. The earlier gate always wins: a spec that is
 * no longer frozen drops the project back to spec_draft whatever the plan says,
 * because everything downstream was approved against something that changed.
 */
export async function derivePhase(paths: LegionFlowPaths, config: ProjectConfig, now: Date = new Date()): Promise<PhaseResult> {
  const specPhase = await deriveSpecPhase(paths, config);
  const planId = config.current?.planId;
  if (!planId) {
    return { phase: specPhase.phase, reasons: specPhase.reasons };
  }

  if (!specPhase.frozenSpec) {
    const plan = await loadPlan(paths, planId);
    const reasons = [...specPhase.reasons];
    if (plan.kind !== "absent") {
      reasons.push({ code: "plan_awaits_spec", message: `plan ${planId} cannot proceed until the spec is frozen again.` });
    }
    return { phase: specPhase.phase, reasons };
  }

  const spec = specPhase.frozenSpec;
  const plan = await loadPlan(paths, planId);
  if (plan.kind === "absent") {
    return {
      phase: "spec_frozen",
      reasons: [{ code: "current_plan_missing", message: `project.json points at plan ${planId}, but ${plan.dir} does not exist.` }],
    };
  }
  if (plan.kind === "invalid") {
    return {
      phase: "planning",
      reasons: [{ code: "plan_invalid", message: `plan ${planId} is ${plan.cause.replace("_", " ")}: ${plan.detail}` }],
    };
  }
  if (plan.plan.specFingerprint !== spec.fingerprint) {
    return {
      phase: "planning",
      reasons: [
        {
          code: "plan_spec_drift",
          message: `plan ${planId} was written against spec fingerprint ${plan.plan.specFingerprint}, but the frozen spec is now ${spec.fingerprint}; re-plan or update specFingerprint deliberately.`,
        },
      ],
    };
  }

  const receipts = await findApprovals(paths, "plan", planId);
  const config_ = configFingerprint(config);
  const match = receipts.find(
    (r) => r.fingerprints.plan === plan.fingerprint && r.fingerprints.spec === spec.fingerprint && r.fingerprints.config === config_
  );
  if (match) {
    return deriveShipPhase(paths, { spec: spec.fingerprint, plan: plan.fingerprint, config: config_ }, now, {
      planId: plan.id,
      taskIds: plan.plan.tasks.map((t) => t.id),
      reviewRequired: requiredGates(config.defaultRiskTier).includes("independent_review"),
    });
  }
  if (receipts.length > 0) {
    const last = receipts[receipts.length - 1]!;
    return {
      phase: "planning",
      reasons: [
        {
          code: "plan_approval_invalidated",
          message: `plan ${planId}, its spec, or the project config changed after approval ${last.id} (${last.decidedBy.id}, ${last.decidedAt}); it must be approved again.`,
        },
      ],
    };
  }
  return { phase: "planning", reasons: [] };
}

/**
 * From plan_ready upward. A release matching all three fingerprints is
 * shipped. Otherwise the latest complete ship run that evaluated these exact
 * fingerprints and found every required gate satisfied or waived makes the
 * project ready_to_ship, provided every evidence file it indexed still hashes
 * to what the index says. M1 skips executing and reviewing: nothing executes
 * until M2 and nothing reviews until M3.
 */
interface ReviewContext {
  planId: string;
  taskIds: string[];
  reviewRequired: boolean;
}

async function deriveShipPhase(
  paths: LegionFlowPaths,
  fingerprints: { spec: string; plan: string; config: string },
  now: Date,
  review: ReviewContext
): Promise<PhaseResult> {
  const same = (f: { spec: string; plan: string; config: string }) =>
    f.spec === fingerprints.spec && f.plan === fingerprints.plan && f.config === fingerprints.config;

  const releases = await listReleases(paths);
  if (releases.some((r) => same(r.fingerprints))) {
    return { phase: "shipped", reasons: [] };
  }

  const allRuns = await listRuns(paths);

  // An incomplete workflow run with a pending interrupt is a human decision waiting; that
  // state is more actionable than readiness and is reported first.
  const incompleteWorkflows = allRuns.flatMap((r) =>
    // Memory supersessions are decided apart from the lifecycle: status names them itself, and they never set the phase.
    r.run.kind === "workflow" && !NON_LIFECYCLE_WORKFLOW_IDS.includes(r.run.workflowId) && (r.run.status === "running" || r.run.status === "awaiting_decision") ? [r] : []
  );
  const reasons: PhaseReason[] = [];
  for (const loaded of incompleteWorkflows) {
    const run = loaded.run;
    if (run.kind !== "workflow") continue;
    const interrupts = await listInterrupts(paths, loaded.run.id, now);
    const pending = interrupts.find((i) => i.effectiveStatus === "pending");
    if (pending) {
      return { phase: "awaiting_decision", reasons: [], pendingInterrupt: pending };
    }
    if (interrupts.some((i) => i.effectiveStatus === "expired" && !i.interrupt.consumedAt)) {
      reasons.push({ code: "interrupt_expired", message: `run ${loaded.run.id} has an expired interrupt; resuming it applies its onTimeout.` });
    } else if (run.task) {
      // A task run that is running with no human waiting is the project executing.
      return {
        phase: "executing",
        reasons: [{ code: "execution_in_progress", message: `run ${loaded.run.id} is executing task ${run.task.taskId}; re-enter it with execute --resume if it was interrupted.` }],
      };
    } else {
      reasons.push({ code: "run_incomplete", message: `run ${loaded.run.id} (${loaded.run.status}) has not finished; resume or abandon it.` });
    }
  }

  /**
   * reviewing: every plan task applied, the tier requires independent_review, and no receipt
   * matches the current fingerprints and the tree the last apply produced. Checked only where
   * the answer would otherwise be plan_ready, so a ship evaluation made ready by a waiver stands.
   */
  const receipts = await listReviewReceipts(paths);
  const planReadyOrReviewing = (extra: PhaseReason[]): PhaseResult => {
    if (!review.reviewRequired || review.taskIds.length === 0) return { phase: "plan_ready", reasons: extra };
    const applied = allRuns.flatMap((r) => (r.run.kind === "workflow" && r.run.task?.planId === review.planId && r.run.applied ? [{ taskId: r.run.task.taskId, applied: r.run.applied }] : []));
    if (!review.taskIds.every((id) => applied.some((a) => a.taskId === id))) return { phase: "plan_ready", reasons: extra };
    applied.sort((a, b) => a.applied.appliedAt.localeCompare(b.applied.appliedAt));
    const lastApplied = applied[applied.length - 1]!;
    const accepted = receipts.some((r) => same(r.fingerprints) && r.sourceFingerprint === lastApplied.applied.sourceFingerprint);
    if (accepted) return { phase: "plan_ready", reasons: extra };
    const reviewRuns = allRuns.flatMap((r) => (r.run.kind === "workflow" && r.run.workflowId === "review" ? [r.run] : []));
    const current = reviewRuns.filter((r) => r.review && same(r.review.fingerprints) && r.review.sourceFingerprint === lastApplied.applied.sourceFingerprint);
    const last = current[current.length - 1];
    const why: PhaseReason = !last
      ? { code: "review_required", message: "every task is applied and this tier requires an independent review; run legion-flow review." }
      : last.review!.verdict === "PASS"
        ? { code: "review_awaiting_acceptance", message: `review run ${last.id} passed; a decision owner accepts it with legion-flow review --accept --approver <id>.` }
        : { code: "review_failed", message: `review run ${last.id} failed: ${last.review!.reason}` };
    return { phase: "reviewing", reasons: [...extra, why] };
  };

  const shipRuns = allRuns.flatMap((r) => (r.run.kind === "ship" && r.run.status === "complete" ? [{ loaded: r, run: r.run }] : []));
  const latest = shipRuns[shipRuns.length - 1];
  if (!latest || !same(latest.run.fingerprints)) {
    return planReadyOrReviewing(reasons);
  }
  // An edited fork of an applied task run invalidates ship evaluations made between that apply and the fork.
  for (const r of allRuns) {
    if (r.run.kind !== "workflow" || !r.run.applied) continue;
    const appliedAt = Date.parse(r.run.applied.appliedAt);
    for (const inv of await readInvalidations(paths, r.run.id)) {
      if (!inv.edited) continue;
      const started = Date.parse(latest.run.startedAt);
      if (started > appliedAt && started < Date.parse(inv.at)) {
        return planReadyOrReviewing([...reasons, { code: "fork_invalidated", message: `ship evaluation ${latest.run.id} was made before run ${r.run.id} was forked with edited values (${inv.forkedTo}); evaluate again.` }]);
      }
    }
  }
  if (!latest.run.ready) {
    return planReadyOrReviewing([...reasons, { code: "ship_blocked", message: `the latest ship evaluation (${latest.run.id}) found a required gate neither satisfied nor waived.` }]);
  }
  const evidence = await verifyRunEvidence(paths, latest.loaded);
  if (!evidence.ok) {
    return planReadyOrReviewing([
      ...reasons,
      {
        code: "ship_evidence_drift",
        message: `evidence from ship run ${latest.run.id} no longer matches its index (${evidence.drifted.length} drifted, ${evidence.missing.length} missing); evaluate again.`,
      },
    ]);
  }
  return { phase: "ready_to_ship", reasons };
}

async function deriveSpecPhase(paths: LegionFlowPaths, config: ProjectConfig): Promise<SpecPhase> {
  const specId = config.current?.specId;
  if (!specId) {
    return { phase: "initialized", reasons: [] };
  }

  const spec = await loadSpec(paths, specId);
  if (spec.kind === "absent") {
    return {
      phase: "initialized",
      reasons: [{ code: "current_spec_missing", message: `project.json points at spec ${specId}, but ${spec.dir} does not exist.` }],
    };
  }
  if (spec.kind === "invalid") {
    return {
      phase: "spec_draft",
      reasons: [{ code: "spec_invalid", message: `spec ${specId} is ${spec.cause.replace("_", " ")}: ${spec.detail}` }],
    };
  }

  const receipts = await findApprovals(paths, "spec", specId);
  const config_ = configFingerprint(config);
  const match = receipts.find((r) => r.fingerprints.spec === spec.fingerprint && r.fingerprints.config === config_);
  if (match) {
    return { phase: "spec_frozen", reasons: [], frozenSpec: spec };
  }
  if (receipts.length > 0) {
    const last = receipts[receipts.length - 1]!;
    return {
      phase: "spec_draft",
      reasons: [
        {
          code: "spec_approval_invalidated",
          message: `spec ${specId} or the project config changed after approval ${last.id} (${last.decidedBy.id}, ${last.decidedAt}); it must be approved again.`,
        },
      ],
    };
  }
  return { phase: "spec_draft", reasons: [] };
}
