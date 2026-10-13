import type { Approval, ApprovalSubject, Episode } from "@9thlevelsoftware/legion-flow-schema";
import { AuditChain } from "./audit.js";
import { ProcessLock, HeldLock } from "./lock.js";
import { getLegionFlowPaths, type LegionFlowPaths } from "./layout.js";
import {
  loadProject,
  createProject,
  setCurrent,
  type LoadProjectResult,
  type CreateProjectInput,
  type CreateProjectResult,
  type CurrentPointer,
} from "./project-store.js";
import { loadSpec, createSpec, type LoadSpecResult, type CreatedSpec } from "./spec-store.js";
import { loadPlan, createPlan, type LoadPlanResult, type CreatedPlan } from "./plan-store.js";
import { listEpisodes, recordEpisode, type EpisodeDraft, type LoadedEpisode } from "./episode-store.js";
import { findApprovals, listApprovals, recordApproval, type ApprovalListing } from "./approval-store.js";
import {
  createRun,
  completeRun,
  finishRun,
  recordApplied,
  recordReviewResult,
  recordEvalResult,
  writeEvidence,
  writeVerdict,
  writeEvidenceIndex,
  writeSnapshot,
  loadSnapshot,
  loadLatestSnapshot,
  writeJournalEntry,
  readJournal,
  appendEffect,
  readEffects,
  writeInvalidation,
  readInvalidations,
  loadRun,
  listRuns,
  verifyRunEvidence,
  type CreateRunInput,
  type WrittenEvidence,
  type LoadedRun,
  type EvidenceVerification,
  type JournalEntry,
  type EffectLine,
} from "./run-store.js";
import { listReleases, recordRelease } from "./release-store.js";
import { listReviewReceipts, recordReviewReceipt } from "./review-store.js";
import { listConsents, recordConsent } from "./consent-store.js";
import { listDatasets, createDataset, type DatasetListing } from "./dataset-store.js";
import {
  writeInterrupt,
  updateInterrupt,
  writeDecision,
  loadInterrupt,
  listInterrupts,
  findInterrupt,
  type LoadedInterrupt,
} from "./interrupt-store.js";
import type {
  Run,
  ShipRun,
  WorkflowRun,
  GateVerdict,
  EvidenceIndexEntry,
  Release,
  StepSnapshot,
  Interrupt,
  Decision,
  Invalidation,
  ReviewReceipt,
} from "@9thlevelsoftware/legion-flow-schema";

export interface ProjectAccess {
  /** Absent, invalid with a cause, or valid with the derived phase. Never throws for an expected state. `now` drives interrupt expiry. */
  load(now?: Date): Promise<LoadProjectResult>;
  /** Requires the HeldLock of this workspace's engine lock; never overwrites an existing record. */
  create(input: CreateProjectInput, held: HeldLock): Promise<CreateProjectResult>;
  /** Move the `current` pointer, the record's one mutable part. */
  setCurrent(patch: Partial<CurrentPointer>, held: HeldLock): Promise<LoadProjectResult>;
}

export interface SpecAccess {
  load(id: string): Promise<LoadSpecResult>;
  /** The project's current spec, or null when the project is not valid or points at none. */
  current(): Promise<LoadSpecResult | null>;
  create(title: string, held: HeldLock): Promise<CreatedSpec>;
}

export interface PlanAccess {
  load(id: string): Promise<LoadPlanResult>;
  /** The project's current plan, or null when the project is not valid or points at none. */
  current(): Promise<LoadPlanResult | null>;
  /** An empty draft against a frozen spec; the caller checks the phase first. */
  create(spec: { id: string; fingerprint: string }, held: HeldLock): Promise<CreatedPlan>;
}

export interface ApprovalAccess {
  list(): Promise<ApprovalListing>;
  forSubject(subject: ApprovalSubject, subjectId: string): Promise<Approval[]>;
  record(receipt: Approval, held: HeldLock): Promise<string>;
}

export interface RunAccess {
  list(): Promise<LoadedRun[]>;
  load(id: string): Promise<LoadedRun | null>;
  create(input: CreateRunInput, held: HeldLock): Promise<{ run: Run; dir: string }>;
  /** Ship runs only. */
  complete(runId: string, ready: boolean, held: HeldLock): Promise<ShipRun>;
  /** Workflow runs only: a terminal status or awaiting_decision. */
  finish(runId: string, patch: { status: WorkflowRun["status"]; reason?: string }, held: HeldLock): Promise<WorkflowRun>;
  /** Workflow runs only: the task's proposal reached the real checkout. */
  recordApplied(runId: string, applied: NonNullable<WorkflowRun["applied"]>, held: HeldLock): Promise<WorkflowRun>;
  /** Review runs only: the verdict the review reached. */
  recordReview(runId: string, review: NonNullable<WorkflowRun["review"]>, held: HeldLock): Promise<WorkflowRun>;
  /** Eval runs only: the result the evaluation reached. */
  recordEval(runId: string, result: NonNullable<WorkflowRun["eval"]>, held: HeldLock): Promise<WorkflowRun>;
  /** With `producedBy`, the entry joins the run's evidence index at once. */
  writeEvidence(runId: string, record: unknown, held: HeldLock, producedBy?: string): Promise<WrittenEvidence>;
  writeVerdict(runId: string, verdict: GateVerdict, held: HeldLock): Promise<string>;
  writeIndex(runId: string, entries: EvidenceIndexEntry[], held: HeldLock): Promise<void>;
  verifyEvidence(loaded: LoadedRun): Promise<EvidenceVerification>;
  writeSnapshot(snapshot: StepSnapshot, held: HeldLock): Promise<string>;
  loadSnapshot(runId: string, seq: number): Promise<StepSnapshot | null>;
  loadLatestSnapshot(runId: string): Promise<StepSnapshot | null>;
  writeJournalEntry(runId: string, seq: number, entry: JournalEntry, held: HeldLock): Promise<void>;
  readJournal(runId: string, seq: number): Promise<Map<string, JournalEntry>>;
  /** The tool-effect ledger: started, done, failed, unknown_after_crash per (seq, node). */
  appendEffect(runId: string, line: EffectLine, held: HeldLock): Promise<void>;
  readEffects(runId: string): Promise<EffectLine[]>;
  /** A fork records itself on the parent; an edited fork invalidates later ship evaluations. */
  writeInvalidation(record: Invalidation, held: HeldLock): Promise<string>;
  readInvalidations(runId: string): Promise<Invalidation[]>;
}

export interface EpisodeAccess {
  list(): Promise<LoadedEpisode[]>;
  record(draft: EpisodeDraft, held: HeldLock): Promise<{ episode: Episode; path: string }>;
}

export interface DatasetAccess {
  list(): Promise<DatasetListing[]>;
  create(id: string, held: HeldLock): Promise<{ kind: "created"; path: string } | { kind: "exists"; path: string }>;
}

export interface ConsentAccess {
  list(): Promise<import("@9thlevelsoftware/legion-flow-schema").HookConsent[]>;
  record(consent: import("@9thlevelsoftware/legion-flow-schema").HookConsent, held: HeldLock): Promise<string>;
}

export interface ReviewReceiptAccess {
  list(): Promise<ReviewReceipt[]>;
  record(receipt: ReviewReceipt, held: HeldLock): Promise<string>;
}

export interface InterruptAccess {
  write(runId: string, interrupt: Interrupt, held: HeldLock): Promise<string>;
  update(runId: string, id: string, patch: Partial<Pick<Interrupt, "status" | "consumedAt">>, held: HeldLock): Promise<Interrupt>;
  load(runId: string, id: string, now?: Date): Promise<LoadedInterrupt | null>;
  list(runId: string, now?: Date): Promise<LoadedInterrupt[]>;
  /** Across all runs; interrupt ids are unique. */
  find(id: string, now?: Date): Promise<LoadedInterrupt | null>;
}

export interface DecisionAccess {
  /** Written before the interrupt's status is updated: the decision is the authority. */
  write(runId: string, decision: Decision, held: HeldLock): Promise<string>;
}

export interface ReleaseAccess {
  list(): Promise<Release[]>;
  record(release: Release, held: HeldLock): Promise<string>;
}

/**
 * The handle for one workspace root: the directory that holds `.legion-flow/`.
 * Callers receive typed members by role (audit chain, engine lock, project,
 * specs, approvals) instead of pairing path strings by hand. Building the
 * handle does no I/O; every path still comes from getLegionFlowPaths, reached here.
 * Every write requires the HeldLock of this workspace's own engine lock.
 */
export class Workspace {
  readonly root: string;
  readonly paths: LegionFlowPaths;
  readonly audit: AuditChain;
  readonly lock: ProcessLock;
  readonly project: ProjectAccess;
  readonly specs: SpecAccess;
  readonly plans: PlanAccess;
  readonly approvals: ApprovalAccess;
  readonly runs: RunAccess;
  readonly releases: ReleaseAccess;
  readonly interrupts: InterruptAccess;
  readonly reviews: ReviewReceiptAccess;
  readonly consents: ConsentAccess;
  readonly datasets: DatasetAccess;
  readonly episodes: EpisodeAccess;
  readonly decisions: DecisionAccess;

  private constructor(root: string) {
    this.root = root;
    this.paths = getLegionFlowPaths(root);
    this.audit = new AuditChain(this.paths.eventsJsonl, this.paths.chainJson);
    this.lock = new ProcessLock(this.paths.engineLock);
    const paths = this.paths;

    const assertOurs = (held: HeldLock, what: string): void => {
      if (!HeldLock.isHeld(held) || held.lockPath !== paths.engineLock) {
        throw new TypeError(`${what} requires the HeldLock of this workspace's engine lock`);
      }
    };

    this.project = {
      load: (now) => loadProject(root, now),
      create: async (input, held) => {
        assertOurs(held, "project.create");
        return createProject(root, input, held);
      },
      setCurrent: async (patch, held) => {
        assertOurs(held, "project.setCurrent");
        return setCurrent(root, patch, held);
      },
    };

    this.specs = {
      load: (id) => loadSpec(paths, id),
      current: async () => {
        const project = await loadProject(root);
        const specId = project.kind === "valid" ? project.config.current?.specId : undefined;
        return specId ? loadSpec(paths, specId) : null;
      },
      create: async (title, held) => {
        assertOurs(held, "specs.create");
        return createSpec(paths, title, held);
      },
    };

    this.plans = {
      load: (id) => loadPlan(paths, id),
      current: async () => {
        const project = await loadProject(root);
        const planId = project.kind === "valid" ? project.config.current?.planId : undefined;
        return planId ? loadPlan(paths, planId) : null;
      },
      create: async (spec, held) => {
        assertOurs(held, "plans.create");
        return createPlan(paths, spec, held);
      },
    };

    this.approvals = {
      list: () => listApprovals(paths),
      forSubject: (subject, subjectId) => findApprovals(paths, subject, subjectId),
      record: async (receipt, held) => {
        assertOurs(held, "approvals.record");
        return recordApproval(paths, receipt, held);
      },
    };

    this.runs = {
      list: () => listRuns(paths),
      load: (id) => loadRun(paths, id),
      create: async (input, held) => {
        assertOurs(held, "runs.create");
        return createRun(paths, input, held);
      },
      complete: async (runId, ready, held) => {
        assertOurs(held, "runs.complete");
        return completeRun(paths, runId, ready, held);
      },
      finish: async (runId, patch, held) => {
        assertOurs(held, "runs.finish");
        return finishRun(paths, runId, patch, held);
      },
      recordApplied: async (runId, applied, held) => {
        assertOurs(held, "runs.recordApplied");
        return recordApplied(paths, runId, applied, held);
      },
      recordReview: async (runId, review, held) => {
        assertOurs(held, "runs.recordReview");
        return recordReviewResult(paths, runId, review, held);
      },
      recordEval: async (runId, result, held) => {
        assertOurs(held, "runs.recordEval");
        return recordEvalResult(paths, runId, result, held);
      },
      writeSnapshot: async (snapshot, held) => {
        assertOurs(held, "runs.writeSnapshot");
        return writeSnapshot(paths, snapshot, held);
      },
      loadSnapshot: (runId, seq) => loadSnapshot(paths, runId, seq),
      loadLatestSnapshot: (runId) => loadLatestSnapshot(paths, runId),
      writeJournalEntry: async (runId, seq, entry, held) => {
        assertOurs(held, "runs.writeJournalEntry");
        return writeJournalEntry(paths, runId, seq, entry, held);
      },
      readJournal: (runId, seq) => readJournal(paths, runId, seq),
      appendEffect: async (runId, line, held) => {
        assertOurs(held, "runs.appendEffect");
        return appendEffect(paths, runId, line, held);
      },
      readEffects: (runId) => readEffects(paths, runId),
      writeInvalidation: async (record, held) => {
        assertOurs(held, "runs.writeInvalidation");
        return writeInvalidation(paths, record, held);
      },
      readInvalidations: (runId) => readInvalidations(paths, runId),
      writeEvidence: async (runId, record, held, producedBy) => {
        assertOurs(held, "runs.writeEvidence");
        return writeEvidence(paths, runId, record, held, producedBy);
      },
      writeVerdict: async (runId, verdict, held) => {
        assertOurs(held, "runs.writeVerdict");
        return writeVerdict(paths, runId, verdict, held);
      },
      writeIndex: async (runId, entries, held) => {
        assertOurs(held, "runs.writeIndex");
        return writeEvidenceIndex(paths, runId, entries, held);
      },
      verifyEvidence: (loaded) => verifyRunEvidence(paths, loaded),
    };

    this.releases = {
      list: () => listReleases(paths),
      record: async (release, held) => {
        assertOurs(held, "releases.record");
        return recordRelease(paths, release, held);
      },
    };

    this.episodes = {
      list: () => listEpisodes(paths),
      record: async (draft, held) => {
        assertOurs(held, "episodes.record");
        return recordEpisode(paths, draft, held);
      },
    };

    this.datasets = {
      list: () => listDatasets(paths),
      create: async (id, held) => {
        assertOurs(held, "datasets.create");
        return createDataset(paths, id, held);
      },
    };

    this.consents = {
      list: () => listConsents(paths),
      record: async (consent, held) => {
        assertOurs(held, "consents.record");
        return recordConsent(paths, consent, held);
      },
    };

    this.reviews = {
      list: () => listReviewReceipts(paths),
      record: async (receipt, held) => {
        assertOurs(held, "reviews.record");
        return recordReviewReceipt(paths, receipt, held);
      },
    };

    this.interrupts = {
      write: async (runId, interrupt, held) => {
        assertOurs(held, "interrupts.write");
        return writeInterrupt(paths, runId, interrupt, held);
      },
      update: async (runId, id, patch, held) => {
        assertOurs(held, "interrupts.update");
        return updateInterrupt(paths, runId, id, patch, held);
      },
      load: (runId, id, now = new Date()) => loadInterrupt(paths, runId, id, now),
      list: (runId, now = new Date()) => listInterrupts(paths, runId, now),
      find: (id, now = new Date()) => findInterrupt(paths, id, now),
    };

    this.decisions = {
      write: async (runId, decision, held) => {
        assertOurs(held, "decisions.write");
        return writeDecision(paths, runId, decision, held);
      },
    };
  }

  static at(root: string): Workspace {
    return new Workspace(root);
  }
}
