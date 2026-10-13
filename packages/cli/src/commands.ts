import { join, relative, sep, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import {
  SCHEMA_VERSIONS,
  type Approval,
  type Decision,
  type Diagnostic,
  type Phase,
  type ResultEnvelope,
} from "@9thlevelsoftware/legion-flow-schema";
import {
  LockAcquisitionError,
  configFingerprint,
  detectTreeMode,
  fingerprintRecord,
  newId,
  validatePlanAgainstSpec,
  argvCheckProblem,
  type ExistingProject,
  type LoadProjectResult,
  type LoadSpecResult,
  type LoadPlanResult,
  type Workspace,
} from "@9thlevelsoftware/legion-flow-persist";
import { evaluateShip, parseWaiver, runCheck, requiredGates, type WaiverInput } from "@9thlevelsoftware/legion-flow-gates";
import {
  taskWorkflow,
  runWorkflow,
  resumeWorkflow,
  continueRun,
  selectNextTask,
  appliedTaskIds,
  APPLY_ACTION,
  type EngineResult,
  type TaskInput,
} from "@9thlevelsoftware/legion-flow-engine";
import { adapterById, adaptersDistDir, definitionOf, agentDockerfile, agentImageTag } from "@9thlevelsoftware/legion-flow-adapters";
import type { Adapter } from "@9thlevelsoftware/legion-flow-engine";
import { selectBatch, broadcastWorkflow, recommendCandidate, challengeWorkflow, observationNamingWorkflow, draftWorkflow, type BroadcastCandidate, type ChallengeResult, type NamingResult, type StepRunner, type DraftParse, type DraftResult } from "@9thlevelsoftware/legion-flow-engine";
import { reviewWorkflow, evalWorkflow, type AppliedProposalSummary, type ReviewInput, type EvalInput } from "@9thlevelsoftware/legion-flow-engine";
import { createMetricScorer, judgeUrlProblem } from "@9thlevelsoftware/legion-flow-evals";
import { ProposalSchema, loopbackUrlProblem, type EgressRoute, type ReviewReceipt } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, fingerprintTree, specFingerprint, planFingerprint, type TreeMode } from "@9thlevelsoftware/legion-flow-persist";
import { SpecSchema, PlanSchema, type Spec, type SpecDraft } from "@9thlevelsoftware/legion-flow-schema";
import type { DockerSettings, EnforcementReport, SpawnKind, SpawnVerdict } from "@9thlevelsoftware/legion-flow-sandbox";
import { createEvidenceTracing } from "@9thlevelsoftware/legion-flow-evidence";
import { challengeStatus, BROWSER_SERVER_NAME, WEB_SERVER_NAME, browserSessionProblem, type BrowserSession } from "@9thlevelsoftware/legion-flow-schema";
import { SPAN_ATTRIBUTES, DEFAULT_MEMBER_ID, BROADCAST_DEFAULT_MAX, BROADCAST_WORKFLOW_ID, CHOOSE_PROPOSAL_ACTION, memberIds, routeTask, type RunMember } from "@9thlevelsoftware/legion-flow-schema";
import {
  createMaterializer,
  enforcementReport,
  dockerPreflight,
  resolveDockerSettings,
  realDockerCli,
  SANDBOX_TIER_IDS,
  SANDBOX_TIERS,
  egressDistDir,
  secretRefs,
  validateRoutes,
  spawnAllowed,
  type SandboxTierId,
  type MaterializeStrategy,
} from "@9thlevelsoftware/legion-flow-sandbox";
import { runDoctor, type DiagnosticItem } from "./doctor.js";
import { mapVerb, type MapOptions } from "./map-command.js";
import { lintSpec, newRound, readChallenge, writeChallenge } from "./spec-challenge.js";
import type { PreboundGateway } from "./tool-gateway.js";
import { hooksVerb, type HooksOptions } from "./hooks.js";
import { bundleDestinationProblem, loadSigningKey, readPassphraseFromTty, verifyBundleAt, writeBundleFor, type Refusal } from "./bundle-command.js";
import { analyzeCandidate, briefContext, buildMap, mapStatus, memoryContextFor, rulesOf, serversOf, type LanguageServerRunner } from "@9thlevelsoftware/legion-flow-memory";
import { languageServerRunner } from "./lsp-runner.js";
import { loadScript, runBrowserCheck, browserImageTag, browserDockerfile, findBrowsers } from "@9thlevelsoftware/legion-flow-browser";
import type { LoadedInterrupt, LoadedRun } from "@9thlevelsoftware/legion-flow-persist";
import { learnVerb, recallVerb, retroVerb, SUPERSEDE_ACTION, SUPERSEDE_WORKFLOW_ID, type LearnOptions, type RecallOptions } from "./memory-command.js";
import { observeVerb, OBSERVE_ACTION, OBSERVE_WORKFLOW_ID, type ObserveOptions, type ObservationSuggester } from "./observe-command.js";
import { ObservationEditSchema } from "@9thlevelsoftware/legion-flow-schema";
import { matchesAnyPathPattern, type ProposalArchitecture, type ProposalImpact } from "@9thlevelsoftware/legion-flow-schema";
import { renderDiagnostic, type CommandHandler, type TextRenderer } from "./runner.js";

/**
 * Command handlers. Each is a pure function from context and options to an
 * envelope; the runner owns output and exit codes. Facts a human used to read
 * from bespoke text (project name, id, adapter) travel as `info` diagnostics
 * so --json consumers get them too.
 *
 * Phase rule: the phase enum has no "invalid" value. When the project record
 * exists but fails to load, the envelope reports `uninitialized` (no valid
 * project is in force) and a `project_config_invalid` diagnostic carries the cause.
 */

const RESULT = SCHEMA_VERSIONS.RESULT;
/** Stamped on span records as the instrumentation scope version. */
export const CLI_VERSION = "0.0.0";

/** Phase to report for a load result, applying the invalid-record rule above. */
export function phaseOf(project: LoadProjectResult): Phase {
  return project.kind === "valid" ? project.phase : "uninitialized";
}

export function invalidProjectDiagnostic(project: Extract<LoadProjectResult, { kind: "invalid" }>): Diagnostic {
  return {
    code: "project_config_invalid",
    severity: "error",
    message: `project.json is ${project.cause.replace("_", " ")}: ${project.detail}`,
    path: project.path,
    hint: "Move the file aside and run 'legion-flow init' again, or restore it from version control.",
  };
}

/** Phase reasons (an invalidated approval, a dangling pointer) become warnings on every envelope that reports a phase. */
function phaseReasonDiagnostics(project: LoadProjectResult): Diagnostic[] {
  if (project.kind !== "valid") return [];
  return project.phaseReasons.map((r) => ({ code: r.code, severity: "warning" as const, message: r.message }));
}

/** The one next command for a phase, used by status and by every verb that lands on a phase. */
export function nextActionFor(phase: Phase): ResultEnvelope["nextAction"] {
  switch (phase) {
    case "uninitialized":
      return { type: "command", run: "legion-flow init --adapter <id>", hint: "Initialize a project first." };
    case "initialized":
      return { type: "command", run: "legion-flow spec --new <title>", hint: "Draft a specification next." };
    case "spec_draft":
      return {
        type: "command",
        run: "legion-flow approve spec --approver <id>",
        hint: "Edit SPEC.md and spec.json, then freeze the spec as a decision owner.",
      };
    case "spec_frozen":
      return { type: "command", run: "legion-flow plan --new", hint: "Draft an execution plan against the frozen spec." };
    case "planning":
      return {
        type: "command",
        run: 'legion-flow approve plan --approver <id> --check "<argv>"',
        hint: "Add tasks with FileContracts to plan.json, then freeze the plan with at least one verification check.",
      };
    case "plan_ready":
      return { type: "command", run: "legion-flow execute", hint: "Execute the next approved task; once every task is applied, ship evaluates the gates." };
    case "executing":
      return { type: "command", run: "legion-flow execute --resume", hint: "A task run is incomplete; re-enter it." };
    case "reviewing":
      return { type: "command", run: "legion-flow review", hint: "Every task is applied and this tier requires an independent review." };
    case "ready_to_ship":
      return { type: "command", run: "legion-flow ship --commit --approver <id>", hint: "Every required gate is satisfied or waived at the current fingerprints." };
    case "shipped":
      return { type: "none", reason: "The current spec and plan are shipped at their current fingerprints." };
    case "awaiting_decision":
      return { type: "command", run: "legion-flow status", hint: "A human decision is pending; status names the interrupt." };
    default:
      return { type: "command", run: "legion-flow status", hint: `Phase ${phase} has no built next verb yet.` };
  }
}

function envelope(
  command: string,
  status: ResultEnvelope["status"],
  phase: Phase,
  diagnostics: Diagnostic[],
  nextAction: ResultEnvelope["nextAction"],
  gates: ResultEnvelope["gates"] = [],
  runId?: string
): ResultEnvelope {
  return { schema: RESULT, command, ...(runId ? { runId } : {}), status, phase, diagnostics, gates, nextAction };
}

/** A held engine lock is a typed refusal with a cause, never an unexpected error. */
async function lockHeldRefusal(command: string, ws: Workspace, err: LockAcquisitionError): Promise<ResultEnvelope> {
  const holder = err.holder;
  return envelope(
    command,
    "refused",
    phaseOf(await ws.project.load()),
    [
      {
        code: "engine_lock_held",
        severity: "error",
        message: holder
          ? `engine.lock is held by PID ${holder.pid} since ${holder.acquiredAt}${holder.command ? ` (${holder.command})` : ""}.`
          : "engine.lock is held by another process whose record could not be read.",
        path: ws.paths.engineLock,
        hint: "Wait for that process to finish. If it is gone, the next run steals the stale lock automatically.",
      },
    ],
    { type: "command", run: "legion-flow status", hint: `Re-run ${command} once the lock is released.` }
  );
}

/** Refusal when the project is absent or invalid; shared by every verb that needs a valid project. */
function projectUnusableRefusal(command: string, project: Exclude<LoadProjectResult, { kind: "valid" }>): ResultEnvelope {
  if (project.kind === "absent") {
    return envelope(
      command,
      "refused",
      "uninitialized",
      [{ code: "project_not_initialized", severity: "error", message: "No project found in current directory.", hint: "Run 'legion-flow init --adapter <id>' first." }],
      nextActionFor("uninitialized")
    );
  }
  return envelope(command, "refused", "uninitialized", [invalidProjectDiagnostic(project)], {
    type: "command",
    run: "legion-flow doctor",
    hint: "Inspect the project record before continuing.",
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitOptions {
  adapter: string;
  name: string;
  owner: string;
}

function initRefused(existing: ExistingProject, projectConfigPath: string): ResultEnvelope {
  if (existing.kind === "valid") {
    return envelope(
      "init",
      "refused",
      existing.phase,
      [
        {
          code: "project_exists",
          severity: "error",
          message: `A project already exists here: ${existing.config.name} (${existing.config.id}).`,
          path: projectConfigPath,
          hint: "Run 'legion-flow status' to see it, or choose a different directory.",
        },
      ],
      { type: "command", run: "legion-flow status", hint: "The existing project was left untouched." }
    );
  }
  return envelope("init", "refused", "uninitialized", [invalidProjectDiagnostic(existing)], {
    type: "command",
    run: "legion-flow doctor",
    hint: "Nothing was overwritten.",
  });
}

export const initCommand: CommandHandler<InitOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  try {
    return await ws.lock.withLock(async (held) => {
      const result = await ws.project.create(
        { name: opts.name, adapterId: opts.adapter, ownerId: opts.owner },
        held
      );
      if (result.kind === "exists") {
        return initRefused(result.existing, ws.paths.projectConfig);
      }

      await ws.audit.append(
        { type: "project_initialized", projectId: result.config.id, adapter: opts.adapter, owner: opts.owner },
        held
      );

      return envelope(
        "init",
        "ok",
        result.phase,
        [
          {
            code: "project_initialized",
            severity: "info",
            message: `Initialized Legion Flow project: ${result.config.name} (${result.config.id})`,
            path: result.path,
          },
          { code: "adapter", severity: "info", message: `Default adapter: ${result.config.adapter.default}` },
          { code: "decision_owner", severity: "info", message: `Decision owner: ${opts.owner} (kind: human)` },
        ],
        nextActionFor(result.phase)
      );
    }, "init");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("init", ws, err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export const statusCommand: CommandHandler<Record<string, never>> = (ctx) => statusEnvelope(ctx, "status");

/** `next` is the one-line face of `status`: the same envelope, rendered as the next command alone. */
export const nextCommand: CommandHandler<Record<string, never>> = (ctx) => statusEnvelope(ctx, "next");

export const renderNextText: TextRenderer = (env) => {
  const next = env.nextAction;
  switch (next.type) {
    case "command":
      return next.run;
    case "human_decision":
      return next.run;
    case "credential_required":
      return `set ${next.variable} (${next.adapter} adapter), then: legion-flow execute`;
    case "wait":
      return `wait until ${next.until}: ${next.reason}`;
    case "none":
      return next.reason;
  }
};

/** status and next share this so they can never disagree. */
/**
 * Orphaned broadcasts (M4 slice v): member runs that all ended, with no choice run carrying their id in any status (a
 * cancelled or failed choice counts as present). Read by status, to say so, and by execute --resume, to recover them.
 */
export function orphanedBroadcasts(runs: readonly LoadedRun[]): Map<string, LoadedRun[]> {
  const groups = new Map<string, LoadedRun[]>();
  const chosen = new Set<string>();
  for (const r of runs) {
    if (r.run.kind !== "workflow" || !r.run.broadcast) continue;
    if (r.run.broadcast.role === "choice") chosen.add(r.run.broadcast.id);
    else groups.set(r.run.broadcast.id, [...(groups.get(r.run.broadcast.id) ?? []), r]);
  }
  for (const [id, members] of [...groups]) if (chosen.has(id) || members.some((m) => m.run.status === "running" || m.run.status === "awaiting_decision")) groups.delete(id);
  return groups;
}

async function statusEnvelope(ctx: Parameters<CommandHandler>[0], command: "status" | "next"): Promise<ResultEnvelope> {
  const project = await ctx.workspace.project.load();

  switch (project.kind) {
    case "absent":
      return envelope(
        command,
        "blocked",
        "uninitialized",
        [
          {
            code: "project_not_initialized",
            severity: "warning",
            message: "No project found in current directory.",
            hint: "Run 'legion-flow init --adapter <id>' to initialize.",
          },
        ],
        nextActionFor("uninitialized")
      );
    case "invalid":
      return envelope(command, "blocked", "uninitialized", [invalidProjectDiagnostic(project)], {
        type: "command",
        run: "legion-flow doctor",
        hint: "Inspect the project record before continuing.",
      });
    case "valid": {
      const diagnostics: Diagnostic[] = [
        { code: "project", severity: "info", message: `Project: ${project.config.name} (${project.config.id})` },
        { code: "adapter", severity: "info", message: `Adapter: ${project.config.adapter.default}` },
      ];
      if (project.config.current?.specId) {
        diagnostics.push({ code: "current_spec", severity: "info", message: `Current spec: ${project.config.current.specId}` });
      }
      diagnostics.push(...phaseReasonDiagnostics(project));
      for (const [id, members] of orphanedBroadcasts(await ctx.workspace.runs.list())) {
        const taskId = (members[0]!.run as { task?: { taskId: string } }).task?.taskId ?? "?";
        diagnostics.push({ code: "broadcast_orphaned", severity: "warning", message: `Broadcast ${id} (${taskId}) has ${members.length} finished member run(s) and no choice run: it stopped before its choice was opened.`, hint: "Run legion-flow execute --resume to open the choice from the members' records." });
      }
      const pending = project.pendingInterrupt;
      if (project.phase === "awaiting_decision" && pending) {
        diagnostics.push({
          code: "decision_pending",
          severity: "warning",
          message: `Interrupt ${pending.interrupt.id} (${pending.interrupt.kind}, ${pending.interrupt.action.name}, risk ${pending.interrupt.action.riskClass}) awaits a decision until ${pending.interrupt.expiresAt}.`,
          path: pending.path,
        });
        return envelope(command, "awaiting_decision", project.phase, diagnostics, {
          type: "human_decision",
          interruptId: pending.interrupt.id,
          decisionKind: pending.interrupt.kind,
          run: `legion-flow decide ${pending.interrupt.id} --approve --approver <id>`,
          payloadRef: pending.interrupt.payloadRef,
          responseSchema: SCHEMA_VERSIONS.DECISION,
        });
      }
      const memory = await openMemoryRuns(ctx.workspace);
      if (memory.decided) {
        const verb = resumeVerbFor(memory.decided.action);
        diagnostics.push({ code: verb === "observe" ? "observation_decided" : "supersession_decided", severity: "info", message: `${memory.decided.id} is decided; commit it to memory.` });
        return envelope(command, "ok", project.phase, diagnostics, { type: "command", run: `legion-flow ${verb} --resume`, hint: verb === "observe" ? "A memory observation was decided; resuming records it." : "A memory supersession was decided; resuming records it." });
      }
      if (memory.pending) {
        const i = memory.pending.interrupt;
        // An observation's words are shown where the decision owner looks (M4 slice p): approving commits them.
        let words = "";
        if (i.action.name === OBSERVE_ACTION) {
          try {
            const p = JSON.parse(await readFile(join(ctx.workspace.paths.project, ...i.payloadRef.path.split("/")), "utf8")) as { payload: { candidate: { name: string; summary: string }; suggestion?: { name: string; summary: string; by: { adapter: string; model?: string } } } };
            const s = p.payload.suggestion;
            words = s
              ? ` Approving commits the namer's words (${s.by.adapter}${s.by.model ? ` ${s.by.model}` : ""}): <untrusted-content source="observation-namer">${s.name}: ${s.summary}</untrusted-content>`
              : ` Approving commits the template's words: ${p.payload.candidate.name}: ${p.payload.candidate.summary}`;
          } catch {
            words = "";
          }
        }
        diagnostics.push({ code: "decision_pending", severity: "warning", message: `Interrupt ${i.id} (${i.action.name}) awaits a decision until ${i.expiresAt}: ${i.action.name === OBSERVE_ACTION ? "a cluster of facts would be committed as an observation" : "a proposed fact would replace an active one"}.${words}`, path: memory.pending.path });
        return envelope(command, "awaiting_decision", project.phase, diagnostics, { type: "human_decision", interruptId: i.id, decisionKind: i.kind, run: `legion-flow decide ${i.id} --approve --approver <id>`, payloadRef: i.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION });
      }
      const awaitingAcceptance = project.phase === "reviewing" && project.phaseReasons.some((r) => r.code === "review_awaiting_acceptance");
      return envelope(
        command,
        "ok",
        project.phase,
        diagnostics,
        awaitingAcceptance
          ? { type: "command", run: "legion-flow review --accept --approver <id>", hint: "The latest review passed; a decision owner reads review.md and accepts it." }
          : project.phase === "plan_ready"
            ? await planReadyNextAction(ctx.workspace)
            : nextActionFor(project.phase)
      );
    }
  }
}

/** At plan_ready the next verb depends on the plan's tasks: execute what remains, ship when everything is applied. */
async function planReadyNextAction(ws: Workspace): Promise<ResultEnvelope["nextAction"]> {
  const plan = await ws.plans.current();
  if (!plan || plan.kind !== "valid") return nextActionFor("plan_ready");
  const selection = selectNextTask(plan.plan, await ws.runs.list());
  switch (selection.kind) {
    case "task":
      return { type: "command", run: `legion-flow execute ${selection.task.id}`, hint: `Execute ${selection.task.id}: ${selection.task.title}.` };
    case "all_applied": {
      const project = await ws.project.load();
      if (project.kind === "valid" && requiredGates(project.config.defaultRiskTier).includes("eval_goldens")) {
        const datasets = await ws.datasets.list();
        if (datasets.length === 0) return { type: "command", run: "legion-flow eval --new <datasetId>", hint: "This tier requires golden evaluations; create a dataset." };
        const runs = await ws.runs.list();
        const pending = datasets.find((d) => !runs.some((r) => r.run.kind === "workflow" && r.run.workflowId === "eval" && r.run.eval?.datasetId === d.id && r.run.eval.passed && r.run.eval.fingerprints.plan === plan.fingerprint));
        if (pending) return { type: "command", run: `legion-flow eval --dataset ${pending.id}`, hint: "This tier requires golden evaluations at the current fingerprints." };
      }
      if (project.kind === "valid" && rulesOf(project.config) && (await mapStatus(ws)).freshness !== "fresh") {
        return { type: "command", run: "legion-flow map", hint: "This project has architecture rules and the code map is not fresh; rebuild it so architecture_conformance can be judged." };
      }
      return { type: "command", run: "legion-flow ship", hint: "Every task is applied; evaluate the gates." };
    }
    case "blocked":
      return { type: "command", run: "legion-flow plan", hint: `No task can run: ${selection.reason}. Remaining: ${selection.remaining.join(", ")}.` };
  }
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

export interface SpecOptions {
  new?: string;
  /** Run a challenge round on the current draft (M4 slice j3), or resolve one of its concerns. */
  challenge?: boolean;
  /** With --challenge: also run the challenge agent (it always runs when project.json spec.challenge is set). */
  agent?: boolean;
  resolve?: string;
  answer?: string;
  dismiss?: string;
  acceptRisk?: string;
  approver?: string;
  sandbox?: string;
  allowNoSandbox?: boolean;
  /** Have the default adapter draft (or redraft) the spec from this request. */
  draft?: string;
  /** Test seams. */
  adapterTimeoutMs?: number;
  now?: Date;
}

function specDiagnostics(spec: Extract<LoadSpecResult, { kind: "valid" }>): Diagnostic[] {
  const criteria = spec.spec.acceptanceCriteria;
  const diagnostics: Diagnostic[] = [
    { code: "spec", severity: "info", message: `Spec ${spec.id}: ${spec.spec.title}`, path: spec.dir },
    { code: "spec_fingerprint", severity: "info", message: `Fingerprint ${spec.fingerprint}` },
  ];
  if (criteria.length === 0) {
    diagnostics.push({
      code: "no_acceptance_criteria",
      severity: "warning",
      message: "The spec has no acceptance criteria; approve spec will refuse it.",
      hint: "Add criteria to acceptanceCriteria in spec.json (ids AC-01, AC-02, ...).",
    });
  } else {
    diagnostics.push({
      code: "acceptance_criteria",
      severity: "info",
      message: `${criteria.length} acceptance criteria: ${criteria.map((c) => `${c.id} [${c.kind}/${c.surface}/${c.priority}]`).join(", ")}`,
    });
  }
  return diagnostics;
}

export const specCommand: CommandHandler<SpecOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  if (opts.draft !== undefined) return specDraftCommand(ctx, opts);
  if (opts.challenge || opts.resolve !== undefined || opts.agent) return specChallengeCommand(ctx, opts);

  if (opts.new !== undefined) {
    const title = opts.new.trim();
    if (title.length === 0) {
      return envelope("spec", "usage_error", phaseOf(await ws.project.load()), [
        { code: "title_required", severity: "error", message: "--new needs a non-empty title." },
      ], { type: "command", run: "legion-flow spec --new <title>" });
    }
    try {
      return await ws.lock.withLock(async (held) => {
        const project = await ws.project.load();
        if (project.kind !== "valid") return projectUnusableRefusal("spec", project);

        const currentId = project.config.current?.specId;
        if (currentId) {
          const current = await ws.specs.load(currentId);
          if (current.kind !== "absent") {
            return envelope(
              "spec",
              "refused",
              project.phase,
              [
                {
                  code: "spec_exists",
                  severity: "error",
                  message: `This project already has a current spec (${currentId}); one spec per project at M1.`,
                  path: current.dir,
                  hint: "Edit the current spec, or remove its directory and the current pointer to start over.",
                },
                ...phaseReasonDiagnostics(project),
              ],
              nextActionFor(project.phase)
            );
          }
        }

        const created = await ws.specs.create(title, held);
        const updated = await ws.project.setCurrent({ specId: created.spec.id }, held);
        await ws.audit.append({ type: "spec_created", specId: created.spec.id, title, fingerprint: created.fingerprint }, held);
        const phase = phaseOf(updated);
        return envelope(
          "spec",
          "ok",
          phase,
          [
            { code: "spec_created", severity: "info", message: `Created draft spec ${created.spec.id}: ${title}`, path: created.dir },
            { code: "spec_fingerprint", severity: "info", message: `Fingerprint ${created.fingerprint}` },
            {
              code: "no_acceptance_criteria",
              severity: "warning",
              message: "The draft has no acceptance criteria yet.",
              hint: "Edit SPEC.md and add criteria to acceptanceCriteria in spec.json before approving.",
            },
          ],
          nextActionFor(phase)
        );
      }, "spec --new");
    } catch (err: unknown) {
      if (err instanceof LockAcquisitionError) return lockHeldRefusal("spec", ws, err);
      throw err;
    }
  }

  // Bare spec: inspect the current draft.
  const project = await ws.project.load();
  if (project.kind !== "valid") return projectUnusableRefusal("spec", project);

  const specId = project.config.current?.specId;
  if (!specId) {
    return envelope(
      "spec",
      "blocked",
      project.phase,
      [{ code: "no_current_spec", severity: "warning", message: "This project has no spec yet.", hint: "Run 'legion-flow spec --new <title>'." }],
      nextActionFor(project.phase)
    );
  }
  const spec = await ws.specs.load(specId);
  if (spec.kind === "absent") {
    return envelope("spec", "blocked", project.phase, phaseReasonDiagnostics(project), nextActionFor(project.phase));
  }
  if (spec.kind === "invalid") {
    return envelope(
      "spec",
      "blocked",
      project.phase,
      [
        {
          code: "spec_invalid",
          severity: "error",
          message: `spec ${specId} is ${spec.cause.replace("_", " ")}: ${spec.detail}`,
          path: spec.dir,
          hint: "Fix spec.json so it validates against legion-flow-spec/v1.",
        },
      ],
      { type: "command", run: "legion-flow spec", hint: "Re-run after fixing the file." }
    );
  }
  return envelope(
    "spec",
    project.phase === "spec_frozen" ? "ready" : "ok",
    project.phase,
    [...specDiagnostics(spec), challengeDiagnostic(challengeStatus(await readChallenge(spec.dir), spec.fingerprint), project.config.spec?.challenge), ...phaseReasonDiagnostics(project)],
    nextActionFor(project.phase)
  );
};

function challengeDiagnostic(st: ReturnType<typeof challengeStatus>, setting: "required" | "optional" | undefined): Diagnostic {
  const req = setting === "required" ? " (required before approval)" : "";
  if (st.status === "none") return { code: "spec_challenge", severity: setting === "required" ? "warning" : "info", message: `No challenge round yet${req}.`, hint: "Run legion-flow spec --challenge." };
  if (st.status === "stale") return { code: "spec_challenge", severity: "warning", message: `Challenge round ${st.round!.round} is stale: the spec changed after it${req}.`, hint: "Run legion-flow spec --challenge again." };
  return { code: "spec_challenge", severity: st.status === "open" ? "warning" : "info", message: `Challenge round ${st.round!.round}: ${st.status === "open" ? `${st.unresolved} of ${st.round!.concerns.length} concern(s) unresolved` : `complete, ${st.round!.concerns.length} concern(s) resolved`}${st.round!.agent.ran && !st.round!.agent.note ? "" : `; the agent ${st.round!.agent.note === "agent_output_invalid" ? "wrote output that did not parse" : st.round!.agent.ran ? "did not finish" : "did not run"}`}${req}.` };
}

/** `spec --challenge` (M4 slice j3): a new round, or `--resolve <C-n>` with exactly one disposition, as a decision owner on a terminal. */
async function specChallengeCommand(ctx: Parameters<CommandHandler>[0], opts: SpecOptions): Promise<ResultEnvelope> {
  const ws = ctx.workspace;
  const usage = async (message: string) => envelope("spec", "usage_error", phaseOf(await ws.project.load()), [{ code: "challenge_usage", severity: "error", message }], { type: "command", run: "legion-flow spec --challenge" });
  const dispositions = ([["answered", opts.answer], ["dismissed", opts.dismiss], ["risk_accepted", opts.acceptRisk]] as const).filter(([, v]) => v !== undefined);
  if (!opts.challenge) return usage("--agent and --resolve belong to spec --challenge.");
  if (opts.resolve === undefined && dispositions.length > 0) return usage("--answer, --dismiss, and --accept-risk need --resolve <C-n>.");
  if (opts.resolve !== undefined && dispositions.length !== 1) return usage("--resolve needs exactly one of --answer, --dismiss, or --accept-risk, with the response as its value.");
  if (opts.resolve !== undefined && (opts.agent || opts.sandbox !== undefined || opts.allowNoSandbox)) return usage("--resolve records a decision; it takes no agent or sandbox options.");
  const tierId = (opts.sandbox ?? "vm-docker") as SandboxTierId;
  if (!(SANDBOX_TIER_IDS as readonly string[]).includes(tierId)) return usage(`'${opts.sandbox}' is not a sandbox tier.`);
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("spec", project);
      const refuse = (code: string, message: string, hint?: string) => refusal("spec", project, code, message, hint);
      const specId = project.config.current?.specId;
      const spec = specId ? await ws.specs.load(specId) : null;
      if (!spec || spec.kind !== "valid") return refuse("no_current_spec", "There is no valid current spec to challenge.", "Run 'legion-flow spec --new <title>', or fix spec.json.");
      const record = await readChallenge(spec.dir);
      const st = challengeStatus(record, spec.fingerprint);
      const now = new Date();

      if (opts.resolve !== undefined) {
        if (!ctx.isTTY) return refuse("challenge_resolution_requires_tty", "Resolving a concern is a human judgment and is recorded only from a terminal.");
        const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
        if (!owner) return refuse("approver_not_decision_owner", `--resolve needs --approver naming a decision owner (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`);
        if (st.status === "none") return refuse("no_challenge_round", "There is no challenge round to resolve.", "Run legion-flow spec --challenge first.");
        if (st.status === "stale") return refuse("spec_challenge_stale", "The spec changed after this round; a resolution would bind to a spec that no longer exists.", "Run legion-flow spec --challenge again.");
        const round = st.round!;
        const concern = round.concerns.find((c) => c.id === opts.resolve);
        if (!concern) return refuse("challenge_concern_unknown", `Round ${round.round} has no concern ${opts.resolve} (${round.concerns.map((c) => c.id).join(", ") || "none"}).`);
        if (concern.resolution) return refuse("challenge_concern_resolved", `${concern.id} is already ${concern.resolution.disposition} by ${concern.resolution.approver}.`);
        const [disposition, response] = dispositions[0]!;
        if (!response || response.trim().length === 0 || response.length > 2000) return usage("The response is 1 to 2000 characters.");
        let factId: string | undefined;
        if (disposition === "risk_accepted") {
          // An accepted risk becomes a human fact, through learn, so a repeat corroborates rather than duplicates.
          let learned: ResultEnvelope | null = null;
          const capture = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => (learned = envelope("learn", status, project.phase, diagnostics, next));
          await learnVerb(ws, true, project.config, { subject: "topic:spec-risk", predicate: "accepted_risk", text: `${spec.id} ${concern.id}: ${response.trim()}`, approver: owner.id }, capture, held, () => now);
          const got = learned as ResultEnvelope | null;
          if (!got || got.status !== "ok") return envelope("spec", "refused", project.phase, [{ code: "challenge_risk_not_recorded", severity: "error", message: "The accepted risk could not be recorded as a fact, so nothing was resolved." }, ...(got?.diagnostics ?? [])], nextActionFor(project.phase));
          factId = got.diagnostics.map((d) => /fct_[0-9a-z]+/.exec(d.message)?.[0]).find(Boolean);
        }
        concern.resolution = { disposition, response: response.trim(), approver: owner.id, at: now.toISOString(), source: "tty", ...(factId ? { factId } : {}) };
        const path = await writeChallenge(spec.dir, record!, held);
        await ws.audit.append({ type: "spec_challenge_resolved", specId: spec.id, round: round.round, concern: concern.id, disposition, approver: owner.id, factId: factId ?? null }, held);
        const remaining = round.concerns.filter((c) => !c.resolution);
        return envelope("spec", "ok", project.phase, [{ code: "challenge_resolved", severity: "info", message: `${concern.id} ${disposition.replace("_", " ")} by ${owner.id}${factId ? `; recorded as human fact ${factId}` : ""}. ${remaining.length ? `${remaining.length} concern(s) remain: ${remaining.map((c) => c.id).join(", ")}.` : "Every concern in this round is resolved."}`, path }], remaining.length ? { type: "command", run: `legion-flow spec --challenge --resolve ${remaining[0]!.id} --answer "<response>" --approver <id>`, hint: "A decision owner resolves each concern on a terminal." } : nextActionFor(project.phase));
      }

      // A new round: the lint always; the agent with --agent or whenever project.json spec.challenge is set.
      const lint = lintSpec(spec.spec, spec.markdown);
      let agent: ChallengeResult & { runId?: string } = { ran: false, dropped: 0, concerns: [] };
      const runAgent = Boolean(opts.agent) || project.config.spec?.challenge !== undefined;
      const notes: Diagnostic[] = [];
      if (runAgent) {
        const adapter = adapterFor(project.config.adapter.default, project.config);
        if (!adapter) return refuse("adapter_unknown", `Adapter '${project.config.adapter.default}' is not registered in this build.`);
        const prepared = await prepareTier(ctx, project, adapter, tierId, { ...(opts.allowNoSandbox ? { allowNoSandbox: true } : {}) }, "spec", "challenger");
        if (!prepared.ok) return prepared.envelope;
        const preflighted = await preflightTier(ws, project, prepared.tier, "spec");
        if (!preflighted.ok) return preflighted.envelope;
        const t = prepared.tier;
        const source = await fingerprintTree(ws.root, { mode: t.sourceMode });
        const rel = relative(ws.root, spec.dir).split(sep).join("/");
        const result = await runWorkflow(ws, challengeWorkflow({ ws, materializer: createMaterializer({ tier: t.tierId, strategy: "copy", paths: ws.paths, runId: "pending", settings: t.dockerSettings, docker: realDockerCli, routes: t.routes, egressDistDir: egressDistDir(), secrets: t.secrets, now: () => now })!, adapter, adapterTimeoutMs: opts.adapterTimeoutMs, envMode: t.report.isSandbox ? "container" : "host", tierEvidence: preflighted.tierEvidence, redactValues: [...(adapter.credential && process.env[adapter.credential.env] ? [process.env[adapter.credential.env]!] : []), ...Object.values(t.secrets)] }), held, {
          input: { workspaceRoot: ws.root, sourceMode: t.sourceMode, sourceFingerprint: source.fingerprint, specId: spec.id, specTitle: spec.spec.title, specPaths: { json: `${rel}/spec.json`, markdown: `${rel}/SPEC.md` }, acceptanceCriteria: spec.spec.acceptanceCriteria, ...(project.config.adapter.http?.model ? { model: project.config.adapter.http.model } : {}) } as unknown as Record<string, unknown>,
          durability: "sync",
          now: () => now,
        });
        if (result.kind === "complete") agent = { ...(result.values.challenge as ChallengeResult), runId: result.runId };
        else agent = { ran: false, note: "agent_failed", dropped: 0, concerns: [], ...(result.runId ? { runId: result.runId } : {}) };
        notes.push({ code: "challenge_agent", severity: agent.note ? "warning" : "info", message: agent.note === "agent_failed" ? "The challenge agent did not finish; the lint concerns stand on their own." : agent.note === "agent_output_invalid" ? "The challenge agent's output did not parse; the lint concerns stand on their own." : `The challenge agent raised ${agent.concerns.length} concern(s)${agent.dropped ? `; ${agent.dropped} more dropped over the cap or malformed` : ""}.` });
      }
      const next = newRound(record, spec.id, spec.fingerprint, lint, agent, now);
      const path = await writeChallenge(spec.dir, next, held);
      const round = next.rounds.at(-1)!;
      await ws.audit.append({ type: "spec_challenge_round", specId: spec.id, round: round.round, specFingerprint: spec.fingerprint, lint: lint.length, agent: agent.concerns.length, agentNote: agent.note ?? null, runId: agent.runId ?? null }, held);
      const shown = round.concerns.map((c): Diagnostic => ({
        code: "challenge_concern",
        severity: "warning",
        message: c.source === "lint" ? `${c.id} [lint ${c.rule}]: ${c.question}` : `${c.id} [agent${c.unverified ? ", unverified" : ""}]: <untrusted-content source="challenge-agent">${c.question.replace(/<\/?untrusted-content[^>]*>/gi, "")} Why: ${c.why.replace(/<\/?untrusted-content[^>]*>/gi, "")}</untrusted-content>`,
      }));
      return envelope("spec", "ok", project.phase, [{ code: "challenge_round", severity: "info", message: `Challenge round ${round.round} on spec ${spec.id}: ${lint.length} lint concern(s), ${agent.concerns.length} from the agent.`, path }, ...notes, ...shown], round.concerns.length ? { type: "command", run: `legion-flow spec --challenge --resolve ${round.concerns[0]!.id} --answer "<response>" --approver <id>`, hint: "A decision owner resolves each concern on a terminal; agents never resolve." } : nextActionFor(project.phase));
    }, opts.resolve !== undefined ? "spec --challenge --resolve" : "spec --challenge");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("spec", ws, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// drafting: spec --draft and plan --draft
// ---------------------------------------------------------------------------

const untrustedDraft = (text: string) => `<untrusted-content source="drafter">${text.replace(/<\/?untrusted-content[^>]*>/gi, "")}</untrusted-content>`;
/** A contract entry that opens the whole tree to every later execute; a reviewer skimming JSON should not miss it. */
const WHOLE_TREE = new Set(["*", "**", "**/*", ".", "./", "/"]);

/** Run the drafter in the project's tier: the shared preparation, preflight, and redaction of every agent spawn. */
async function runDrafter(
  ctx: Parameters<CommandHandler>[0],
  project: ValidProject,
  held: Parameters<typeof runWorkflow>[2],
  mode: "spec" | "plan",
  opts: { sandbox?: string; allowNoSandbox?: boolean; adapterTimeoutMs?: number; now?: Date },
  input: { request: string; place: string[]; spec?: { id: string; title: string; acceptanceCriteria: Spec["acceptanceCriteria"] } }
): Promise<{ ok: true; parse: DraftParse; runId: string; adapter: Adapter } | { ok: false; envelope: ResultEnvelope }> {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  const tierId = (opts.sandbox ?? "vm-docker") as SandboxTierId;
  const adapter = adapterFor(project.config.adapter.default, project.config);
  if (!adapter) return { ok: false, envelope: refusal(mode, project, "adapter_unknown", `Adapter '${project.config.adapter.default}' is not registered in this build.`) };
  const prepared = await prepareTier(ctx, project, adapter, tierId, { ...(opts.allowNoSandbox ? { allowNoSandbox: true } : {}) }, mode, "drafter");
  if (!prepared.ok) return prepared;
  const preflighted = await preflightTier(ws, project, prepared.tier, mode);
  if (!preflighted.ok) return preflighted;
  const t = prepared.tier;
  const source = await fingerprintTree(ws.root, { mode: t.sourceMode });
  const result = await runWorkflow(ws, draftWorkflow({ ws, materializer: createMaterializer({ tier: t.tierId, strategy: "copy", paths: ws.paths, runId: "pending", settings: t.dockerSettings, docker: realDockerCli, routes: t.routes, egressDistDir: egressDistDir(), secrets: t.secrets, now: () => now })!, adapter, ...(opts.adapterTimeoutMs ? { adapterTimeoutMs: opts.adapterTimeoutMs } : {}), envMode: t.report.isSandbox ? "container" : "host", tierEvidence: preflighted.tierEvidence, redactValues: [...(adapter.credential && process.env[adapter.credential.env] ? [process.env[adapter.credential.env]!] : []), ...Object.values(t.secrets)] }, mode), held, {
    input: { mode, workspaceRoot: ws.root, sourceMode: t.sourceMode, sourceFingerprint: source.fingerprint, request: input.request, place: input.place, ...(input.spec ? { spec: input.spec } : {}), ...(project.config.adapter.http?.model ? { model: project.config.adapter.http.model } : {}) } as unknown as Record<string, unknown>,
    durability: "sync",
    now: () => now,
  });
  const runId = result.runId ?? "unknown";
  if (result.kind !== "complete") return { ok: true, parse: { ok: false, reason: `the drafting run ended ${result.kind}` }, runId, adapter };
  return { ok: true, parse: (result.values.draft as DraftResult).parse, runId, adapter };
}

function renderDraftedSpecMarkdown(spec: Spec, draft: SpecDraft, by: string, runId: string, request: string): string {
  return [
    `# ${spec.title}`,
    "",
    `Specification \`${spec.id}\`. Drafted by ${by} in run ${runId} from the request: "${request.replace(/\s+/g, " ").slice(0, 300)}". Review it before approving; once approved it is the decision owner's.`,
    "This file is the prose half; `spec.json` beside it is the typed half. Both are fingerprinted together: editing either after approval invalidates the approval.",
    "",
    "## Intent",
    "",
    draft.intent,
    "",
    "## Acceptance criteria",
    "",
    ...draft.acceptanceCriteria.map((c) => `- **${c.id}** (${c.kind}, ${c.surface}, ${c.priority}): ${c.statement}`),
    "",
    "## Out of scope",
    "",
    draft.outOfScope && draft.outOfScope.length ? draft.outOfScope : "Not stated by the draft.",
    "",
  ].join("\n");
}

const draftedBy = (adapter: Adapter, project: ValidProject) => `${adapter.id}${project.config.adapter.http?.model ? ` ${project.config.adapter.http.model}` : ""}`;

async function specDraftCommand(ctx: Parameters<CommandHandler>[0], opts: SpecOptions): Promise<ResultEnvelope> {
  const ws = ctx.workspace;
  const request = (opts.draft ?? "").trim();
  if (opts.new !== undefined || opts.challenge || opts.resolve !== undefined || opts.agent) {
    return envelope("spec", "usage_error", phaseOf(await ws.project.load()), [{ code: "draft_exclusive", severity: "error", message: "--draft takes only a request and the sandbox options; it does not combine with --new, --challenge, --agent, or --resolve." }], { type: "command", run: 'legion-flow spec --draft "<what you want>"' });
  }
  if (request.length === 0 || request.length > 4000) return envelope("spec", "usage_error", phaseOf(await ws.project.load()), [{ code: "draft_request_required", severity: "error", message: "--draft needs a request of 1 to 4000 characters: what the change is for." }], { type: "command", run: 'legion-flow spec --draft "<what you want>"' });
  const now = opts.now ?? new Date();
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("spec", project);
      if (project.phase !== "initialized" && project.phase !== "spec_draft") {
        return refusal("spec", project, "draft_phase", `spec --draft writes a new or still-unapproved spec; the project is at ${project.phase}.`, project.phase === "spec_frozen" || project.phase === "planning" ? "FIX: the spec is approved; drafting it again would invalidate that approval. Draft the plan instead: legion-flow plan --draft" : undefined);
      }
      const currentId = project.config.current?.specId;
      const current = currentId ? await ws.specs.load(currentId) : null;
      const existing = current && current.kind === "valid" ? current : null;
      const rel = existing ? relative(ws.root, existing.dir).split(sep).join("/") : null;
      const ran = await runDrafter(ctx, project, held, "spec", opts, { request, place: rel ? [`${rel}/spec.json`, `${rel}/SPEC.md`] : [] });
      if (!ran.ok) return ran.envelope;
      if (!ran.parse.ok || ran.parse.mode !== "spec") {
        return refusal("spec", project, "draft_invalid", `The drafting agent's answer was not usable (${ran.parse.ok ? "wrong kind" : ran.parse.reason}); nothing was written. Run ${ran.runId} keeps its raw answer as evidence.`, 'FIX: run legion-flow spec --draft again, more specifically, or write the spec by hand (spec --new).');
      }
      const draft = ran.parse.draft;
      let dir: string;
      let base: { id: string; createdAt: string };
      let created = false;
      if (existing) {
        dir = existing.dir;
        base = { id: existing.spec.id, createdAt: existing.spec.createdAt };
      } else {
        const made = await ws.specs.create(draft.title, held);
        await ws.project.setCurrent({ specId: made.spec.id }, held);
        await ws.audit.append({ type: "spec_created", specId: made.spec.id, title: draft.title, fingerprint: made.fingerprint }, held);
        dir = made.dir;
        base = { id: made.spec.id, createdAt: made.spec.createdAt };
        created = true;
      }
      const spec = SpecSchema.parse({ schema: SCHEMA_VERSIONS.SPEC, id: base.id, title: draft.title, acceptanceCriteria: draft.acceptanceCriteria, createdAt: base.createdAt });
      const markdown = renderDraftedSpecMarkdown(spec, draft, draftedBy(ran.adapter, project), ran.runId, request);
      await atomicWriteFile(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
      await atomicWriteFile(join(dir, "SPEC.md"), markdown);
      const fingerprint = specFingerprint(spec, markdown);
      await ws.audit.append({ type: "spec_drafted", specId: spec.id, runId: ran.runId, adapter: ran.adapter.id, created, criteria: spec.acceptanceCriteria.length, fingerprint }, held);
      const challenged = !created && ((await readChallenge(dir))?.rounds.length ?? 0) > 0;
      const phase = phaseOf(await ws.project.load(now));
      return envelope("spec", "ok", phase, [
        { code: "spec_drafted", severity: "info", message: `${created ? "Created" : "Rewrote"} draft spec ${spec.id} from the drafting agent's answer (${draftedBy(ran.adapter, project)}, run ${ran.runId}); agent-written and unverified until you approve it.`, path: dir },
        { code: "spec_title", severity: "info", message: `Title: ${untrustedDraft(spec.title)}` },
        ...spec.acceptanceCriteria.map((c): Diagnostic => ({ code: "spec_criterion", severity: "info", message: `${c.id} (${c.kind}, ${c.surface}, ${c.priority}): ${untrustedDraft(c.statement)}` })),
        { code: "spec_fingerprint", severity: "info", message: `Fingerprint ${fingerprint}` },
        ...(challenged ? [{ code: "challenge_stale", severity: "warning" as const, message: "Earlier challenge rounds were against the previous draft and are now stale; run spec --challenge again if you want one." }] : []),
        { code: "draft_review", severity: "warning", message: "Read SPEC.md and spec.json before approving; edit them freely, or run spec --draft again with a sharper request." },
      ], nextActionFor(phase));
    }, "spec --draft");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("spec", ws, err);
    throw err;
  }
}

async function planDraftCommand(ctx: Parameters<CommandHandler>[0], opts: PlanOptions): Promise<ResultEnvelope> {
  const ws = ctx.workspace;
  const request = typeof opts.draft === "string" ? opts.draft.trim() : "";
  if (opts.new) return envelope("plan", "usage_error", phaseOf(await ws.project.load()), [{ code: "draft_exclusive", severity: "error", message: "--draft and --new do not combine; --draft creates the plan when there is none." }], { type: "command", run: "legion-flow plan --draft" });
  if (request.length > 4000) return envelope("plan", "usage_error", phaseOf(await ws.project.load()), [{ code: "draft_request_too_long", severity: "error", message: "Guidance is at most 4000 characters." }], { type: "command", run: "legion-flow plan --draft" });
  const now = opts.now ?? new Date();
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("plan", project);
      if (project.phase !== "spec_frozen" && project.phase !== "planning") {
        return refusal("plan", project, "draft_phase", `plan --draft writes a new or still-unapproved plan against an approved spec; the project is at ${project.phase}.`, project.phase === "spec_draft" || project.phase === "initialized" ? "FIX: approve the spec first (a decision owner): legion-flow approve spec --approver <id>" : undefined);
      }
      const spec = await ws.specs.current();
      if (!spec || spec.kind !== "valid") return refusal("plan", project, "no_current_spec", "No valid current spec.");
      const specRel = relative(ws.root, spec.dir).split(sep).join("/");
      const currentPlanId = project.config.current?.planId;
      const currentPlan = currentPlanId ? await ws.plans.load(currentPlanId) : null;
      const existing = currentPlan && currentPlan.kind === "valid" ? currentPlan : null;
      const place = [`${specRel}/spec.json`, `${specRel}/SPEC.md`, ...(existing ? [`${relative(ws.root, existing.dir).split(sep).join("/")}/plan.json`] : [])];
      const ran = await runDrafter(ctx, project, held, "plan", opts, { request, place, spec: { id: spec.id, title: spec.spec.title, acceptanceCriteria: spec.spec.acceptanceCriteria } });
      if (!ran.ok) return ran.envelope;
      if (!ran.parse.ok || ran.parse.mode !== "plan") {
        return refusal("plan", project, "draft_invalid", `The drafting agent's answer was not usable (${ran.parse.ok ? "wrong kind" : ran.parse.reason}); nothing was written. Run ${ran.runId} keeps its raw answer as evidence.`, "FIX: run legion-flow plan --draft again with guidance, or write the plan by hand (plan --new).");
      }
      const draft = ran.parse.draft;
      let dir: string;
      let base: { id: string; createdAt: string };
      let created = false;
      if (existing) {
        dir = existing.dir;
        base = { id: existing.plan.id, createdAt: existing.plan.createdAt };
      } else {
        const made = await ws.plans.create({ id: spec.id, fingerprint: spec.fingerprint }, held);
        await ws.project.setCurrent({ planId: made.plan.id }, held);
        await ws.audit.append({ type: "plan_created", planId: made.plan.id, specId: spec.id, specFingerprint: spec.fingerprint, fingerprint: made.fingerprint }, held);
        dir = made.dir;
        base = { id: made.plan.id, createdAt: made.plan.createdAt };
        created = true;
      }
      const plan = PlanSchema.parse({ schema: SCHEMA_VERSIONS.PLAN, id: base.id, specId: spec.id, specFingerprint: spec.fingerprint, tasks: draft.tasks.map((t) => ({ id: t.id, title: t.title, acceptanceIds: t.acceptanceIds, dependsOn: t.dependsOn, contract: { filesAllowed: t.contract.filesAllowed, verificationCommands: t.contract.verificationCommands } })), createdAt: base.createdAt });
      await atomicWriteFile(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
      const fingerprint = planFingerprint(plan);
      await ws.audit.append({ type: "plan_drafted", planId: plan.id, specId: spec.id, runId: ran.runId, adapter: ran.adapter.id, created, tasks: plan.tasks.length, fingerprint }, held);
      const validation = validatePlanAgainstSpec(plan, spec.spec, { members: memberIds(project.config.coordinator), mcpServers: (project.config.mcpServers ?? []).map((s) => s.name) });
      const checks = plan.tasks.flatMap((t) => t.contract.verificationCommands.map((c) => ({ task: t.id, check: c })));
      const wide = plan.tasks.flatMap((t) => t.contract.filesAllowed.filter((f) => WHOLE_TREE.has(f.trim())).map((f) => `${t.id}: "${f}"`));
      const phase = phaseOf(await ws.project.load(now));
      return envelope("plan", "ok", phase, [
        { code: "plan_drafted", severity: "info", message: `${created ? "Created" : "Rewrote"} draft plan ${plan.id} against spec ${spec.id} from the drafting agent's answer (${draftedBy(ran.adapter, project)}, run ${ran.runId}); agent-written and unverified until you approve it.`, path: dir },
        ...plan.tasks.map((t): Diagnostic => ({ code: "plan_task", severity: "info", message: `${t.id} covers ${t.acceptanceIds.join(", ") || "no criterion"}${t.dependsOn.length ? `, after ${t.dependsOn.join(", ")}` : ""}: ${untrustedDraft(t.title)}; may change ${t.contract.filesAllowed.join(", ")}` })),
        ...(checks.length ? [{ code: "draft_checks", severity: "warning" as const, message: `The draft proposes these checks; once you approve the plan they run on this machine (without a shell): ${checks.map((c) => `${c.task}: ${untrustedDraft(c.check)}`).join("; ")}` }] : []),
        ...checks.flatMap((c) => { const p = argvCheckProblem(c.check); return p ? [{ code: "draft_check_refused", severity: "warning" as const, message: `${c.task}'s check ${p}; approve plan will refuse it until you change it.` }] : []; }),
        ...(wide.length ? [{ code: "draft_whole_tree", severity: "warning" as const, message: `These contracts open the whole tree to the agent on every execute: ${wide.join(", ")}. Narrow them unless that is intended.` }] : []),
        ...(ran.parse.stripped.length ? [{ code: "draft_fields_stripped", severity: "warning" as const, message: `Removed fields a draft may not set (tools, browser, web, member, and coordinate stay human-added): ${ran.parse.stripped.join(", ")}.` }] : []),
        ...validation.errors.map((e): Diagnostic => ({ code: e.code, severity: "warning", message: `${e.message} (approve plan will refuse this until it is fixed)` })),
        ...validation.warnings.map((w): Diagnostic => ({ code: w.code, severity: "warning", message: w.message })),
        ...(draft.checks?.length ? [{ code: "draft_suggested_checks", severity: "info" as const, message: `The drafter suggests freezing these at approval (your choice; nothing is applied): ${draft.checks.map((c) => untrustedDraft(c)).join("; ")}` }] : []),
        { code: "plan_fingerprint", severity: "info", message: `Fingerprint ${fingerprint}` },
        { code: "draft_review", severity: "warning", message: "Read plan.json before approving: each task's filesAllowed and checks are what you authorize." },
      ], nextActionFor(phase));
    }, "plan --draft");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("plan", ws, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export interface PlanOptions {
  new?: boolean;
  /** Have the default adapter draft the plan (true with no guidance, or the guidance text). */
  draft?: boolean | string;
  sandbox?: string;
  allowNoSandbox?: boolean;
  /** Test seams. */
  now?: Date;
  adapterTimeoutMs?: number;
}

const TASK_SHAPE_HINT =
  'Each task: { "id": "T-01", "title": "...", "acceptanceIds": ["AC-01"], "dependsOn": [], "contract": { "filesAllowed": ["src/..."], "verificationCommands": ["node --test"] } }, optionally with "member": "<coordinator member id>". Checks run without a shell.';

function planDiagnostics(plan: Extract<LoadPlanResult, { kind: "valid" }>, spec: Extract<LoadSpecResult, { kind: "valid" }> | null, members: readonly string[], mcpServers: readonly string[] = []): Diagnostic[] {
  const diagnostics: Diagnostic[] = [
    { code: "plan", severity: "info", message: `Plan ${plan.id} against spec ${plan.plan.specId}`, path: plan.dir },
    { code: "plan_fingerprint", severity: "info", message: `Fingerprint ${plan.fingerprint}` },
  ];
  if (plan.plan.tasks.length === 0) {
    diagnostics.push({
      code: "plan_has_no_tasks",
      severity: "warning",
      message: "The plan has no tasks; approve plan will refuse it.",
      hint: `Add tasks to plan.json. ${TASK_SHAPE_HINT}`,
    });
  } else {
    diagnostics.push({
      code: "plan_tasks",
      severity: "info",
      message: `${plan.plan.tasks.length} tasks: ${plan.plan.tasks.map((t) => `${t.id} (${t.acceptanceIds.join(",") || "no AC"})`).join(", ")}`,
    });
  }
  if (spec) {
    const validation = validatePlanAgainstSpec(plan.plan, spec.spec, { members, mcpServers });
    for (const e of validation.errors) {
      if (e.code !== "plan_has_no_tasks") diagnostics.push({ code: e.code, severity: "error", message: e.message });
    }
    for (const w of validation.warnings) diagnostics.push({ code: w.code, severity: "warning", message: w.message });
  }
  return diagnostics;
}

export const planCommand: CommandHandler<PlanOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  if (opts.draft !== undefined && opts.draft !== false) return planDraftCommand(ctx, opts);

  if (opts.new) {
    try {
      return await ws.lock.withLock(async (held) => {
        const project = await ws.project.load();
        if (project.kind !== "valid") return projectUnusableRefusal("plan", project);

        const currentPlanId = project.config.current?.planId;
        if (currentPlanId && (await ws.plans.load(currentPlanId)).kind !== "absent") {
          return envelope(
            "plan",
            "refused",
            project.phase,
            [
              {
                code: "plan_exists",
                severity: "error",
                message: `This project already has a current plan (${currentPlanId}); one plan per project at M1.`,
                hint: "Edit the current plan, or remove its directory and the current pointer to start over.",
              },
              ...phaseReasonDiagnostics(project),
            ],
            nextActionFor(project.phase)
          );
        }
        if (project.phase !== "spec_frozen") {
          return envelope(
            "plan",
            "refused",
            project.phase,
            [
              {
                code: "spec_not_frozen",
                severity: "error",
                message: `A plan is drafted against a frozen spec; the project is at ${project.phase}.`,
                hint: "Approve the current spec first.",
              },
              ...phaseReasonDiagnostics(project),
            ],
            nextActionFor(project.phase)
          );
        }

        const spec = await ws.specs.current();
        if (!spec || spec.kind !== "valid") {
          return envelope("plan", "refused", project.phase, [{ code: "no_current_spec", severity: "error", message: "No valid current spec." }], nextActionFor(project.phase));
        }

        const created = await ws.plans.create({ id: spec.id, fingerprint: spec.fingerprint }, held);
        const updated = await ws.project.setCurrent({ planId: created.plan.id }, held);
        await ws.audit.append({ type: "plan_created", planId: created.plan.id, specId: spec.id, specFingerprint: spec.fingerprint, fingerprint: created.fingerprint }, held);
        const phase = phaseOf(updated);
        return envelope(
          "plan",
          "ok",
          phase,
          [
            { code: "plan_created", severity: "info", message: `Created draft plan ${created.plan.id} against spec ${spec.id}`, path: created.dir },
            { code: "plan_fingerprint", severity: "info", message: `Fingerprint ${created.fingerprint}` },
            { code: "plan_has_no_tasks", severity: "warning", message: "The draft has no tasks yet.", hint: `Add tasks to plan.json. ${TASK_SHAPE_HINT}` },
          ],
          nextActionFor(phase)
        );
      }, "plan --new");
    } catch (err: unknown) {
      if (err instanceof LockAcquisitionError) return lockHeldRefusal("plan", ws, err);
      throw err;
    }
  }

  // Bare plan: inspect the current draft.
  const project = await ws.project.load();
  if (project.kind !== "valid") return projectUnusableRefusal("plan", project);

  const planId = project.config.current?.planId;
  if (!planId) {
    return envelope(
      "plan",
      "blocked",
      project.phase,
      [
        { code: "no_current_plan", severity: "warning", message: "This project has no plan yet.", hint: project.phase === "spec_frozen" ? "Run 'legion-flow plan --new'." : "Freeze the spec first, then run 'legion-flow plan --new'." },
        ...phaseReasonDiagnostics(project),
      ],
      nextActionFor(project.phase)
    );
  }
  const plan = await ws.plans.load(planId);
  if (plan.kind === "absent") {
    return envelope("plan", "blocked", project.phase, phaseReasonDiagnostics(project), nextActionFor(project.phase));
  }
  if (plan.kind === "invalid") {
    return envelope(
      "plan",
      "blocked",
      project.phase,
      [{ code: "plan_invalid", severity: "error", message: `plan ${planId} is ${plan.cause.replace("_", " ")}: ${plan.detail}`, path: plan.dir, hint: `Fix plan.json so it validates against legion-flow-plan/v1. ${TASK_SHAPE_HINT}` }],
      { type: "command", run: "legion-flow plan", hint: "Re-run after fixing the file." }
    );
  }
  const spec = await ws.specs.load(plan.plan.specId);
  return envelope(
    "plan",
    project.phase === "plan_ready" ? "ready" : "ok",
    project.phase,
    [...planDiagnostics(plan, spec.kind === "valid" ? spec : null, memberIds(project.config.coordinator), (project.config.mcpServers ?? []).map((s) => s.name)), ...phaseReasonDiagnostics(project)],
    nextActionFor(project.phase)
  );
};

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export interface ApproveOptions {
  subject: string;
  approver: string;
  check?: string[];
}

export const approveCommand: CommandHandler<ApproveOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const checks = opts.check ?? [];

  if (opts.subject !== "spec" && opts.subject !== "plan") {
    return envelope("approve", "usage_error", phaseOf(await ws.project.load()), [
      { code: "unknown_subject", severity: "error", message: `Unknown subject '${opts.subject}'. Use 'spec' or 'plan'.` },
    ], { type: "command", run: "legion-flow approve spec --approver <id>" });
  }
  if (opts.subject === "spec" && checks.length > 0) {
    return envelope("approve", "usage_error", phaseOf(await ws.project.load()), [
      { code: "check_not_applicable", severity: "error", message: "--check applies to 'approve plan' only; a spec freezes criteria, not commands." },
    ], { type: "command", run: "legion-flow approve spec --approver <id>" });
  }
  if (opts.subject === "plan") {
    if (checks.length === 0) {
      return envelope("approve", "usage_error", phaseOf(await ws.project.load()), [
        { code: "check_required", severity: "error", message: "approve plan needs at least one --check <argv>; a plan approval with no deterministic check gives ship nothing to evaluate." },
      ], { type: "command", run: 'legion-flow approve plan --approver <id> --check "<argv>"' });
    }
    const bad = checks.map((c) => ({ c, problem: argvCheckProblem(c) })).filter((x) => x.problem);
    if (bad.length > 0) {
      return envelope("approve", "usage_error", phaseOf(await ws.project.load()), bad.map((x) => ({
        code: "check_not_argv",
        severity: "error" as const,
        message: `--check "${x.c}" ${x.problem}.`,
        hint: "Pass one command per --check; globs and $VAR are passed literally, not expanded.",
      })), { type: "command", run: 'legion-flow approve plan --approver <id> --check "<argv>"' });
    }
  }

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("approve", project);

      const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
      if (!owner) {
        return envelope(
          "approve",
          "refused",
          project.phase,
          [
            {
              code: "approver_not_decision_owner",
              severity: "error",
              message: `'${opts.approver}' is not a decision owner of this project (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`,
              hint: "Approvals are recorded only for the humans named in project.json decisionOwners.",
            },
          ],
          nextActionFor(project.phase)
        );
      }

      if (opts.subject === "plan") {
        return approvePlan(ctx, project, owner, checks, held);
      }

      const specId = project.config.current?.specId;
      const spec = specId ? await ws.specs.load(specId) : null;
      if (!spec || spec.kind === "absent") {
        return envelope(
          "approve",
          "refused",
          project.phase,
          [
            { code: "no_current_spec", severity: "error", message: "There is no current spec to approve.", hint: "Run 'legion-flow spec --new <title>' first." },
            ...phaseReasonDiagnostics(project),
          ],
          nextActionFor(project.phase)
        );
      }
      if (spec.kind === "invalid") {
        return envelope(
          "approve",
          "refused",
          project.phase,
          [{ code: "spec_invalid", severity: "error", message: `spec ${specId} is ${spec.cause.replace("_", " ")}: ${spec.detail}`, path: spec.dir }],
          { type: "command", run: "legion-flow spec", hint: "Fix the spec before approving it." }
        );
      }
      if (spec.spec.acceptanceCriteria.length === 0) {
        return envelope(
          "approve",
          "refused",
          project.phase,
          [
            {
              code: "spec_has_no_criteria",
              severity: "error",
              message: `spec ${spec.id} has no acceptance criteria; nothing to freeze.`,
              path: spec.dir,
              hint: "Add at least one criterion to acceptanceCriteria in spec.json.",
            },
          ],
          nextActionFor(project.phase)
        );
      }

      const fingerprints = { spec: spec.fingerprint, config: configFingerprint(project.config) };
      const idempotencyKey = `${project.config.id}:${spec.id}:approve.spec:${spec.fingerprint}`;
      const existing = (await ws.approvals.forSubject("spec", spec.id)).find(
        (r) => r.fingerprints.spec === fingerprints.spec && r.fingerprints.config === fingerprints.config
      );
      if (existing) {
        return envelope(
          "approve",
          "ok",
          "spec_frozen",
          [
            {
              code: "approval_unchanged",
              severity: "info",
              message: `spec ${spec.id} is already approved at this fingerprint by ${existing.decidedBy.id} (${existing.id}); nothing written.`,
            },
          ],
          nextActionFor("spec_frozen")
        );
      }

      // M4 slice j3: under spec.challenge "required", a complete round at this fingerprint, with the agent's output, comes first.
      const challenge = challengeStatus(await readChallenge(spec.dir), spec.fingerprint);
      if (project.config.spec?.challenge === "required") {
        const block = (code: string, message: string) => envelope("approve", "refused", project.phase, [{ code, severity: "error", message, path: spec.dir }], { type: "command", run: "legion-flow spec --challenge", hint: "Run or finish the challenge, then approve." });
        if (challenge.status === "stale") return block("spec_challenge_stale", `Challenge round ${challenge.round!.round} was made against an earlier version of the spec; run a new round.`);
        if (challenge.status === "none") return block("spec_challenge_incomplete", "project.json requires a spec challenge and there is none yet.");
        if (challenge.status === "open") return block("spec_challenge_incomplete", `Challenge round ${challenge.round!.round} has ${challenge.unresolved} unresolved concern(s).`);
        if (!challenge.round!.agent.ran || challenge.round!.agent.note) return block("spec_challenge_incomplete", "The required challenge needs the agent's concerns, and in this round the agent did not finish or its output did not parse; run a new round.");
      }
      const receipt: Approval = {
        schema: SCHEMA_VERSIONS.APPROVAL,
        id: newId("apv"),
        subject: "spec",
        ...(challenge.round ? { challenge: { round: challenge.round.round, status: challenge.status as "open" | "complete" | "stale", concerns: challenge.round.concerns.length, unresolved: challenge.unresolved, agentRan: challenge.round.agent.ran && !challenge.round.agent.note } } : {}),
        subjectId: spec.id,
        fingerprints,
        decidedBy: owner,
        decidedAt: new Date().toISOString(),
        source: ctx.isTTY ? "tty" : "piped",
        idempotencyKey,
      };
      const path = await ws.approvals.record(receipt, held);
      await ws.audit.append(
        {
          type: "spec_approved",
          specId: spec.id,
          approvalId: receipt.id,
          fingerprints,
          decidedBy: owner.id,
          source: receipt.source,
        },
        held
      );

      const after = await ws.project.load();
      const phase = phaseOf(after);
      return envelope(
        "approve",
        "ok",
        phase,
        [
          { code: "spec_approved", severity: "info", message: `Approved spec ${spec.id} as ${owner.id} (${receipt.source}); receipt ${receipt.id}.`, path },
          { code: "spec_fingerprint", severity: "info", message: `Fingerprint ${spec.fingerprint}` },
          ...phaseReasonDiagnostics(after),
        ],
        nextActionFor(phase)
      );
    }, "approve spec");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("approve", ws, err);
    throw err;
  }
};

async function approvePlan(
  ctx: Parameters<CommandHandler<ApproveOptions>>[0],
  project: Extract<LoadProjectResult, { kind: "valid" }>,
  owner: Extract<LoadProjectResult, { kind: "valid" }>["config"]["decisionOwners"][number],
  checks: string[],
  held: Parameters<Workspace["approvals"]["record"]>[1]
): Promise<ResultEnvelope> {
  const ws = ctx.workspace;

  if (!["spec_frozen", "planning", "plan_ready"].includes(project.phase)) {
    return envelope(
      "approve",
      "refused",
      project.phase,
      [
        { code: "spec_not_frozen", severity: "error", message: `A plan is approved against a frozen spec; the project is at ${project.phase}.`, hint: "Approve the current spec first." },
        ...phaseReasonDiagnostics(project),
      ],
      nextActionFor(project.phase)
    );
  }

  const planId = project.config.current?.planId;
  const plan = planId ? await ws.plans.load(planId) : null;
  if (!plan || plan.kind === "absent") {
    return envelope(
      "approve",
      "refused",
      project.phase,
      [{ code: "no_current_plan", severity: "error", message: "There is no current plan to approve.", hint: "Run 'legion-flow plan --new' first." }, ...phaseReasonDiagnostics(project)],
      nextActionFor(project.phase)
    );
  }
  if (plan.kind === "invalid") {
    return envelope(
      "approve",
      "refused",
      project.phase,
      [{ code: "plan_invalid", severity: "error", message: `plan ${planId} is ${plan.cause.replace("_", " ")}: ${plan.detail}`, path: plan.dir }],
      { type: "command", run: "legion-flow plan", hint: "Fix the plan before approving it." }
    );
  }

  const spec = await ws.specs.current();
  if (!spec || spec.kind !== "valid") {
    return envelope("approve", "refused", project.phase, [{ code: "no_current_spec", severity: "error", message: "No valid current spec." }], nextActionFor(project.phase));
  }
  if (plan.plan.specFingerprint !== spec.fingerprint) {
    return envelope(
      "approve",
      "refused",
      project.phase,
      [
        {
          code: "plan_spec_drift",
          severity: "error",
          message: `plan ${plan.id} was written against spec fingerprint ${plan.plan.specFingerprint}; the frozen spec is ${spec.fingerprint}.`,
          path: plan.dir,
          hint: "Re-plan against the current spec, or set specFingerprint deliberately after reviewing the change.",
        },
      ],
      nextActionFor(project.phase)
    );
  }

  const validation = validatePlanAgainstSpec(plan.plan, spec.spec, { members: memberIds(project.config.coordinator), mcpServers: (project.config.mcpServers ?? []).map((s) => s.name) });
  if (validation.errors.length > 0) {
    return envelope(
      "approve",
      "refused",
      project.phase,
      [
        ...validation.errors.map((e) => ({ code: e.code, severity: "error" as const, message: e.message, path: plan.dir })),
        ...validation.warnings.map((w) => ({ code: w.code, severity: "warning" as const, message: w.message })),
      ],
      { type: "command", run: "legion-flow plan", hint: `Fix plan.json. ${TASK_SHAPE_HINT}` }
    );
  }

  // Browser checks: each script must load and pass the safety rule now, and its hash is frozen into the receipt.
  const browserChecks = [...new Set([...plan.plan.tasks.flatMap((t) => t.contract.verificationCommands), ...checks].filter((c) => c.startsWith("browser:")).map((c) => c.slice("browser:".length).trim()))].sort();
  const browserScripts: Record<string, string> = {};
  const scriptProblems: Diagnostic[] = [];
  for (const rel of browserChecks) {
    const loaded = loadScript(ws.root, rel);
    if (loaded.ok) browserScripts[rel] = loaded.sha256;
    else scriptProblems.push({ code: /secret/.test(loaded.reason) || /allowedDomains/.test(loaded.reason) ? "browser_script_unsafe" : "browser_script_invalid", severity: "error", message: loaded.reason });
  }
  if (scriptProblems.length > 0) {
    return envelope("approve", "refused", project.phase, scriptProblems, { type: "command", run: "legion-flow browse <script>", hint: "Fix the browser script (a secret needs exact allowedDomains), then approve again." });
  }
  const fingerprints = { spec: spec.fingerprint, plan: plan.fingerprint, config: configFingerprint(project.config) };
  const sameScripts = (r: Approval) => JSON.stringify(r.browserScripts ?? {}) === JSON.stringify(browserScripts);
  const existing = (await ws.approvals.forSubject("plan", plan.id)).find(
    (r) => r.fingerprints.plan === fingerprints.plan && r.fingerprints.spec === fingerprints.spec && r.fingerprints.config === fingerprints.config && sameScripts(r)
  );
  if (existing) {
    return envelope(
      "approve",
      "ok",
      "plan_ready",
      [
        {
          code: "approval_unchanged",
          severity: "info",
          message: `plan ${plan.id} is already approved at this fingerprint by ${existing.decidedBy.id} (${existing.id}) with checks [${(existing.checks ?? []).join(", ")}]; nothing written.`,
        },
        ...validation.warnings.map((w) => ({ code: w.code, severity: "warning" as const, message: w.message })),
      ],
      nextActionFor("plan_ready")
    );
  }

  const receipt: Approval = {
    schema: SCHEMA_VERSIONS.APPROVAL,
    id: newId("apv"),
    subject: "plan",
    subjectId: plan.id,
    fingerprints,
    checks,
    ...(browserChecks.length ? { browserScripts } : {}),
    decidedBy: owner,
    decidedAt: new Date().toISOString(),
    source: ctx.isTTY ? "tty" : "piped",
    idempotencyKey: `${project.config.id}:${plan.id}:approve.plan:${plan.fingerprint}${browserChecks.length ? `:${Object.values(browserScripts).join(",").slice(0, 64)}` : ""}`,
  };
  const path = await ws.approvals.record(receipt, held);
  await ws.audit.append(
    { type: "plan_approved", planId: plan.id, approvalId: receipt.id, fingerprints, checks, decidedBy: owner.id, source: receipt.source },
    held
  );

  const after = await ws.project.load();
  const phase = phaseOf(after);
  return envelope(
    "approve",
    "ok",
    phase,
    [
      { code: "plan_approved", severity: "info", message: `Approved plan ${plan.id} as ${owner.id} (${receipt.source}); receipt ${receipt.id}; ${checks.length} check(s) frozen.`, path },
      { code: "plan_fingerprint", severity: "info", message: `Fingerprint ${plan.fingerprint}` },
      ...validation.warnings.map((w) => ({ code: w.code, severity: "warning" as const, message: w.message })),
      ...phaseReasonDiagnostics(after),
    ],
    nextActionFor(phase)
  );
}

// ---------------------------------------------------------------------------
// ship
// ---------------------------------------------------------------------------

export interface ShipOptions {
  commit?: boolean;
  approver?: string;
  waive?: string[];
  /** Write a bundle of this evaluation (or of --release) to this directory (M4 slice h). */
  bundle?: string;
  /** Re-export a past release's evaluation instead of evaluating now. */
  release?: string;
  /** Sign the bundle with --key, as --approver, on a terminal. */
  sign?: boolean;
  key?: string;
  /** Verify a bundle directory; reads nothing else. */
  verify?: string;
  /** With --verify: the signer's SPKI PEM public key, from outside the bundle. */
  pubkey?: string;
  /** Test seam: the passphrase reader for an encrypted key. */
  readPassphrase?: () => Promise<Buffer>;
}

/**
 * Bare ship evaluates and writes a run: `ready` when every required gate is
 * satisfied or waived, `blocked` otherwise. `--commit` evaluates and, if ready,
 * records a release in the same locked pass. Both --commit and --waive need a
 * decision owner.
 */
export const shipCommand: CommandHandler<ShipOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const waiveSpecs = opts.waive ?? [];
  const usage = async (code: string, message: string, run = "legion-flow ship --bundle <dir>") => envelope("ship", "usage_error", phaseOf(await ws.project.load()), [{ code, severity: "error", message }], { type: "command", run });

  // --verify reads only the bundle: no lock, no project.
  if (opts.verify !== undefined) {
    if (opts.commit || waiveSpecs.length || opts.bundle !== undefined || opts.release !== undefined || opts.sign || opts.key !== undefined || opts.approver !== undefined) return usage("verify_alone", "--verify takes only a bundle directory and, optionally, --pubkey.", "legion-flow ship --verify <dir> --pubkey <public.pem>");
    const phase = phaseOf(await ws.project.load());
    const checked = await verifyBundleAt(ctx.cwd, opts.verify, opts.pubkey);
    if (!checked.ok) return envelope("ship", "refused", phase, [{ code: checked.refusal.code, severity: "error", message: checked.refusal.message, ...(checked.refusal.hint ? { hint: checked.refusal.hint } : {}) }], nextActionFor(phase));
    const r = checked.result;
    const diagnostics: Diagnostic[] = [
      { code: "bundle_integrity", severity: r.integrity === "valid" ? "info" : "error", message: `Integrity ${r.integrity}${r.manifest ? `: evaluation ${r.manifest.runId}${r.manifest.releaseId ? `, release ${r.manifest.releaseId}` : ""}, ${r.manifest.members.length} member(s), ${r.manifest.ready ? "ready" : "not ready"} at ${r.manifest.riskTier}` : ""}.` },
      { code: "bundle_authenticity", severity: r.authenticity === "invalid" ? "error" : r.authenticity === "verified" ? "info" : "warning", message: r.authenticity === "verified" ? `Signature verified with key ${r.keyId!.slice(0, 16)}; it authenticates these bytes, not their truth.` : r.authenticity === "invalid" ? "The signature does not hold for the key given." : r.signed ? "Signed, but no --pubkey was given, so the signature is not verified." : "Not signed." },
      ...r.problems.slice(0, 20).map((message) => ({ code: "bundle_problem", severity: "error" as const, message })),
    ];
    return envelope("ship", r.passed ? "ok" : "blocked", phase, diagnostics, r.passed || !r.signed || opts.pubkey !== undefined ? nextActionFor(phase) : { type: "command", run: `legion-flow ship --verify ${opts.verify} --pubkey <public.pem>` }, r.verdicts);
  }
  if (opts.pubkey !== undefined) return usage("pubkey_needs_verify", "--pubkey applies to --verify only.", "legion-flow ship --verify <dir> --pubkey <public.pem>");
  if (opts.release !== undefined && opts.bundle === undefined) return usage("release_needs_bundle", "--release re-exports a past release's evaluation; it needs --bundle <dir>.");
  if (opts.release !== undefined && (opts.commit || waiveSpecs.length)) return usage("release_alone", "--release bundles a past evaluation; it does not combine with --commit or --waive.");
  if (opts.sign && (opts.bundle === undefined || opts.key === undefined)) return usage("sign_needs_bundle_and_key", "--sign needs --bundle <dir> and --key <private.pem>.", "legion-flow ship --bundle <dir> --sign --key <private.pem> --approver <id>");
  if (opts.key !== undefined && !opts.sign) return usage("key_needs_sign", "--key applies to --sign only.", "legion-flow ship --bundle <dir> --sign --key <private.pem> --approver <id>");

  if ((opts.commit || waiveSpecs.length > 0 || opts.sign) && !opts.approver) {
    return envelope("ship", "usage_error", phaseOf(await ws.project.load()), [
      { code: "approver_required", severity: "error", message: "--commit, --waive, and --sign need --approver <id>, a decision owner of this project." },
    ], { type: "command", run: "legion-flow ship --commit --approver <id>" });
  }
  const refusalOf = async (r: Refusal) => envelope("ship", "refused", phaseOf(await ws.project.load()), [{ code: r.code, severity: "error", message: r.message, ...(r.hint ? { hint: r.hint } : {}) }], nextActionFor(phaseOf(await ws.project.load())));
  if (opts.sign && !ctx.isTTY) return refusalOf({ code: "signing_requires_tty", message: "Signing is a human act and runs only on a terminal." });
  if (opts.bundle !== undefined) {
    const where = await bundleDestinationProblem(ws, ctx.cwd, opts.bundle);
    if (where) return refusalOf(where);
  }
  let signingKey: { key: import("node:crypto").KeyObject; publicKey: import("node:crypto").KeyObject } | null = null;
  if (opts.sign) {
    const loaded = await loadSigningKey(ws, ctx.cwd, opts.key!, ctx.isTTY, opts.readPassphrase ?? readPassphraseFromTty);
    if (!loaded.ok) return refusalOf(loaded.refusal);
    signingKey = loaded;
  }
  const bundleDest = opts.bundle !== undefined ? resolvePath(ctx.cwd, opts.bundle) : undefined;

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("ship", project);

      let owner: Extract<LoadProjectResult, { kind: "valid" }>["config"]["decisionOwners"][number] | undefined;
      const signer = () => (signingKey && owner ? { key: signingKey.key, publicKey: signingKey.publicKey, signerId: owner.id } : undefined);
      // Write the bundle last, after every audit event it should contain; it never changes the status.
      const withBundle = async (status: ResultEnvelope["status"], phase: Phase, diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], gates: ResultEnvelope["gates"], runId: string, releaseId?: string) => {
        if (!bundleDest) return envelope("ship", status, phase, diagnostics, next, gates);
        const s = signer();
        const written = await writeBundleFor(ws, held, { runId, ...(releaseId ? { releaseId } : {}), dest: bundleDest, ...(s ? { signer: s } : {}) });
        if (!written.ok) return envelope("ship", "refused", phase, [...diagnostics, { code: written.refusal.code, severity: "error", message: written.refusal.message }], next, gates);
        return envelope("ship", status, phase, [...diagnostics, ...written.diagnostics], next, gates);
      };
      if (opts.approver) {
        owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
        if (!owner) {
          return envelope("ship", "refused", project.phase, [
            {
              code: "approver_not_decision_owner",
              severity: "error",
              message: `'${opts.approver}' is not a decision owner of this project (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`,
            },
          ], nextActionFor(project.phase));
        }
      }

      if (opts.release !== undefined) {
        const release = (await ws.releases.list()).find((r) => r.id === opts.release);
        if (!release) return envelope("ship", "refused", project.phase, [{ code: "release_unknown", severity: "error", message: `No release '${opts.release}' exists.` }], nextActionFor(project.phase));
        return withBundle("ok", project.phase, [{ code: "ship_release", severity: "info", message: `Re-exporting release ${release.id} (evaluation ${release.runId}, shipped by ${release.decidedBy.id}); nothing is evaluated.` }], nextActionFor(project.phase), [], release.runId, release.id);
      }

      const tier = project.config.defaultRiskTier;
      const waivers: WaiverInput[] = [];
      const waiverErrors: Diagnostic[] = [];
      for (const spec of waiveSpecs) {
        const parsed = parseWaiver(spec, tier, { architectureRules: Boolean(rulesOf(project.config)) });
        if (parsed.ok) waivers.push({ gateId: parsed.gateId, reason: parsed.reason, waivedBy: owner!.id });
        else waiverErrors.push({ code: parsed.code, severity: "error", message: parsed.message });
      }
      if (waiverErrors.length > 0) {
        return envelope("ship", "usage_error", project.phase, waiverErrors, { type: "command", run: 'legion-flow ship --waive "<gateId>: <reason>" --approver <id>' });
      }

      const result = await evaluateShip(ws, held, { waivers });
      if (result.kind === "nothing_to_ship") {
        return envelope(
          "ship",
          "refused",
          project.phase,
          [{ code: result.code, severity: "error", message: result.message }, ...phaseReasonDiagnostics(project)],
          nextActionFor(project.phase)
        );
      }
      const ev = result.evaluation;
      const diagnostics: Diagnostic[] = [
        { code: "ship_run", severity: "info", message: `Ship evaluation ${ev.runId} at tier ${ev.tier}: ${ev.required.length} required gate(s).`, path: ev.runDir },
        ...ev.unusedWaivers.map((w) => ({ code: "waiver_unused" as const, severity: "warning" as const, message: `Waiver for ${w.gateId} was not needed; the gate is satisfied.` })),
      ];
      await ws.audit.append(
        { type: "ship_evaluated", runId: ev.runId, tier: ev.tier, ready: ev.ready, verdicts: Object.fromEntries(ev.verdicts.map((v) => [v.gateId, v.status])), waived: ev.verdicts.filter((v) => v.waiver).map((v) => v.gateId) },
        held
      );

      if (!ev.ready) {
        const after = await ws.project.load();
        const blocking = ev.verdicts.filter((v) => v.status !== "satisfied" && !v.waiver);
        diagnostics.push({
          code: "ship_blocked",
          severity: "error",
          message: `${blocking.length} required gate(s) neither satisfied nor waived: ${blocking.map((v) => `${v.gateId} (${v.status})`).join(", ")}.`,
          hint: "Blocked is the product. Resolve the gates above, or waive with a named reason where that is honest.",
        });
        return withBundle("blocked", phaseOf(after), [...diagnostics, ...phaseReasonDiagnostics(after)], nextActionFor(phaseOf(after)), ev.verdicts, ev.runId);
      }

      if (!opts.commit) {
        const after = await ws.project.load();
        return withBundle("ready", phaseOf(after), [...diagnostics, ...phaseReasonDiagnostics(after)], nextActionFor(phaseOf(after)), ev.verdicts, ev.runId);
      }

      const release = {
        schema: SCHEMA_VERSIONS.RELEASE,
        id: newId("rel"),
        runId: ev.runId,
        fingerprints: ev.fingerprints,
        decidedBy: owner!,
        decidedAt: new Date().toISOString(),
        source: (ctx.isTTY ? "tty" : "piped") as "tty" | "piped",
        idempotencyKey: `${project.config.id}:${ev.fingerprints.plan}:ship`,
      };
      const existing = (await ws.releases.list()).find(
        (r) => r.fingerprints.spec === ev.fingerprints.spec && r.fingerprints.plan === ev.fingerprints.plan && r.fingerprints.config === ev.fingerprints.config
      );
      if (existing) {
        diagnostics.push({ code: "release_unchanged", severity: "info", message: `Already shipped as ${existing.id} by ${existing.decidedBy.id}; nothing written.` });
        return withBundle("ok", "shipped", diagnostics, nextActionFor("shipped"), ev.verdicts, ev.runId);
      }
      const path = await ws.releases.record(release, held);
      await ws.audit.append({ type: "shipped", releaseId: release.id, runId: ev.runId, fingerprints: ev.fingerprints, decidedBy: owner!.id, source: release.source }, held);
      const after = await ws.project.load();
      diagnostics.push({ code: "shipped", severity: "info", message: `Shipped as ${release.id} by ${owner!.id} (${release.source}), evaluation ${ev.runId}.`, path });
      return withBundle("ok", phaseOf(after), [...diagnostics, ...phaseReasonDiagnostics(after)], nextActionFor(phaseOf(after)), ev.verdicts, ev.runId, release.id);
    }, opts.commit ? "ship --commit" : "ship");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("ship", ws, err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export interface DecideOptions {
  interruptId: string;
  approve?: boolean;
  reject?: boolean;
  edit?: string;
  approver: string;
  note?: string;
  /** Test seam for expiry. */
  now?: Date;
}

/**
 * Record a human decision on a pending interrupt. Compare-and-set against
 * `pending`; the decision file is written before the interrupt's status, so the
 * decision is the authority if the second write never happens. Resuming the
 * workflow is the engine's job: `legion-flow execute --resume` re-enters the run.
 */
export const decideCommand: CommandHandler<DecideOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  const chosen = [opts.approve ? "approve" : null, opts.reject ? "reject" : null, opts.edit !== undefined ? "edit" : null].filter(Boolean) as Decision["decision"][];

  if (chosen.length === 0) {
    return envelope("decide", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "decision_required", severity: "error", message: "decide needs exactly one of --approve, --reject, or --edit <json>." },
    ], { type: "command", run: `legion-flow decide ${opts.interruptId} --approve --approver <id>` });
  }
  if (chosen.length > 1) {
    return envelope("decide", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "decision_ambiguous", severity: "error", message: `decide got ${chosen.join(" and ")}; pass exactly one.` },
    ], { type: "command", run: `legion-flow decide ${opts.interruptId} --approve --approver <id>` });
  }
  const decision = chosen[0]!;
  let editedArgs: Record<string, unknown> | null = null;
  if (decision === "edit") {
    try {
      const parsed: unknown = JSON.parse(opts.edit!);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      editedArgs = parsed as Record<string, unknown>;
    } catch (err: unknown) {
      return envelope("decide", "usage_error", phaseOf(await ws.project.load(now)), [
        { code: "edit_not_object", severity: "error", message: `--edit must be a JSON object: ${(err as Error).message}` },
      ], { type: "command", run: `legion-flow decide ${opts.interruptId} --edit '{"...": "..."}' --approver <id>` });
    }
  }

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load(now);
      if (project.kind !== "valid") return projectUnusableRefusal("decide", project);

      const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
      if (!owner) {
        return envelope("decide", "refused", project.phase, [
          {
            code: "approver_not_decision_owner",
            severity: "error",
            message: `'${opts.approver}' is not a decision owner of this project (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`,
          },
        ], nextActionFor(project.phase));
      }

      const li = await ws.interrupts.find(opts.interruptId, now);
      if (!li) {
        return envelope("decide", "refused", project.phase, [
          { code: "interrupt_not_found", severity: "error", message: `No interrupt ${opts.interruptId} exists in any run of this project.` },
        ], nextActionFor(project.phase));
      }
      if (li.decision) {
        const same = li.decision.decision === decision && JSON.stringify(li.decision.editedArgs) === JSON.stringify(editedArgs);
        return envelope("decide", same ? "ok" : "refused", project.phase, [
          {
            code: same ? "decision_unchanged" : "interrupt_not_pending",
            severity: same ? "info" : "error",
            message: `${opts.interruptId} was already decided (${li.decision.decision}) by ${li.decision.decidedBy.id} at ${li.decision.decidedAt}.`,
            path: li.decisionPath,
          },
        ], nextActionFor(project.phase));
      }
      if (li.effectiveStatus === "expired") {
        await ws.interrupts.update(li.runId, li.interrupt.id, { status: "expired" }, held);
        await ws.audit.append({ type: "interrupt_expired", runId: li.runId, interruptId: li.interrupt.id, expiresAt: li.interrupt.expiresAt, onTimeout: li.interrupt.onTimeout }, held);
        return envelope("decide", "refused", project.phase, [
          {
            code: "interrupt_expired",
            severity: "error",
            message: `${opts.interruptId} expired at ${li.interrupt.expiresAt}; its onTimeout is '${li.interrupt.onTimeout}' and applies when the run resumes.`,
            path: li.path,
          },
        ], nextActionFor(project.phase));
      }
      if (li.effectiveStatus !== "pending") {
        return envelope("decide", "refused", project.phase, [
          { code: "interrupt_not_pending", severity: "error", message: `${opts.interruptId} is ${li.effectiveStatus}, not pending.`, path: li.path },
        ], nextActionFor(project.phase));
      }
      if (decision === "edit" && li.interrupt.action.name === SUPERSEDE_ACTION) {
        return envelope("decide", "refused", project.phase, [
          { code: "edit_not_supported", severity: "error", message: `${SUPERSEDE_ACTION} cannot be edited: a fact is a statement, not an argument.`, hint: "Reject it with --reject and learn the corrected fact, or approve it as proposed." },
        ], nextActionFor(project.phase));
      }
      if (decision === "edit" && li.interrupt.action.name === OBSERVE_ACTION && !ObservationEditSchema.safeParse(editedArgs).success) {
        return envelope("decide", "refused", project.phase, [
          { code: "edit_invalid", severity: "error", message: `${OBSERVE_ACTION} may be edited only as {"name": "<at most 120 chars>", "summary": "<at most 2000 chars>"}: the words, never the members.` },
        ], nextActionFor(project.phase));
      }
      if (li.interrupt.action.name === CHOOSE_PROPOSAL_ACTION && decision !== "reject") {
        // The payload is { interruptId, payload: { candidates, recommendation } }; a choice names a member that produced a proposal.
        const wrapped = JSON.parse(await readFile(join(ws.paths.project, ...li.interrupt.payloadRef.path.split("/")), "utf8")) as { payload: { candidates: { member: { id: string }; hasProposal: boolean }[]; recommendation: string | null } };
        const choosable = wrapped.payload.candidates.filter((c) => c.hasProposal).map((c) => c.member.id);
        if (decision === "approve" && !wrapped.payload.recommendation) {
          return envelope("decide", "refused", project.phase, [{ code: "choice_required", severity: "error", message: `Nothing is recommended for ${li.interrupt.id}, so --approve has nothing to take; choose with --edit '{"member":"<id>"}' (one of ${choosable.join(", ")}) or --reject.` }], nextActionFor(project.phase));
        }
        const member = decision === "edit" ? (editedArgs as { member?: unknown } | null)?.member : undefined;
        if (decision === "edit" && (Object.keys(editedArgs ?? {}).length !== 1 || typeof member !== "string" || !choosable.includes(member))) {
          return envelope("decide", "refused", project.phase, [{ code: "edit_invalid", severity: "error", message: `${CHOOSE_PROPOSAL_ACTION} is edited only as {"member": "<id>"}, naming a member that produced a proposal: ${choosable.join(", ")}.` }], nextActionFor(project.phase));
        }
      }
      if (decision === "edit" && li.interrupt.action.name === APPLY_ACTION) {
        return envelope("decide", "refused", project.phase, [
          {
            code: "edit_not_supported",
            severity: "error",
            message: `${APPLY_ACTION} cannot be edited by hand: a proposal's file list is a reviewed change, not an argument.`,
            hint: `Reject it with --reject and re-run 'legion-flow execute', or approve it as proposed.`,
          },
        ], nextActionFor(project.phase));
      }

      const record: Decision = {
        schema: SCHEMA_VERSIONS.DECISION,
        interruptId: li.interrupt.id,
        expectedStatus: "pending",
        decision,
        editedArgs,
        note: opts.note?.trim() || `${decision} via legion-flow decide`,
        decidedBy: owner,
        decidedAt: now.toISOString(),
        source: ctx.isTTY ? "tty" : "piped",
        idempotencyKey: `${project.config.id}:${li.interrupt.id}:decide:${fingerprintRecord({ decision, editedArgs })}`,
      };
      const path = await ws.decisions.write(li.runId, record, held);
      await ws.interrupts.update(li.runId, li.interrupt.id, { status: decision === "reject" ? "rejected" : "approved" }, held);
      await ws.audit.append(
        { type: "decision_recorded", runId: li.runId, interruptId: li.interrupt.id, decision, decidedBy: owner.id, source: record.source, argsFingerprint: li.interrupt.action.argsFingerprint },
        held
      );

      const after = await ws.project.load(now);
      const phase = phaseOf(after);
      return envelope(
        "decide",
        "ok",
        phase,
        [
          { code: "decision_recorded", severity: "info", message: `Recorded ${decision} on ${li.interrupt.id} (${li.interrupt.action.name}) as ${owner.id} (${record.source}).`, path },
          { code: "resume_pending", severity: "info", message: `Run ${li.runId} resumes at the workflow's '${decision === "reject" ? li.interrupt.resume?.onReject ?? "end" : li.interrupt.resume?.onApprove ?? "?"}' node when re-entered.`, hint: `Next: legion-flow ${resumeVerbFor(li.interrupt.action.name)} --resume` },
          ...phaseReasonDiagnostics(after),
        ],
        nextActionFor(phase)
      );
    }, "decide");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("decide", ws, err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/** `learn`: record a structured fact, or open a supersession a human decides; `learn --resume` commits decided ones. */
export const learnCommand: CommandHandler<LearnOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = () => new Date();
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("learn", project);
      const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], runId?: string) => envelope("learn", status, phaseOf(await ws.project.load()), diagnostics, next, [], runId);
      return learnVerb(ws, ctx.isTTY, project.config, { ...opts, ...(typeof opts.supersedes === "string" ? { supersedes: [opts.supersedes] } : {}) }, env, held, now);
    }, opts.resume ? "learn --resume" : "learn");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("learn", ws, err);
    throw err;
  }
};

/** `hooks`: list the declared Optional CALL hooks, or consent to one or revoke it (M4 slice l). */
export const hooksCommand: CommandHandler<HooksOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("hooks", project);
      const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => envelope("hooks", status, phaseOf(await ws.project.load()), diagnostics, next);
      return hooksVerb(ws, ctx.isTTY, project.config, opts, env, held, async () => nextActionFor(phaseOf(await ws.project.load())));
    }, opts.enable ?? opts.disable ? "hooks --consent" : "hooks");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("hooks", ws, err);
    throw err;
  }
};

/** `observe`: list candidate observations, propose one for a decision, or commit decided ones (M4 slice i). */
export const observeCommand: CommandHandler<ObserveOptions & { sandbox?: string; allowNoSandbox?: boolean; adapterTimeoutMs?: number }> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = () => new Date();
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("observe", project);
      if (!opts.agent && (opts.sandbox !== undefined || opts.allowNoSandbox)) return envelope("observe", "usage_error", project.phase, [{ code: "observe_usage", severity: "error", message: "--sandbox and --allow-no-sandbox choose where the namer runs; they go with --agent." }], { type: "command", run: "legion-flow observe --propose <obc_id> --agent" });
      const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], runId?: string) => envelope("observe", status, phaseOf(await ws.project.load()), diagnostics, next, [], runId);
      // M4 slice p: the namer is a coordinator member (memory.observeNamer, else default), run in the tier the invoker chose.
      const suggest: ObservationSuggester = async (candidate, facts) => {
        const refuse = (code: string, message: string, hint?: string) => ({ envelope: refusal("observe", project, code, message, hint) });
        const routed = routeTask(project.config, { member: project.config.memory?.observeNamer ?? DEFAULT_MEMBER_ID, contract: { filesAllowed: [] } });
        if (!routed.ok) return refuse("delegation_rejected", `The observation namer: ${routed.reason}.`, "FIX: declare the member in project.json coordinator.members, or change memory.observeNamer.");
        const adapter = adapterFor(routed.member.adapter, project.config);
        if (!adapter) return refuse("adapter_unknown", `Adapter '${routed.member.adapter}' is not registered in this build.`);
        const tierId = (opts.sandbox ?? "vm-docker") as SandboxTierId;
        const prepared = await prepareTier(ctx, project, adapter, tierId, { ...(opts.allowNoSandbox ? { allowNoSandbox: true } : {}) }, "observe", "namer");
        if (!prepared.ok) return { envelope: prepared.envelope };
        const preflighted = await preflightTier(ws, project, prepared.tier, "observe");
        if (!preflighted.ok) return { envelope: preflighted.envelope };
        const t = prepared.tier;
        const model = routed.member.model ?? project.config.adapter.http?.model;
        const result = await runWorkflow(ws, observationNamingWorkflow({ ws, materializer: createMaterializer({ tier: t.tierId, strategy: "copy", paths: ws.paths, runId: "pending", settings: t.dockerSettings, docker: realDockerCli, routes: t.routes, egressDistDir: egressDistDir(), secrets: t.secrets, now })!, adapter, ...(opts.adapterTimeoutMs ? { adapterTimeoutMs: opts.adapterTimeoutMs } : {}), envMode: t.report.isSandbox ? "container" : "host", tierEvidence: preflighted.tierEvidence, redactValues: [...(adapter.credential && process.env[adapter.credential.env] ? [process.env[adapter.credential.env]!] : []), ...Object.values(t.secrets)] }), held, {
          input: { workspaceRoot: ws.root, candidateId: candidate.id, template: { name: candidate.name, summary: candidate.summary }, facts: facts.map((f) => ({ id: f.id, subject: f.subject, predicate: f.predicate, object: "ref" in f.object ? f.object.ref : f.object.text, origin: f.origin, validAt: f.validAt })), ...(model ? { model } : {}) } as unknown as Record<string, unknown>,
          durability: "sync",
          now,
        });
        if (result.kind !== "complete") return { note: `the naming run ended ${result.kind}`, ...(result.runId ? { runId: result.runId } : {}) };
        const naming = result.values.naming as NamingResult;
        return naming.suggestion ? { suggestion: { ...naming.suggestion, by: { adapter: adapter.id, ...(model ? { model } : {}), runId: result.runId } }, runId: result.runId } : { note: naming.note ?? "no suggestion", runId: result.runId };
      };
      return observeVerb(ws, opts, env, held, now, async () => nextActionFor(phaseOf(await ws.project.load())), suggest);
    }, opts.resume ? "observe --resume" : "observe");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("observe", ws, err);
    throw err;
  }
};

/**
 * `browse <script>`: run a browser script once against the checkout while writing it. A dry run: the script is
 * not approved, so this never counts as a check; the record is written under var/cache/browser/.
 */
export const browseCommand: CommandHandler<{ script?: string }> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const project = await ws.project.load();
  if (project.kind !== "valid") return projectUnusableRefusal("browse", project);
  const phase = phaseOf(project);
  if (!opts.script) return envelope("browse", "usage_error", phase, [{ code: "browse_usage", severity: "error", message: "browse needs a script path, relative to the project root." }], { type: "command", run: "legion-flow browse checks/login.json" });
  const loaded = loadScript(ws.root, opts.script);
  if (!loaded.ok) return envelope("browse", "refused", phase, [{ code: "browser_script_invalid", severity: "error", message: loaded.reason }], nextActionFor(phase));
  const r = await runBrowserCheck(opts.script, { cwd: ws.root, expectedSha256: loaded.sha256 });
  const bytes = JSON.stringify({ status: r.status, reason: r.reason, record: r.record }, null, 2) + "\n";
  const dir = join(ws.paths.varDir, "cache", "browser");
  const path = join(dir, `browse-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.json`);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(path, bytes);
  const diagnostics: Diagnostic[] = [
    { code: "browse_dry_run", severity: "info", message: "Dry run: this script is not approved, so this result never counts as a check; approve plan freezes its hash.", path },
    ...r.summary.map((line) => ({ code: "browse_step", severity: line.startsWith("FAIL") ? ("error" as const) : ("info" as const), message: line })),
    ...(r.record.blocked.length ? [{ code: "browse_blocked", severity: "info" as const, message: `${r.record.blocked.length} request(s) outside allowedDomains were blocked: ${r.record.blocked.slice(0, 5).map((b) => b.url).join(", ")}` }] : []),
  ];
  return envelope("browse", r.status === "satisfied" ? "ok" : "blocked", phase, diagnostics, r.status === "satisfied" ? nextActionFor(phase) : { type: "command", run: `legion-flow browse ${opts.script}`, hint: "Fix the script or the app, then run it again." });
};

/** `tools`: probe declared MCP servers; the SDK loads only here (dynamic import), like `mcp`. */
export const toolsCommand: CommandHandler<{ server?: string; sandbox?: string; allowNoSandbox?: boolean }> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const project = await ws.project.load();
  if (project.kind !== "valid") return projectUnusableRefusal("tools", project);
  const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => envelope("tools", status, phaseOf(await ws.project.load()), diagnostics, next);
  const { toolsVerb } = await import("./mcp-client.js");
  return toolsVerb(ws, project.config.mcpServers ?? [], opts, { isTTY: ctx.isTTY, dockerSettings: resolveDockerSettings(project.config.sandbox), clientVersion: CLI_VERSION, ...(project.config.sandbox?.require ? { requireSandbox: true } : {}) }, env, async () => (await statusEnvelope(ctx, "status")).nextAction);
};

/** `recall`: read-only, never takes the lock. */
export const recallCommand: CommandHandler<RecallOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const project = await ws.project.load();
  if (project.kind !== "valid") return projectUnusableRefusal("recall", project);
  const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => envelope("recall", status, phaseOf(await ws.project.load()), diagnostics, next);
  return recallVerb(ws, opts, env, async () => (await statusEnvelope(ctx, "status")).nextAction);
};

/** `retro`: one release's deterministic facts, written once. */
export const retroCommand: CommandHandler<{ release?: string }> = async (ctx, opts) => {
  const ws = ctx.workspace;
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load();
      if (project.kind !== "valid") return projectUnusableRefusal("retro", project);
      const env = async (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"], runId?: string) => envelope("retro", status, phaseOf(await ws.project.load()), diagnostics, next, [], runId);
      return retroVerb(ws, opts, env, held, () => new Date());
    }, "retro");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("retro", ws, err);
    throw err;
  }
};

/** The verb that resumes a workflow after its interrupt is decided. */
function resumeVerbFor(action: string): "learn" | "observe" | "execute" {
  return action === SUPERSEDE_ACTION ? "learn" : action === OBSERVE_ACTION ? "observe" : "execute";
}

/**
 * Memory workflows (supersession and observation) are outside the lifecycle
 * phases, so status looks for them itself: a pending one is the next human
 * decision, and a decided (or expired) one points at its own `--resume`.
 */
async function openMemoryRuns(ws: Workspace): Promise<{ pending?: LoadedInterrupt; decided?: { id: string; action: string } }> {
  const out: { pending?: LoadedInterrupt; decided?: { id: string; action: string } } = {};
  for (const r of await ws.runs.list()) {
    if (r.run.kind !== "workflow" || (r.run.workflowId !== SUPERSEDE_WORKFLOW_ID && r.run.workflowId !== OBSERVE_WORKFLOW_ID) || (r.run.status !== "running" && r.run.status !== "awaiting_decision")) continue;
    const open = (await ws.interrupts.list(r.run.id)).find((i) => !i.interrupt.consumedAt && i.effectiveStatus !== "cancelled");
    if (!open) continue;
    if (open.effectiveStatus === "pending") out.pending ??= open;
    else out.decided ??= { id: open.interrupt.id, action: open.interrupt.action.name };
  }
  return out;
}

/**
 * Refresh the code map before a run, under the run's lock: a new snapshot only
 * when the facts changed. A failure never stops the run; the brief then says
 * the map is absent and the gate stays unevaluable.
 */
async function refreshMapFor(ws: Workspace, held: Parameters<typeof buildMap>[1], runner?: LanguageServerRunner): Promise<Diagnostic[]> {
  try {
    const built = await buildMap(ws, held, new Date(), runner ? { runner } : {});
    const partial = built.languages.filter((l) => l.partial).map((l) => ({ code: "map_language_partial", severity: "warning" as const, message: `Language server '${l.language}': ${l.partial}.` }));
    return [...(built.kind === "unchanged" ? [] : [{ code: "map_refreshed", severity: "info" as const, message: `Code map ${built.kind === "built" ? "recorded as" : "re-indexed from"} snapshot ${built.snapshot.id} before the run.` }]), ...partial];
  } catch (err: unknown) {
    return [{ code: "map_refresh_failed", severity: "warning", message: `The code map could not be refreshed (${(err as Error).message}); the brief carries no map context.` }];
  }
}

/** The rule violations a pending proposal introduces, as warnings on execute's envelope: nobody should have to open JSON to learn why R0 paused. */
async function architectureDiagnostics(ws: Workspace, payloadPath: string, rulesExist: boolean): Promise<Diagnostic[]> {
  try {
    // The interrupt payload file is { interruptId, payload } where payload is the proposal.
    const wrapped = JSON.parse(await readFile(join(ws.paths.project, ...payloadPath.split("/")), "utf8")) as { payload?: unknown };
    const proposal = ProposalSchema.parse(wrapped.payload);
    // The analysis always records impact when it ran; without it the analysis threw, and R0 paused for that reason.
    if (!proposal.impact || (rulesExist && !proposal.architecture)) {
      return [{ code: "architecture_check_failed", severity: "warning", message: "The map analysis could not run on this proposal, so it awaits a decision at any tier; an unknown is not a pass." }];
    }
    const introduced = proposal.architecture?.introduced ?? [];
    return introduced.slice(0, 10).map((v) => ({ code: "architecture_violation_introduced", severity: "warning" as const, message: `${v.rule}: ${v.from}${v.to ? ` -> ${v.to}` : v.specifier ? ` -> ${v.specifier}` : ""}: ${v.detail}.` }));
  } catch {
    return [];
  }
}

/**
 * Span evidence for one run, configured in one place for execute, review, and
 * eval: the optional loopback collector copy comes from project.json and the
 * shared loopback rule, so the three verbs cannot disagree about it.
 */
function tracingFor(ws: Workspace, held: Parameters<typeof createEvidenceTracing>[0]["held"], config: ValidProject["config"]): { factory: (runId: string) => ReturnType<typeof createEvidenceTracing>; diagnostics: () => Diagnostic[] } {
  const endpoint = config.evidence?.otlpEndpoint;
  const problem = endpoint ? loopbackUrlProblem(endpoint, "evidence.otlpEndpoint") : null;
  const otlpEndpoint = endpoint && !problem ? endpoint : undefined;
  const created: ReturnType<typeof createEvidenceTracing>[] = [];
  return {
    factory: (runId) => {
      const t = createEvidenceTracing({ ws, held, runId, serviceVersion: CLI_VERSION, ...(otlpEndpoint ? { otlpEndpoint } : {}) });
      created.push(t);
      return t;
    },
    /** Span warnings for the envelope: a failed collector copy, a refused endpoint, an unwritten record. None gates. */
    diagnostics: () => {
      const fanout = created.reduce((n, t) => n + t.exporter.fanoutFailures, 0);
      const failures = created.reduce((n, t) => n + t.exporter.failures, 0);
      const reason = created.flatMap((t) => t.exporter.fanoutReasons)[0];
      return [
      ...(fanout > 0
        ? [{ code: "span_fanout_failed", severity: "warning" as const, message: `${fanout} span record(s) did not reach the collector: ${reason}. The records in the run are the evidence; the copy never gates.` }]
        : []),
      ...(problem ? [{ code: "span_fanout_disabled", severity: "warning" as const, message: `${problem}; the span copy is off (a remote collector is egress)` }] : []),
      ...(failures > 0
        ? [{ code: "span_evidence_incomplete", severity: "warning" as const, message: `${failures} span record(s) could not be written; the run's journal and snapshots are unaffected.` }]
        : []),
      ];
    },
  };
}

/**
 * `map`: build the code map, or answer --deps, --impact, or --who-uses from it.
 * The map logic lives in map-command.ts; this handler supplies the phase and
 * the status next action, and turns a held lock into the usual refusal.
 */
export const mapCommand: CommandHandler<MapOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const env = async (command: string, status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) =>
    envelope(command, status, phaseOf(await ws.project.load()), diagnostics, next);
  const statusNext = async () => (await statusEnvelope(ctx, "status")).nextAction;
  const project = await ws.project.load();
  const config = project.kind === "valid" ? project.config : undefined;
  try {
    return await mapVerb(ws, opts, env, statusNext, config ? rulesOf(config) : undefined, {
      isTTY: ctx.isTTY,
      ...(config?.sandbox?.require ? { requireSandbox: true } : {}),
      servers: config ? serversOf(config) : [],
      runnerFor: (tier) => languageServerRunner({ tier, dockerSettings: resolveDockerSettings(config?.sandbox) }),
    });
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("map", ws, err);
    throw err;
  }
};


// ---------------------------------------------------------------------------
// shared sandbox preparation (execute and review)
// ---------------------------------------------------------------------------

type ValidProject = Extract<LoadProjectResult, { kind: "valid" }>;

function refusal(command: string, project: ValidProject, code: string, message: string, hint?: string): ResultEnvelope {
  return envelope(command, "refused", project.phase, [{ code, severity: "error", message, ...(hint ? { hint } : {}) }, ...phaseReasonDiagnostics(project)], nextActionFor(project.phase));
}

/**
 * The one place an adapter is built for a project (M4 slice y): a claude adapter takes `adapter.http` as its provider
 * when a base URL is set, so every verb (execute, review, spec --challenge, observe --agent, resume) runs the same route,
 * credential, and redaction list.
 */
function adapterFor(id: string, config: ValidProject["config"]) {
  const h = config.adapter.http;
  // The provider follows the project's default adapter (M4 slice aa): one base URL speaks one protocol, so another vendor keeps its own API.
  const applies = id === config.adapter.default && (id === "claude" || (id === "codex" && Boolean(h?.model))) && Boolean(h?.baseUrl && h.apiKeyEnv);
  return adapterById(id, applies ? { provider: { baseUrl: h!.baseUrl!, apiKeyEnv: h!.apiKeyEnv!, ...(h!.model ? { model: h!.model } : {}), ...(h!.contextWindow ? { contextWindow: h!.contextWindow } : {}) } } : {});
}

interface PreparedTier {
  /** The per-spawn sandbox verdict (M4 slice j1), recorded in the run's sandbox_tier evidence. */
  spawn: SpawnVerdict;
  tierId: SandboxTierId;
  adapter: Adapter;
  credentialDiagnostics: Diagnostic[];
  dockerSettings: DockerSettings;
  routes: EgressRoute[];
  secrets: Record<string, string>;
  report: EnforcementReport;
  strategy: MaterializeStrategy;
  sourceMode: TreeMode;
}

/**
 * Everything a tier needs before the adapter runs, minus the container probe:
 * availability, the adapter's credential pause, routes and secrets, the
 * enforcement report, the no-sandbox confirmation, and the tree strategy.
 * Shared by execute and review so the two can never disagree about a tier.
 */
async function prepareTier(
  ctx: Parameters<CommandHandler>[0],
  project: ValidProject,
  adapter: Adapter,
  tierId: SandboxTierId,
  opts: { allowNoSandbox?: boolean; materialize?: string },
  command: string,
  kind: SpawnKind = "adapter"
): Promise<{ ok: true; tier: PreparedTier } | { ok: false; envelope: ResultEnvelope }> {
  const ws = ctx.workspace;
  const refuse = (code: string, message: string, hint?: string) => ({ ok: false as const, envelope: refusal(command, project, code, message, hint) });
  const tierDef = SANDBOX_TIERS.find((t) => t.id === tierId);
  if (!tierDef?.available) {
    return refuse("sandbox_tier_unavailable", `Sandbox tier '${tierId}' is not available in this build (available: ${SANDBOX_TIERS.filter((t) => t.available).map((t) => t.id).join(", ")}).`, "FIX: use --sandbox vm-docker, or --sandbox unhardened --allow-no-sandbox on a terminal knowing it is not a sandbox.");
  }
  const definition = definitionOf(adapter);
  const credentialDiagnostics: Diagnostic[] = [];
  // codex with a provider needs a model (M4 slice aa): its catalog is keyed by it, and without one it would call its own vendor.
  const providerUrl = project.config.adapter.http?.baseUrl;
  if (providerUrl && adapter.id === "codex" && project.config.adapter.default === "codex" && !project.config.adapter.http?.model) {
    return refuse("adapter_provider_model_required", "project.json adapter.http.baseUrl names a provider for codex, and adapter.http.model is not set; codex's model catalog is keyed by the model.", "FIX: set adapter.http.model to the provider's model id (for example mimo-v2.6-pro).");
  }
  if (providerUrl && adapter.id === "fake") credentialDiagnostics.push({ code: "adapter_provider_ignored", severity: "info", message: "adapter.http.baseUrl is set, and the fake adapter calls no provider; it applies to claude runs." });
  if (definition?.provider) credentialDiagnostics.push({ code: "adapter_provider", severity: "info", message: `The ${adapter.id} adapter calls ${definition.route.scheme}://${definition.route.host}${definition.route.basePath ?? ""} with ${definition.credentialEnv} as a bearer token; cost is unknown (the CLI prices at its vendor's rates).` });
  if (adapter.credential) {
    const present = process.env[adapter.credential.env] !== undefined;
    if (!present && (tierId === "vm-docker" || definition?.provider)) {
      return {
        ok: false,
        envelope: envelope(command, "blocked", project.phase, [
          tierId === "vm-docker"
            ? { code: "credential_required", severity: "error", message: `The ${adapter.id} adapter needs ${adapter.credential.env} so the egress proxy can set it for the provider; it is not set in this environment. Nothing ran.`, hint: `FIX: set ${adapter.credential.env} in the environment that runs legion-flow; its value is passed to the proxy container only and never enters the agent or a record.` }
            // The host tier with a provider (M4 slice y): no proxy exists, and the CLI reads the value itself as its bearer token.
            : { code: "credential_required", severity: "error", message: `The ${adapter.id} adapter's provider needs ${adapter.credential.env}; on the ${tierId} tier the CLI reads it directly as its bearer token, and it is not set in this environment. Nothing ran.`, hint: `FIX: set ${adapter.credential.env} in the environment that runs legion-flow; on this tier its value enters the agent's environment as ANTHROPIC_AUTH_TOKEN, and it is never recorded.` },
          ...phaseReasonDiagnostics(project),
        ], { type: "credential_required", variable: adapter.credential.env, adapter: adapter.id, hint: `Set ${adapter.credential.env} and re-run legion-flow ${command}.` }),
      };
    }
    if (!present) {
      credentialDiagnostics.push({ code: "credential_vendor_auth", severity: "info", message: `${adapter.credential.env} is not set; on the ${tierId} tier the ${adapter.id} CLI relies on its own stored authentication.` });
    }
  }
  const dockerSettings = resolveDockerSettings(project.config.sandbox, process.platform, adapter.profile.image);
  let routes: EgressRoute[];
  try {
    routes = validateRoutes([...(tierId === "vm-docker" && definition ? [definition.route] : []), ...(project.config.egress?.routes ?? [])]);
  } catch (err: unknown) {
    return refuse("egress_route_conflict", (err as Error).message, "FIX: give every route under project.json egress.routes a distinct alias that does not collide with the adapter's own route.");
  }
  const secrets: Record<string, string> = {};
  const missingSecrets: string[] = [];
  for (const name of secretRefs(routes)) {
    const value = process.env[name];
    if (value === undefined) missingSecrets.push(name);
    else secrets[name] = value;
  }
  if (tierId === "vm-docker" && missingSecrets.length > 0) {
    return refuse("egress_secret_missing", `Egress route(s) reference ${missingSecrets.join(", ")}, which is not set in this environment; the proxy cannot start.`, `FIX: set ${missingSecrets.join(" and ")} in the environment that runs legion-flow (the value never enters the agent container).`);
  }
  const report = enforcementReport(tierId, dockerSettings, tierId === "vm-docker" ? routes : []);
  if (tierId === "vm-docker" && definition) {
    report.caveats.push("vendor permission prompts and the vendor sandbox are disabled inside the container; the container, the network, and the proposal are the boundary");
  }
  // The policy comes before consent: sandbox.require refuses the host tier whatever the operator confirms.
  const spawn = spawnAllowed({ kind, tier: tierId, hardened: report.isSandbox, require: project.config.sandbox?.require === true });
  if (!spawn.ok) return refuse(spawn.code, spawn.message, spawn.hint);
  if (!report.isSandbox) {
    if (!opts.allowNoSandbox) {
      return refuse("sandbox_not_hardened", `Tier '${tierId}' is not a sandbox: ${report.notEnforced.join("; ")}.`, "FIX: re-run with --allow-no-sandbox on a terminal to accept that, or use the default vm-docker tier.");
    }
    if (!ctx.isTTY) {
      return refuse("sandbox_confirmation_requires_tty", "--allow-no-sandbox is a human confirmation and is honored only on an interactive terminal.");
    }
  }
  const strategy = (opts.materialize ?? project.config.sandbox?.materialize ?? "copy") as MaterializeStrategy;
  const sourceMode = await detectTreeMode(ws.root);
  if (strategy === "worktree" && sourceMode !== "git") {
    return refuse("worktree_requires_git", "The worktree strategy needs the workspace to be the top level of a git repository without submodules.", "FIX: run without --materialize worktree (the copy strategy), or initialize a repository.");
  }
  return { ok: true, tier: { spawn: spawn.record, tierId, adapter, credentialDiagnostics, dockerSettings, routes, secrets, report, strategy, sourceMode } };
}

/** The browser container's image (M4 slice o2): the project's override, else the locally built one. */
function browserImageOf(config: ValidProject["config"]): string {
  return config.sandbox?.docker?.browserImage ?? browserImageTag();
}

/** Under vm-docker the gateway's browser server runs in its own container behind a forward proxy (M4 slice o2). */
async function openBrowserContainer(o: { session: BrowserSession; treeDir: string; runId: string; record: (rec: Record<string, unknown>) => Promise<void>; config: ValidProject["config"]; varDir: string }) {
  const { containerBrowserServer } = await import("./browser-container.js");
  const base = resolveDockerSettings(o.config.sandbox);
  return containerBrowserServer({ session: o.session, treeDir: o.treeDir, runId: o.runId, record: o.record, docker: realDockerCli, browserSettings: { ...base, image: browserImageOf(o.config) }, proxySettings: base, varDir: o.varDir, egressDistDir: egressDistDir(), clientVersion: CLI_VERSION });
}

/** The container probe, last among the preconditions because it starts a container. */
async function preflightTier(ws: Workspace, project: ValidProject, tier: PreparedTier, command: string): Promise<{ ok: true; tierEvidence: Record<string, unknown> } | { ok: false; envelope: ResultEnvelope }> {
  if (tier.tierId !== "vm-docker") return { ok: true, tierEvidence: { enforcement: tier.report, spawn: tier.spawn } };
  const imageBuild = tier.dockerSettings.image === agentImageTag() ? { dockerfile: agentDockerfile(), dockerfileDir: join(ws.paths.varDir, "images", "agent") } : undefined;
  const preflight = await dockerPreflight({ docker: realDockerCli, settings: tier.dockerSettings, paths: ws.paths, adaptersDir: adaptersDistDir(), probe: true, ...(imageBuild ? { imageBuild } : {}) });
  if (!preflight.ok) {
    return {
      ok: false,
      envelope: envelope(command, "refused", project.phase, [
        ...preflight.checks.filter((c) => c.status !== "pass").map((c) => ({ code: `sandbox_preflight_${c.id}`, severity: "error" as const, message: c.message, ...(c.fix ? { hint: c.fix } : {}) })),
        { code: "sandbox_preflight_failed", severity: "error", message: "The vm-docker tier did not pass preflight; nothing ran.", hint: "FIX: resolve the checks above, or run --sandbox unhardened --allow-no-sandbox on a terminal, knowing it is not a sandbox." },
        ...phaseReasonDiagnostics(project),
      ], nextActionFor(project.phase)),
    };
  }
  // Pin every container of this invocation to the Id preflight resolved: the agent, the egress proxy, each coordinate step and retry.
  // The tier object is shared through tierFor's cache, so setting it here reaches every spawn that follows.
  if (preflight.imageId) tier.dockerSettings = { ...tier.dockerSettings, imageId: preflight.imageId };
  return { ok: true, tierEvidence: { enforcement: tier.report, preflight, spawn: tier.spawn } };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  accept?: boolean;
  approver?: string;
  waive?: string;
  sandbox?: string;
  allowNoSandbox?: boolean;
  materialize?: string;
  resume?: boolean;
  /** Test seams. */
  now?: Date;
  adapterTimeoutMs?: number;
  installSignalHandlers?: boolean;
}

const identityOf = (adapter: string, model: string | undefined) => ({ adapter, model: model ?? `vendor-default:${adapter}` });

/**
 * An independent reviewer run against a disposable copy of the checkout, then
 * the human boundary: `review --accept --approver <id>` records a
 * content-bound receipt for the latest PASS at the current fingerprints.
 */
export const reviewCommand: CommandHandler<ReviewOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  if (opts.accept) {
    if (opts.waive || opts.resume || opts.allowNoSandbox || opts.materialize || (opts.sandbox !== undefined && opts.sandbox !== "vm-docker")) {
      return envelope("review", "usage_error", phaseOf(await ws.project.load(now)), [
        { code: "review_accept_exclusive", severity: "error", message: "--accept records a decision and takes only --approver; run options belong to a review run." },
      ], { type: "command", run: "legion-flow review --accept --approver <id>" });
    }
    return acceptReview(ctx, opts, now);
  }
  const tierId = (opts.sandbox ?? "vm-docker") as SandboxTierId;
  if (!(SANDBOX_TIER_IDS as readonly string[]).includes(tierId)) {
    return envelope("review", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "sandbox_tier_unknown", severity: "error", message: `'${opts.sandbox}' is not a sandbox tier (${SANDBOX_TIER_IDS.join(", ")}).` },
    ], { type: "command", run: "legion-flow review" });
  }
  if (opts.materialize !== undefined && !["copy", "worktree"].includes(opts.materialize)) {
    return envelope("review", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "materialize_unknown", severity: "error", message: `--materialize must be copy or worktree (got '${opts.materialize}').` },
    ], { type: "command", run: "legion-flow review --materialize copy" });
  }

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load(now);
      if (project.kind !== "valid") return projectUnusableRefusal("review", project);
      const refuse = (code: string, message: string, hint?: string) => refusal("review", project, code, message, hint);
      // The policy is a tier-level refusal, as in execute: it comes before anything about the plan.
      const policy = spawnAllowed({ kind: "reviewer", tier: tierId, hardened: tierId === "vm-docker", ...(project.config.sandbox?.require ? { require: true } : {}) });
      if (!policy.ok) return refuse(policy.code, policy.message, policy.hint);

      const spec = await ws.specs.current();
      const plan = await ws.plans.current();
      if (!spec || spec.kind !== "valid" || !plan || plan.kind !== "valid") return refuse("plan_not_approved", "A review needs an approved plan against a frozen spec; there is no valid current plan.");
      const config = configFingerprint(project.config);
      const planReceipt = (await ws.approvals.forSubject("plan", plan.id)).find((r) => r.fingerprints.plan === plan.fingerprint && r.fingerprints.spec === spec.fingerprint && r.fingerprints.config === config);
      if (!planReceipt) return refuse("plan_not_approved", "The current plan has no approval receipt at its current fingerprints.");

      const reviewCfg = project.config.review;
      if (!reviewCfg) return refuse("reviewer_unconfigured", "No reviewer is configured; reviewing with the executor would defeat the gate.", "FIX: set review.adapter (and review.model when it is the executor's adapter) in project.json, then approve the plan again.");
      const adapter = adapterFor(reviewCfg.adapter, project.config);
      if (!adapter) return refuse("adapter_unknown", `Reviewer adapter '${reviewCfg.adapter}' is not registered in this build (known: fake, claude, codex).`);
      // Every identity that wrote applied code in this plan (M4 slice j1: routed members too), plus the default executor.
      const writers = [identityOf(project.config.adapter.default, project.config.adapter.http?.model)];
      for (const r of await ws.runs.list()) {
        if (r.run.kind === "workflow" && r.run.task?.planId === plan.id && r.run.applied && r.run.member) writers.push(identityOf(r.run.member.adapter, r.run.member.model));
        if (r.run.kind === "workflow" && r.run.task?.planId === plan.id && r.run.applied && r.run.coordinate) for (const s of r.run.coordinate.steps) writers.push(identityOf(s.adapter, s.model));
        // A broadcast's applied code was written by the member a human chose (M4 slice j2).
        if (r.run.kind === "workflow" && r.run.workflowId === BROADCAST_WORKFLOW_ID && r.run.task?.planId === plan.id && r.run.applied) {
          const chosen = (await ws.runs.loadLatestSnapshot(r.run.id))?.values.chosenMember as RunMember | undefined;
          if (chosen) writers.push(identityOf(chosen.adapter, chosen.model));
        }
      }
      const reviewer = identityOf(reviewCfg.adapter, reviewCfg.model);
      const executor = writers.find((w) => w.adapter === reviewer.adapter && w.model === reviewer.model) ?? writers[0]!;
      const independent = !writers.some((w) => w.adapter === reviewer.adapter && w.model === reviewer.model);
      let waiver: { reason: string; waivedBy: string } | undefined;
      if (!independent) {
        if (!opts.waive) {
          return refuse("reviewer_equals_executor", `The reviewer (${reviewer.adapter}:${reviewer.model}) is the executor; an independent review needs a different adapter or model.`, 'FIX: set review.adapter or review.model in project.json to differ from the executor, or pass --waive "independent_review: <reason>" --approver <id> to record that you accept a non-independent review.');
        }
        const parsed = parseWaiver(opts.waive, "R2");
        if (!parsed.ok) return envelope("review", "usage_error", project.phase, [{ code: parsed.code, severity: "error", message: parsed.message }], { type: "command", run: 'legion-flow review --waive "independent_review: <reason>" --approver <id>' });
        if (parsed.gateId !== "independent_review") return refuse("waiver_wrong_gate", `A review-time waiver can only name independent_review (got ${parsed.gateId}).`);
        const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
        if (!owner) return refuse("approver_not_decision_owner", `--waive needs --approver naming a decision owner (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`);
        waiver = { reason: parsed.reason, waivedBy: owner.id };
      }

      const runs = await ws.runs.list();
      const latestApplied = new Map<string, { runId: string; dir: string; proposalSha256: string }>();
      for (const r of runs) {
        if (r.run.kind === "workflow" && r.run.task?.planId === plan.id && r.run.applied) latestApplied.set(r.run.task.taskId, { runId: r.run.id, dir: r.dir, proposalSha256: r.run.applied.proposalSha256 });
      }
      const unapplied = plan.plan.tasks.filter((t) => !latestApplied.has(t.id)).map((t) => t.id);
      if (unapplied.length > 0) return refuse("tasks_unapplied", `A review covers the whole plan; tasks not yet applied: ${unapplied.join(", ")}.`, "Next: legion-flow execute");
      const taskRunOpen = runs.find((r) => r.run.kind === "workflow" && r.run.task && (r.run.status === "running" || r.run.status === "awaiting_decision"));
      if (taskRunOpen) return refuse("run_in_progress", `Task run ${taskRunOpen.run.id} is ${taskRunOpen.run.status}; finish it with legion-flow execute --resume first.`);
      const reviewOpen = runs.find((r) => r.run.kind === "workflow" && r.run.workflowId === "review" && r.run.status === "running");
      if (opts.resume && !reviewOpen) return refuse("no_run_to_resume", "No incomplete review run exists; start one with legion-flow review.");
      if (!opts.resume && reviewOpen) return refuse("run_in_progress", `Review run ${reviewOpen.run.id} did not finish; re-enter it with legion-flow review --resume.`);

      const prepared = await prepareTier(ctx, project, adapter, tierId, opts, "review", "reviewer");
      if (!prepared.ok) return prepared.envelope;
      const tier = prepared.tier;
      const sourceFingerprint = (await fingerprintTree(ws.root, { mode: tier.sourceMode })).fingerprint;

      const reviewMapNotes = await refreshMapFor(ws, held, languageServerRunner({ tier: tier.tierId === "vm-docker" ? "vm-docker" : "unhardened", dockerSettings: resolveDockerSettings(project.config.sandbox) }));
      const applied: AppliedProposalSummary[] = [];
      for (const t of plan.plan.tasks) {
        const a = latestApplied.get(t.id)!;
        let files: string[] = [];
        let mapped: { architecture?: ProposalArchitecture; impact?: ProposalImpact } = {};
        try {
          const proposal = ProposalSchema.parse(JSON.parse(await readFile(join(a.dir, "evidence", `${a.proposalSha256}.json`), "utf8")));
          files = proposal.files.map((f) => f.path);
          mapped = { ...(proposal.architecture ? { architecture: proposal.architecture } : {}), ...(proposal.impact ? { impact: proposal.impact } : {}) };
        } catch {
          // a proposal that cannot be read is listed without files; the reviewer sees the tree regardless
        }
        applied.push({ taskId: t.id, runId: a.runId, proposalSha256: a.proposalSha256, files, ...mapped });
      }

      const preflighted = await preflightTier(ws, project, tier, "review");
      if (!preflighted.ok) return preflighted.envelope;

      const materializer = createMaterializer({
        tier: tier.tierId,
        strategy: tier.strategy,
        paths: ws.paths,
        runId: reviewOpen?.run.id ?? "pending",
        settings: tier.dockerSettings,
        docker: realDockerCli,
        routes: tier.routes,
        egressDistDir: egressDistDir(),
        secrets: tier.secrets,
        now: () => now,
      })!;
      const workflow = reviewWorkflow({
        ws,
        materializer,
        adapter,
        adapterTimeoutMs: opts.adapterTimeoutMs,
        envMode: tier.report.isSandbox ? "container" : "host",
        tierEvidence: preflighted.tierEvidence,
        now: () => now,
      });
      const input: ReviewInput = {
        workspaceRoot: ws.root,
        sourceMode: tier.sourceMode,
        sourceFingerprint,
        fingerprints: { spec: spec.fingerprint, plan: plan.fingerprint, config },
        acceptanceCriteria: spec.spec.acceptanceCriteria,
        tasks: plan.plan.tasks,
        applied,
        reviewer,
        executor,
        independent,
        ...(reviewCfg.model ? { model: reviewCfg.model } : {}),
        ...(waiver ? { waiver } : {}),
      };
      const spans = tracingFor(ws, held, project.config);
      const tracing = spans.factory;
      const spanAttributes = {
        [SPAN_ATTRIBUTES.AC_ID]: spec.spec.acceptanceCriteria.map((c) => c.id),
        [SPAN_ATTRIBUTES.ADAPTER_ID]: reviewer.adapter,
        [SPAN_ATTRIBUTES.GEN_AI_MODEL]: reviewer.model,
        [SPAN_ATTRIBUTES.TREE_FINGERPRINT]: sourceFingerprint,
      };
      const controller = new AbortController();
      const onSignal = (signal: NodeJS.Signals) => controller.abort(new Error(`received ${signal}`));
      const install = opts.installSignalHandlers ?? true;
      if (install) for (const sig of SIGNALS) process.on(sig, onSignal);
      try {
        const runOptions = { signal: controller.signal, now: () => now, tracing, spanAttributes };
        const result: EngineResult = reviewOpen
          ? await continueRun(ws, workflow, reviewOpen.run.id, held, runOptions)
          : await runWorkflow(ws, workflow, held, { ...runOptions, input: input as unknown as Record<string, unknown>, durability: "sync" });
        const after = await ws.project.load(now);
        const phase = phaseOf(after);
        const diagnostics: Diagnostic[] = [
          { code: "sandbox_tier", severity: tier.report.isSandbox ? "info" : "warning", message: `Tier ${tier.report.tier} (${tier.strategy} tree, ${tier.sourceMode} listing): ${tier.report.caveats[0]}.` },
          { code: "reviewer", severity: independent ? "info" : "warning", message: `Reviewer ${reviewer.adapter}:${reviewer.model}; executor ${executor.adapter}:${executor.model}; ${independent ? "independent" : "NOT independent (waived at review time)"}.` },
          ...tier.credentialDiagnostics,
          ...spans.diagnostics(),
          ...reviewMapNotes,
        ];
        if (result.kind === "complete") {
          const loaded = await ws.runs.load(result.runId);
          const review = loaded?.run.kind === "workflow" ? loaded.run.review : undefined;
          if (review?.verdict === "PASS") {
            diagnostics.push({ code: "review_passed", severity: "info", message: `Review run ${result.runId} passed: ${review.reason}.`, path: join(ws.paths.cacheRunsDir, result.runId, "review.md") });
            return envelope("review", "ok", phase, [...diagnostics, ...phaseReasonDiagnostics(after)], { type: "command", run: "legion-flow review --accept --approver <id>", hint: "A decision owner reads review.md and accepts the review." }, [], result.runId);
          }
          diagnostics.push({ code: "review_failed", severity: "error", message: `Review run ${result.runId} failed: ${review?.reason ?? "no verdict was recorded"}.`, path: join(ws.paths.cacheRunsDir, result.runId, "review.md") });
          return envelope("review", "blocked", phase, [...diagnostics, ...phaseReasonDiagnostics(after)], { type: "command", run: "legion-flow execute <taskId>", hint: "Read review.md, re-execute the task it rejects (allowed by name after a failed review), then run legion-flow review again. A larger change needs a new plan." }, [], result.runId);
        }
        if (result.kind === "refused") return envelope("review", "refused", phase, [{ code: result.code, severity: "error", message: result.message }, ...diagnostics], nextActionFor(phase));
        const reason = result.kind === "failed" ? result.error : result.kind === "cancelled" ? result.reason : "the review paused unexpectedly";
        diagnostics.push({ code: "review_run_failed", severity: "error", message: `Review run ${result.runId} ${result.kind}: ${reason}`, path: join(ws.paths.runsDir, result.runId) });
        diagnostics.push({ code: "sandbox_tree_kept", severity: "info", message: "The review copy is kept for inspection; it is never applied.", path: join(ws.paths.sandboxDir, result.runId, "tree") });
        return envelope("review", "blocked", phase, [...diagnostics, ...phaseReasonDiagnostics(after)], { type: "command", run: "legion-flow review", hint: "Start a fresh review." }, [], result.runId);
      } finally {
        if (install) for (const sig of SIGNALS) process.off(sig, onSignal);
      }
    }, opts.resume ? "review --resume" : "review");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("review", ws, err);
    throw err;
  }
};

/** The human boundary: a decision owner on a terminal accepts the latest PASS at the current fingerprints and checkout. */
async function acceptReview(ctx: Parameters<CommandHandler>[0], opts: ReviewOptions, now: Date): Promise<ResultEnvelope> {
  const ws = ctx.workspace;
  if (!opts.approver) {
    return envelope("review", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "approver_required", severity: "error", message: "--accept needs --approver <id>, a decision owner of this project." }], { type: "command", run: "legion-flow review --accept --approver <id>" });
  }
  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load(now);
      if (project.kind !== "valid") return projectUnusableRefusal("review", project);
      const refuse = (code: string, message: string, hint?: string) => refusal("review", project, code, message, hint);
      const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
      if (!owner) return refuse("approver_not_decision_owner", `'${opts.approver}' is not a decision owner of this project (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`);
      if (!ctx.isTTY) return refuse("review_accept_requires_tty", "Accepting a review is a human decision and is honored only on an interactive terminal.");
      const spec = await ws.specs.current();
      const plan = await ws.plans.current();
      if (!spec || spec.kind !== "valid" || !plan || plan.kind !== "valid") return refuse("plan_not_approved", "There is no valid current plan to accept a review for.");
      const fingerprints = { spec: spec.fingerprint, plan: plan.fingerprint, config: configFingerprint(project.config) };
      const reviews = (await ws.runs.list()).flatMap((r) => (r.run.kind === "workflow" && r.run.workflowId === "review" && r.run.status === "complete" && r.run.review ? [{ id: r.run.id, review: r.run.review }] : []));
      const latest = reviews[reviews.length - 1];
      if (!latest) return refuse("review_not_found", "No completed review run exists.", "Next: legion-flow review");
      if (latest.review.verdict !== "PASS") return refuse("review_not_passed", `The latest review run ${latest.id} did not pass: ${latest.review.reason}.`, "Next: legion-flow review");
      const f = latest.review.fingerprints;
      const mode = await detectTreeMode(ws.root);
      const source = (await fingerprintTree(ws.root, { mode })).fingerprint;
      if (f.spec !== fingerprints.spec || f.plan !== fingerprints.plan || f.config !== fingerprints.config || latest.review.sourceFingerprint !== source || latest.review.treeMode !== mode) {
        return refuse("review_stale", `Review run ${latest.id} reviewed spec ${f.spec}, plan ${f.plan}, config ${f.config}, checkout ${latest.review.sourceFingerprint}; now they are ${fingerprints.spec}, ${fingerprints.plan}, ${fingerprints.config}, ${source}. Review again.`, "Next: legion-flow review");
      }
      const existing = (await ws.reviews.list()).find((r) => r.runId === latest.id);
      if (existing) {
        return envelope("review", "ok", project.phase, [{ code: "review_unchanged", severity: "info", message: `Review run ${latest.id} was already accepted as ${existing.id} by ${existing.decidedBy.id}; nothing written.` }], project.phase === "plan_ready" ? await planReadyNextAction(ws) : nextActionFor(project.phase));
      }
      const receipt: ReviewReceipt = {
        schema: SCHEMA_VERSIONS.REVIEW_RECEIPT,
        id: newId("rvw"),
        runId: latest.id,
        fingerprints,
        sourceFingerprint: source,
        treeMode: mode,
        reviewer: latest.review.reviewer,
        independent: latest.review.independent,
        decidedBy: owner,
        decidedAt: now.toISOString(),
        source: ctx.isTTY ? "tty" : "piped",
        idempotencyKey: `${project.config.id}:${latest.id}:review-accept`,
      };
      const path = await ws.reviews.record(receipt, held);
      await ws.audit.append({ type: "review_accepted", receiptId: receipt.id, runId: latest.id, decidedBy: owner.id, independent: receipt.independent, sourceFingerprint: source }, held);
      const after = await ws.project.load(now);
      const phase = phaseOf(after);
      return envelope("review", "ok", phase, [
        { code: "review_accepted", severity: "info", message: `Review run ${latest.id} accepted by ${owner.id} as ${receipt.id}.`, path },
        ...(receipt.independent ? [] : [{ code: "review_not_independent", severity: "warning" as const, message: "This review was made by the executor itself; independent_review stays unsatisfied unless ship waives it." }]),
        ...phaseReasonDiagnostics(after),
      ], phase === "plan_ready" ? await planReadyNextAction(ws) : nextActionFor(phase));
    }, "review --accept");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("review", ws, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

export interface EvalOptions {
  new?: string;
  dataset?: string;
  datasetVersion?: string;
  waive?: string;
  approver?: string;
  resume?: boolean;
  /** Test seams. */
  now?: Date;
  checkTimeoutMs?: number;
  judgeTimeoutMs?: number;
  installSignalHandlers?: boolean;
}

/**
 * Golden evaluations: `eval --new <id>` scaffolds v1; `eval --dataset <id>`
 * runs the highest unarchived version (or `--dataset-version N`) in a copy of
 * the checkout. Each case's argv runs shell-free, as the plan's checks do.
 */
export const evalCommand: CommandHandler<EvalOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  const usage = async (code: string, message: string, run = "legion-flow eval --dataset <id>") =>
    envelope("eval", "usage_error", phaseOf(await ws.project.load(now)), [{ code, severity: "error", message }], { type: "command", run });
  if (opts.new !== undefined && opts.dataset !== undefined) return usage("eval_mode_exclusive", "Pass either --new <id> or --dataset <id>, not both.");
  if (opts.new === undefined && opts.dataset === undefined) return usage("dataset_required", "eval needs --dataset <id> (or --new <id> to create one).");
  const id = (opts.new ?? opts.dataset)!;
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) return usage("dataset_id_invalid", `'${id}' is not a dataset id (lowercase letters, digits, '-' and '_', starting with a letter).`);
  let pinned: number | undefined;
  if (opts.datasetVersion !== undefined) {
    pinned = Number(opts.datasetVersion);
    if (!Number.isInteger(pinned) || pinned < 1) return usage("dataset_version_invalid", `--dataset-version must be a positive integer (got '${opts.datasetVersion}').`);
  }

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load(now);
      if (project.kind !== "valid") return projectUnusableRefusal("eval", project);
      const refuse = (code: string, message: string, hint?: string) => refusal("eval", project, code, message, hint);

      if (opts.new !== undefined) {
        const created = await ws.datasets.create(id, held);
        if (created.kind === "exists") return refuse("dataset_exists", `Dataset '${id}' already exists; a change is a new version file.`, `FIX: copy the latest version to v<N+1>.json under ${join(ws.paths.evalsDir, id)}`);
        await ws.audit.append({ type: "dataset_created", datasetId: id }, held);
        return envelope("eval", "ok", project.phase, [{ code: "dataset_created", severity: "info", message: `Dataset '${id}' scaffolded as v1; edit its cases, then run it. The first run freezes the version.`, path: created.path }], { type: "command", run: `legion-flow eval --dataset ${id}` });
      }

      const spec = await ws.specs.current();
      const plan = await ws.plans.current();
      if (!spec || spec.kind !== "valid" || !plan || plan.kind !== "valid") return refuse("plan_not_approved", "Evaluations bind to an approved plan against a frozen spec; there is no valid current plan.");
      const config = configFingerprint(project.config);
      const planReceipt = (await ws.approvals.forSubject("plan", plan.id)).find((r) => r.fingerprints.plan === plan.fingerprint && r.fingerprints.spec === spec.fingerprint && r.fingerprints.config === config);
      if (!planReceipt) return refuse("plan_not_approved", "The current plan has no approval receipt at its current fingerprints.");

      const listing = (await ws.datasets.list()).find((d) => d.id === id);
      if (!listing || listing.versions.length === 0) return refuse("dataset_unknown", `No dataset '${id}' exists.`, `FIX: legion-flow eval --new ${id}`);
      const chosen = pinned !== undefined ? listing.versions.find((v) => v.version === pinned) : [...listing.versions].reverse().find((v) => v.kind === "invalid" || !v.dataset.archived);
      if (!chosen) return refuse("dataset_version_unknown", pinned !== undefined ? `Dataset '${id}' has no version ${pinned}.` : `Every version of '${id}' is archived.`);
      if (chosen.kind === "invalid") return refuse("dataset_invalid", `${chosen.path} is not a valid golden dataset: ${chosen.detail}`);
      const dataset = chosen.dataset;
      const argvProblems = dataset.cases.flatMap((c) => {
        const problem = argvCheckProblem(c.argv);
        return problem ? [`${c.id}: ${problem}`] : [];
      });
      if (argvProblems.length > 0) return refuse("dataset_invalid", `Case argv must run without a shell: ${argvProblems.join("; ")}`);

      const runs = await ws.runs.list();
      const priorForVersion = runs.find((r) => r.run.kind === "workflow" && r.run.workflowId === "eval" && r.run.eval?.datasetId === id && r.run.eval.version === dataset.version);
      if (priorForVersion && priorForVersion.run.kind === "workflow" && priorForVersion.run.eval!.datasetFingerprint !== chosen.fingerprint) {
        return refuse("dataset_version_drift", `${chosen.path} changed after run ${priorForVersion.run.id} froze it; a version is never edited once it has run.`, `FIX: restore v${dataset.version}.json and copy your change to v${listing.versions[listing.versions.length - 1]!.version + 1}.json`);
      }

      // The judge, when any metric needs one.
      const needsJudge = dataset.cases.some((c) => c.metrics.some((m) => m.scorer === "judge"));
      let judgeIdentity: string | undefined;
      let distinctFromExecutor = true;
      let waiver: { reason: string; waivedBy: string } | undefined;
      let judgeConfig: Parameters<typeof createMetricScorer>[0];
      if (needsJudge) {
        const j = project.config.judge;
        if (!j) return refuse("judge_unconfigured", "A metric uses the judge scorer but no judge is configured.", "FIX: set judge.baseUrl (a loopback OpenAI-compatible endpoint, for example http://127.0.0.1:11434/v1) and judge.model in project.json, then approve the plan again.");
        const urlProblem = judgeUrlProblem(j.baseUrl);
        if (urlProblem) return refuse("judge_not_loopback", urlProblem, "FIX: run the judge on this machine; a remote judge is egress and is not supported in this milestone.");
        let apiKey: string | undefined;
        if (j.apiKeyEnv) {
          apiKey = process.env[j.apiKeyEnv];
          if (apiKey === undefined) {
            return envelope("eval", "blocked", project.phase, [
              { code: "credential_required", severity: "error", message: `The judge needs ${j.apiKeyEnv}, which is not set. Nothing ran.`, hint: `FIX: set ${j.apiKeyEnv} in the environment that runs legion-flow; it is sent only to the loopback judge and never recorded.` },
              ...phaseReasonDiagnostics(project),
            ], { type: "credential_required", variable: j.apiKeyEnv, adapter: "judge", hint: `Set ${j.apiKeyEnv} and re-run legion-flow eval --dataset ${id}.` });
          }
        }
        judgeIdentity = `judge:${j.model}`;
        const executorModel = project.config.adapter.http?.model;
        distinctFromExecutor = executorModel === undefined || executorModel !== j.model;
        if (!distinctFromExecutor) {
          if (!opts.waive) return refuse("judge_equals_executor", `The judge model (${j.model}) is the executor's model; a judge must differ from the executor.`, 'FIX: set judge.model to a different model, or pass --waive "eval_goldens: <reason>" --approver <id> to record that you accept it (the gate stays unsatisfied).');
          const parsed = parseWaiver(opts.waive, "R3");
          if (!parsed.ok) return envelope("eval", "usage_error", project.phase, [{ code: parsed.code, severity: "error", message: parsed.message }], { type: "command", run: 'legion-flow eval --dataset <id> --waive "eval_goldens: <reason>" --approver <id>' });
          if (parsed.gateId !== "eval_goldens") return refuse("waiver_wrong_gate", `An eval-time waiver can only name eval_goldens (got ${parsed.gateId}).`);
          const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
          if (!owner) return refuse("approver_not_decision_owner", `--waive needs --approver naming a decision owner (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).`);
          waiver = { reason: parsed.reason, waivedBy: owner.id };
        }
        judgeConfig = { baseUrl: j.baseUrl, model: j.model, ...(apiKey ? { apiKey } : {}), ...(opts.judgeTimeoutMs ? { timeoutMs: opts.judgeTimeoutMs } : {}) };
      }

      const open = runs.find((r) => r.run.kind === "workflow" && (r.run.status === "running" || r.run.status === "awaiting_decision") && (r.run.task || r.run.workflowId === "review"));
      if (open) return refuse("run_in_progress", `Run ${open.run.id} (${open.run.kind === "workflow" ? open.run.workflowId : open.run.kind}) has not finished; finish it first.`);
      const evalOpen = runs.find((r) => r.run.kind === "workflow" && r.run.workflowId === "eval" && r.run.status === "running");
      if (opts.resume && !evalOpen) return refuse("no_run_to_resume", "No incomplete eval run exists.");
      if (!opts.resume && evalOpen) return refuse("run_in_progress", `Eval run ${evalOpen.run.id} did not finish; re-enter it with legion-flow eval --dataset ${id} --resume.`);

      const sourceMode = await detectTreeMode(ws.root);
      const sourceFingerprint = (await fingerprintTree(ws.root, { mode: sourceMode })).fingerprint;
      // The case argv is the project's own program, at the trust level of the plan's checks: a plain copy, no adapter, no sandbox tier.
      const materializer = createMaterializer({ tier: "unhardened", strategy: "copy", paths: ws.paths, runId: evalOpen?.run.id ?? "pending", now: () => now })!;
      const workflow = evalWorkflow({ ws, materializer, runCheck, scorer: createMetricScorer(judgeConfig), checkTimeoutMs: opts.checkTimeoutMs, now: () => now });
      const input: EvalInput = {
        workspaceRoot: ws.root,
        sourceMode,
        sourceFingerprint,
        fingerprints: { spec: spec.fingerprint, plan: plan.fingerprint, config },
        dataset,
        datasetFingerprint: chosen.fingerprint,
        ...(judgeIdentity ? { judge: judgeIdentity } : {}),
        distinctFromExecutor,
        ...(waiver ? { waiver } : {}),
      };
      const spans = tracingFor(ws, held, project.config);
      const tracing = spans.factory;
      const spanAttributes = {
        [SPAN_ATTRIBUTES.AC_ID]: [...new Set(dataset.cases.flatMap((c) => c.acceptanceIds))],
        [SPAN_ATTRIBUTES.TREE_FINGERPRINT]: sourceFingerprint,
        ...(judgeIdentity ? { [SPAN_ATTRIBUTES.GEN_AI_MODEL]: judgeIdentity } : {}),
      };
      const controller = new AbortController();
      const onSignal = (signal: NodeJS.Signals) => controller.abort(new Error(`received ${signal}`));
      const install = opts.installSignalHandlers ?? true;
      if (install) for (const sig of SIGNALS) process.on(sig, onSignal);
      try {
        const runOptions = { signal: controller.signal, now: () => now, tracing, spanAttributes };
        const result: EngineResult = evalOpen
          ? await continueRun(ws, workflow, evalOpen.run.id, held, runOptions)
          : await runWorkflow(ws, workflow, held, { ...runOptions, input: input as unknown as Record<string, unknown>, durability: "sync" });
        const after = await ws.project.load(now);
        const phase = phaseOf(after);
        const next = phase === "plan_ready" ? await planReadyNextAction(ws) : nextActionFor(phase);
        if (result.kind === "complete") {
          const loaded = await ws.runs.load(result.runId);
          const r = loaded?.run.kind === "workflow" ? loaded.run.eval : undefined;
          if (!r) return envelope("eval", "blocked", phase, [{ code: "eval_unrecorded", severity: "error", message: `Eval run ${result.runId} recorded no result.` }], next, [], result.runId);
          const lines: Diagnostic[] = [
            { code: "eval_dataset", severity: "info", message: `Dataset ${r.datasetId}@v${r.version}: ${r.cases.length} case(s)${r.judge ? `, judge ${r.judge}${r.distinctFromExecutor ? "" : " (NOT distinct from the executor)"}` : ""}.` },
            ...r.cases.flatMap((c) => c.metrics.filter((m) => m.status !== "pass").map((m) => ({ code: `eval_metric_${m.status}`, severity: m.status === "fail" ? ("error" as const) : ("warning" as const), message: `${c.id}/${m.metric} (${m.scorer}): mean ${m.mean ?? "n/a"} vs ${m.threshold}; ${m.reasons[m.reasons.length - 1] ?? ""}` }))),
          ];
          lines.push(...spans.diagnostics());
          if (r.passed) return envelope("eval", "ok", phase, [...lines, { code: "eval_passed", severity: "info", message: r.reason }, ...phaseReasonDiagnostics(after)], next, [], result.runId);
          return envelope("eval", "blocked", phase, [...lines, { code: r.unevaluable ? "eval_unevaluable" : "eval_failed", severity: "error", message: r.reason }, ...phaseReasonDiagnostics(after)], { type: "command", run: `legion-flow eval --dataset ${id}`, hint: r.unevaluable ? "Fix what could not be scored (the judge, or a case that could not run), then evaluate again." : "Fix the program or, if the expectation was wrong, add a new dataset version." }, [], result.runId);
        }
        if (result.kind === "refused") return envelope("eval", "refused", phase, [{ code: result.code, severity: "error", message: result.message }], next);
        const reason = result.kind === "failed" ? result.error : result.kind === "cancelled" ? result.reason : "the eval paused unexpectedly";
        return envelope("eval", "blocked", phase, [{ code: "eval_run_failed", severity: "error", message: `Eval run ${result.runId} ${result.kind}: ${reason}` }, { code: "sandbox_tree_kept", severity: "info", message: "The eval copy is kept for inspection.", path: join(ws.paths.sandboxDir, result.runId, "tree") }, ...spans.diagnostics()], { type: "command", run: `legion-flow eval --dataset ${id}` }, [], result.runId);
      } finally {
        if (install) for (const sig of SIGNALS) process.off(sig, onSignal);
      }
    }, opts.new !== undefined ? "eval --new" : "eval");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("eval", ws, err);
    throw err;
  }
};

export interface ExecuteOptions {
  taskId?: string;
  resume?: boolean;
  /** Run up to this many tasks in parallel (1 to 8). */
  jobs?: string | number;
  /** New attempts after a retryable failure (1 to 3, M4 slice g). */
  retry?: string | number;
  /** Run the task once per member and let a human choose one proposal (M4 slice j2). */
  broadcast?: boolean;
  /** With --broadcast: comma-separated member ids; default plus every declared member when absent. */
  members?: string;
  sandbox?: string;
  allowNoSandbox?: boolean;
  materialize?: string;
  durability?: string;
  /** Test seams. */
  now?: Date;
  adapterTimeoutMs?: number;
  installSignalHandlers?: boolean;
}

/** Failure codes `execute --retry` starts a new attempt for; anything else (usage limits, a moved checkout, an effect unknown after a crash, a refusal) stops. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(["adapter_failed", "adapter_timeout", "contract_violation"]);

/** A refusal found while preparing a routed member's tier, before any run started; execute returns its envelope. */
class PreparedRefusal extends Error {
  constructor(public readonly envelope: ResultEnvelope) {
    super(envelope.diagnostics[0]?.code ?? "refused");
  }
}

const SIGNALS: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Execute one approved task, or re-enter the one incomplete task run.
 * Preconditions are typed refusals (exit 2); a run that ends failed or
 * cancelled is `blocked` (exit 3) with the run id and the kept tree; an R1+
 * proposal pauses the run `awaiting_decision` (exit 3).
 */
export const executeCommand: CommandHandler<ExecuteOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  const tierId = (opts.sandbox ?? "vm-docker") as SandboxTierId;
  const durability = (opts.durability ?? "sync") as "sync" | "exit" | "async";

  if (!(SANDBOX_TIER_IDS as readonly string[]).includes(tierId)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "sandbox_tier_unknown", severity: "error", message: `'${opts.sandbox}' is not a sandbox tier (${SANDBOX_TIER_IDS.join(", ")}).` },
    ], { type: "command", run: "legion-flow execute --sandbox unhardened --allow-no-sandbox" });
  }
  if (opts.materialize !== undefined && !["copy", "worktree"].includes(opts.materialize)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "materialize_unknown", severity: "error", message: `--materialize must be copy or worktree (got '${opts.materialize}').` },
    ], { type: "command", run: "legion-flow execute --materialize copy" });
  }
  const jobs = opts.jobs === undefined ? 1 : Number(opts.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "jobs_invalid", severity: "error", message: `--jobs must be an integer from 1 to 8 (got '${opts.jobs}').` }], { type: "command", run: "legion-flow execute --jobs 2" });
  }
  if (jobs > 1 && opts.materialize === "worktree") {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "jobs_conflict", severity: "error", message: "--jobs does not combine with --materialize worktree: concurrent git worktree adds race on the repository's index lock. Use the default copy strategy for parallel runs." }], { type: "command", run: "legion-flow execute --jobs 2" });
  }
  const retries = opts.retry === undefined ? 0 : Number(opts.retry);
  if (opts.retry !== undefined && (!Number.isInteger(retries) || retries < 1 || retries > 3)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "retry_invalid", severity: "error", message: `--retry must be an integer from 1 to 3 (got '${opts.retry}').` }], { type: "command", run: "legion-flow execute --retry 2" });
  }
  if (opts.members !== undefined && !opts.broadcast) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "members_needs_broadcast", severity: "error", message: "--members applies to --broadcast only." }], { type: "command", run: "legion-flow execute <taskId> --broadcast" });
  }
  if (opts.broadcast && (!opts.taskId || opts.resume || jobs > 1 || retries > 0)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "broadcast_usage", severity: "error", message: "--broadcast runs one named task once per member; it needs a task id and does not combine with --resume, --jobs, or --retry." }], { type: "command", run: "legion-flow execute <taskId> --broadcast" });
  }
  if (retries > 0 && (opts.resume || jobs > 1)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "retry_conflict", severity: "error", message: "--retry starts fresh attempts of one task; it does not combine with --resume or --jobs." }], { type: "command", run: "legion-flow execute --retry 2" });
  }
  if (jobs > 1 && (opts.taskId || opts.resume)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [{ code: "jobs_conflict", severity: "error", message: "--jobs starts new runs from the plan; it does not combine with a task id or --resume." }], { type: "command", run: "legion-flow execute --jobs 2" });
  }
  if (!["sync", "exit", "async"].includes(durability)) {
    return envelope("execute", "usage_error", phaseOf(await ws.project.load(now)), [
      { code: "durability_unknown", severity: "error", message: `--durability must be sync, exit, or async (got '${opts.durability}').` },
    ], { type: "command", run: "legion-flow execute --durability sync" });
  }

  try {
    return await ws.lock.withLock(async (held) => {
      const project = await ws.project.load(now);
      if (project.kind !== "valid") return projectUnusableRefusal("execute", project);
      const refuse = (code: string, message: string, hint?: string, nextAction = nextActionFor(project.phase)) =>
        envelope("execute", "refused", project.phase, [{ code, severity: "error", message, ...(hint ? { hint } : {}) }, ...phaseReasonDiagnostics(project)], nextAction);

      // The tier itself is checked before anything else; the adapter-level preparation waits until each task is routed to a member.
      const defaultAdapter = adapterFor(project.config.adapter.default, project.config);
      if (!defaultAdapter) {
        return refuse("adapter_unknown", `Adapter '${project.config.adapter.default}' is not registered in this build (known: fake, claude, codex).`);
      }
      const tierCheck = await prepareTier(ctx, project, defaultAdapter, tierId, { ...opts }, "execute");
      // With no members declared every task runs on the default adapter, so its checks keep their old place, before the plan's;
      // with members, an adapter-level refusal waits until a task is routed to that adapter.
      const routing = (project.config.coordinator?.members?.length ?? 0) > 0;
      // A resume that only settles decided broadcast choices spawns nothing, so the default adapter's tier cannot refuse it (M4 slice t).
      const allRuns = opts.resume ? await ws.runs.list() : [];
      const openRuns = allRuns.filter((r) => r.run.kind === "workflow" && r.run.task && (r.run.status === "running" || r.run.status === "awaiting_decision"));
      // Across every plan's runs here (the plan is not loaded yet); the per-plan filter comes with the recovery itself.
      const onlyChoices = (openRuns.length > 0 && openRuns.every((r) => r.run.kind === "workflow" && r.run.workflowId === BROADCAST_WORKFLOW_ID)) || (opts.resume === true && openRuns.length === 0 && orphanedBroadcasts(allRuns).size > 0);
      if (!tierCheck.ok && !onlyChoices && (!routing || !["credential_required", "egress_secret_missing", "egress_route_conflict"].includes(tierCheck.envelope.diagnostics[0]?.code ?? ""))) return tierCheck.envelope;
      const limits = project.config.adapter.limits;
      if (!routing && limits?.costLimitUsd !== undefined && !defaultAdapter.profile.reportsUsage.cost) {
        return refuse("usage_unreportable", `adapter.limits.costLimitUsd is set but the ${defaultAdapter.id} adapter cannot report cost; it would run unbounded.`, "FIX: remove costLimitUsd for this adapter, or use maxTurns, which it can report.");
      }
      if (!routing && limits?.maxTurns !== undefined && !defaultAdapter.profile.reportsUsage.turns) {
        return refuse("usage_unreportable", `adapter.limits.maxTurns is set but the ${defaultAdapter.id} adapter cannot report turns; it would run unbounded.`, "FIX: remove maxTurns for this adapter.");
      }

      const spec = await ws.specs.current();
      const plan = await ws.plans.current();
      if (!spec || spec.kind !== "valid" || !plan || plan.kind !== "valid") {
        return refuse("plan_not_approved", "Execution needs an approved plan against a frozen spec; there is no valid current plan.");
      }
      const config = configFingerprint(project.config);
      const planReceipt = (await ws.approvals.forSubject("plan", plan.id)).find(
        (r) => r.fingerprints.plan === plan.fingerprint && r.fingerprints.spec === spec.fingerprint && r.fingerprints.config === config
      );
      if (!planReceipt) {
        return refuse("plan_not_approved", "The current plan has no approval receipt at its current fingerprints.", "FIX: legion-flow approve plan --approver <id> --check \"<argv>\"");
      }

      const runs = await ws.runs.list();
      const incomplete = runs.filter((r) => r.run.kind === "workflow" && r.run.task && (r.run.status === "running" || r.run.status === "awaiting_decision"));
      // Per routed member (M4 slice j1): its adapter's tier, prepared and preflighted once per adapter, plus the member's own sandbox rule.
      type MemberTier = { member: RunMember; adapter: Adapter; tier: PreparedTier; tierEvidence: Record<string, unknown> };
      const adapterTiers = new Map<string, Promise<{ adapter: Adapter; tier: PreparedTier; tierEvidence: Record<string, unknown> }>>();
      const used: MemberTier[] = [];
      const tierOfTask = new Map<string, MemberTier>();
      const prepareAdapter = async (adapterId: string, memberId: string) => {
        const adapter = adapterFor(adapterId, project.config);
        if (!adapter) throw new PreparedRefusal(refuse(memberId === DEFAULT_MEMBER_ID ? "adapter_unknown" : "delegation_rejected", `Member '${memberId}' uses adapter '${adapterId}', which is not registered in this build (known: fake, claude, codex).`));
        if (limits?.costLimitUsd !== undefined && !adapter.profile.reportsUsage.cost) throw new PreparedRefusal(refuse("usage_unreportable", `adapter.limits.costLimitUsd is set but the ${adapter.id} adapter cannot report cost; it would run unbounded.`, "FIX: remove costLimitUsd for this adapter, or use maxTurns, which it can report."));
        if (limits?.maxTurns !== undefined && !adapter.profile.reportsUsage.turns) throw new PreparedRefusal(refuse("usage_unreportable", `adapter.limits.maxTurns is set but the ${adapter.id} adapter cannot report turns; it would run unbounded.`, "FIX: remove maxTurns for this adapter."));
        const prepared = await prepareTier(ctx, project, adapter, tierId, opts, "execute");
        if (!prepared.ok) throw new PreparedRefusal(prepared.envelope);
        // Preflight last among the preconditions: the probe starts a container.
        const preflighted = await preflightTier(ws, project, prepared.tier, "execute");
        if (!preflighted.ok) throw new PreparedRefusal(preflighted.envelope);
        return { adapter, tier: prepared.tier, tierEvidence: preflighted.tierEvidence };
      };
      const tierFor = async (member: RunMember): Promise<MemberTier> => {
        const delegation = spawnAllowed({ kind: "adapter", tier: tierId, hardened: tierId === "vm-docker", ...(project.config.sandbox?.require ? { require: true } : {}), member: { id: member.id, ...(member.sandbox ? { sandbox: member.sandbox } : {}) } });
        if (!delegation.ok) throw new PreparedRefusal(refuse(delegation.code, delegation.message, delegation.hint));
        if (!adapterTiers.has(member.adapter)) {
          const p = prepareAdapter(member.adapter, member.id);
          p.catch(() => undefined);
          adapterTiers.set(member.adapter, p);
        }
        const base = await adapterTiers.get(member.adapter)!;
        const mt = { member, ...base, tierEvidence: { ...base.tierEvidence, spawn: delegation.record } };
        used.push(mt);
        return mt;
      };
      const routeOf = (task: (typeof plan.plan.tasks)[number]): RunMember => {
        const routed = routeTask(project.config, task);
        if (!routed.ok) throw new PreparedRefusal(refuse("delegation_rejected", `Task ${task.id}: ${routed.reason}.`, "FIX: declare the member in project.json coordinator.members, or change the task's member (the plan then needs approval again)."));
        return routed.member;
      };
      // A native Linux engine cannot reach a loopback gateway from a container; tools on vm-docker need Docker Desktop (M4 slice k).
      const toolsTierCheck = async (task: (typeof plan.plan.tasks)[number]) => {
        if (task.tools?.length && tierId === "vm-docker" && process.platform === "linux") throw new PreparedRefusal(refuse("tools_gateway_engine_unsupported", `Task ${task.id} names tools, and on a native Linux Docker engine a container cannot reach the loopback-only tool gateway.`, "FIX: run on Docker Desktop, or on the unhardened tier with --allow-no-sandbox on a terminal, or remove tools from the task."));
        // The web server (M4 slice z) needs the project's Firecrawl; without one the task would run with its tools missing.
        if (task.tools?.some((x) => x.split(".")[0] === WEB_SERVER_NAME) && !project.config.web?.firecrawlUrl) throw new PreparedRefusal(refuse("web_unconfigured", `Task ${task.id} names the web tools, and project.json has no web.firecrawlUrl.`, "FIX: run a self-hosted Firecrawl and set project.json web.firecrawlUrl to its loopback URL (for example http://127.0.0.1:3002); Legion never starts it."));
        // The browser session (M4 slice o1): serve runs code the agent wrote, so only on the host tier a person chose; secrets must be set before any run starts.
        if (task.browser && task.tools?.some((x) => x.split(".")[0] === BROWSER_SERVER_NAME)) {
          // The session rules hold at every run, not only at approval: a plan approved before a rule existed still meets it (M4 slice r).
          const sessionProblem = browserSessionProblem(task.browser);
          if (sessionProblem) throw new PreparedRefusal(refuse("browser_session_unsafe", `Task ${task.id}'s browser session: ${sessionProblem}.`, "FIX: drop serve or the secrets from the task's browser block; the plan then needs approval again."));
          // On the host tier the browser is an installed one; none found is a refusal before the run, not missing tools in it (M4 slice r).
          if (tierId !== "vm-docker" && findBrowsers().length === 0) throw new PreparedRefusal(refuse("browser_not_found", `Task ${task.id} browses on the host tier, and no browser was found (installed Chrome, Edge, or a cached Playwright Chromium).`, "FIX: install Chrome or Edge, or run on the vm-docker tier, where the browser runs in its own image. Nothing is ever downloaded."));
          // Under vm-docker the browser runs in its own container (M4 slice o2); execute never builds the image on its own.
          if (tierId === "vm-docker") {
            const image = browserImageOf(project.config);
            const inspected = await realDockerCli.run(["image", "inspect", image], { timeoutMs: 30_000 });
            // Only a definite "no such image" is this refusal; a stopped daemon is left to the Docker preflight, which names it.
            if (inspected.code !== 0 && /no such image|not found/i.test(inspected.stderr)) {
              const dir = join(ws.paths.varDir, "images", "browser");
              if (image === browserImageTag()) {
                await mkdir(dir, { recursive: true });
                await writeFile(join(dir, "Dockerfile"), browserDockerfile(), "utf8");
              }
              throw new PreparedRefusal(refuse("browser_image_missing", `Task ${task.id} browses, and under vm-docker the browser runs in the image ${image}, which is not present.`, image === browserImageTag() ? `FIX: docker build -t ${image} "${dir}"` : `FIX: build or pull ${image} (project.json sandbox.docker.browserImage)`));
            }
          }
          for (const sec of task.browser.secrets ?? []) if (!process.env[sec.ref.slice(4)]) throw new PreparedRefusal(refuse("browser_secret_missing", `Task ${task.id}'s browser session declares the secret ${sec.name}, and ${sec.ref.slice(4)} is not set.`, `FIX: set ${sec.ref.slice(4)} in this shell; its value is typed by host code and never recorded.`));
        }
      };
      const defaultMember = (): RunMember => (routeTask(project.config, { contract: { filesAllowed: [] } }) as { ok: true; member: RunMember }).member;

      const tier = project.config.defaultRiskTier;
      // Language servers run in the same tier as the task: a hardened container, or the host when the operator chose that on a terminal.
      // When the tier was not prepared (only decided choices are being applied), no language server may start: the host
      // tier's consent was never given, and the Docker tier was never preflighted (M4 slice t).
      const lspRunner = languageServerRunner({ tier: tierId === "vm-docker" ? "vm-docker" : "unhardened", dockerSettings: resolveDockerSettings(project.config.sandbox), ...(tierCheck.ok ? {} : { refuse: "language servers are not started: this resume only applies decided choices and prepared no tier" }) });
      const mapNotes = await refreshMapFor(ws, held, lspRunner);
      const rules = rulesOf(project.config);
      const servers = serversOf(project.config);
      // One materializer per run: it names the container and the egress network after its run, so runs in a batch never share one.
      // The tool gateway (M4 slice k): one per task run that names tools, listening before the materializer exists so a
      // Docker run's proxy route can name its port; closed at the end whether or not the run reached it.
      const gateways: PreboundGateway[] = [];
      const gatewayFor = async (task: (typeof plan.plan.tasks)[number], mt: MemberTier, usedBefore = 0): Promise<PreboundGateway | undefined> => {
        if (!task.tools?.length) return undefined;
        const { prebindToolGateway, TOOLS_DEFAULT_MAX_STEPS } = await import("./tool-gateway.js");
        const gw = await prebindToolGateway({ servers: project.config.mcpServers ?? [], tier: tierId === "vm-docker" ? "vm-docker" : "unhardened", dockerSettings: mt.tier.dockerSettings, root: ws.root, clientVersion: CLI_VERSION, maxSteps: task.browser?.maxSteps ?? project.config.toolPolicy?.maxSteps ?? TOOLS_DEFAULT_MAX_STEPS, ...(project.config.sandbox?.require ? { requireSandbox: true } : {}), ...(usedBefore ? { usedBefore } : {}) });
        gateways.push(gw);
        return gw;
      };
      // The check runner and the architecture port every workflow here shares (a choice run uses only these, M4 slice t).
      const checkRunner = ((check: string, input: Parameters<typeof runCheck>[1]) => runCheck(check, { ...input, ...(planReceipt.browserScripts ? { browserScripts: planReceipt.browserScripts } : {}) })) as typeof runCheck;
      const architecturePort = (input: { checkoutRoot: string; treeDir: string; changedPaths: string[] }) => analyzeCandidate({ ...input, ...(rules ? { rules } : {}), servers, runner: lspRunner, indexPath: ws.paths.indexSqlite });
      /**
       * The candidates of a broadcast and the recommendation (M4 slice j2), from each member's outcome. Shared by a live
       * broadcast and the recovery of an orphaned one (M4 slice v), so both judge members the same way.
       */
      const assembleChoice = async (results: { member: RunMember; result: { kind: string; runId?: string; values?: Record<string, unknown>; error?: string; reason?: string; message?: string } }[]) => {
        const candidates: BroadcastCandidate[] = [];
        const proposals: Record<string, unknown> = {};
        const lines: Diagnostic[] = [];
        let sourceFiles: unknown;
        let materializedAt: string | undefined;
        let baseFingerprint: string | undefined;
        for (const { member, result } of results) {
          const base = { member, runId: result.runId ?? "" };
          if (result.kind !== "complete") {
            candidates.push({ ...base, eligible: false, hasProposal: false, reason: result.kind === "failed" ? String(result.error ?? "failed") : result.kind === "awaiting_decision" ? "it paused instead of withholding" : result.kind === "cancelled" ? `cancelled: ${result.reason ?? ""}` : String(result.message ?? result.kind) });
            continue;
          }
          const v = result.values ?? {};
          let usage: unknown;
          try {
            if (typeof v.adapterEvidence === "string") usage = (JSON.parse(await readFile(join(ws.paths.project, ...v.adapterEvidence.split("/")), "utf8")) as { usage?: unknown }).usage;
          } catch {
            usage = undefined;
          }
          if (v.outcome !== "withheld" || !v.proposal) {
            candidates.push({ ...base, eligible: false, hasProposal: false, reason: v.outcome === "no_changes" ? "changed nothing inside its contract" : `ended ${String(v.outcome)}`, ...(usage ? { usage } : {}) });
            continue;
          }
          const proposal = ProposalSchema.parse(v.proposal);
          baseFingerprint ??= proposal.treeFingerprint;
          sourceFiles ??= v.sourceFiles;
          if (typeof v.materializedAt === "string" && (!materializedAt || v.materializedAt < materializedAt)) materializedAt = v.materializedAt;
          const passed = proposal.verification.results.filter((r) => r.status === "satisfied").length;
          const total = proposal.verification.results.length;
          const introduced = proposal.architecture?.introduced.length ?? 0;
          const why =
            proposal.treeFingerprint !== baseFingerprint ? "it was made against another checkout (the checkout moved during the broadcast)"
            : passed < total ? `${total - passed} of ${total} check(s) did not pass`
            : introduced > 0 ? `it introduces ${introduced} architecture rule violation(s)`
            : rules && !proposal.architecture ? "the architecture analysis did not run, and an unknown is not a pass"
            : "";
          proposals[member.id] = proposal;
          candidates.push({ ...base, eligible: why === "", hasProposal: true, reason: why || "every check passed and no rule is broken", checks: { passed, total }, files: proposal.files.map((f) => f.path), introduced, impact: proposal.impact ? { direct: proposal.impact.dependents.filter((d) => d.depth === 1).length, transitive: proposal.impact.dependents.length } : null, ...(usage ? { usage } : {}), proposalSha256: (v.proposalRef as { sha256: string }).sha256 });
        }
        const recommendation = recommendCandidate(candidates);
        for (const c of candidates) lines.push({ code: "broadcast_member", severity: c.hasProposal ? "info" : "warning", message: `${c.member.id} (${c.member.adapter}${c.member.model ? `, ${c.member.model}` : ""}, run ${c.runId}): ${c.hasProposal ? `${c.files!.length} file(s), ${c.checks!.passed}/${c.checks!.total} check(s) passed; ` : "no proposal; "}${c.reason}${c.member.id === recommendation ? " [recommended]" : ""}.` });
        return { candidates, proposals, sourceFiles, materializedAt, recommendation, lines };
      };
      // The coordinate strategy (M4 slice m): one runner per step member, every tier prepared before any run moves.
      const stepMembersOf = (task: (typeof plan.plan.tasks)[number]): RunMember[] =>
        (task.coordinate?.steps ?? []).map((s, i) => {
          const routed = routeTask(project.config, { member: s.member, contract: task.contract });
          if (!routed.ok) throw new PreparedRefusal(refuse("delegation_rejected", `Task ${task.id} step ${i + 1}: ${routed.reason}.`, "FIX: declare the member in project.json coordinator.members, or change the step (the plan then needs approval again)."));
          return { ...routed.member, reason: `coordinate step ${i + 1}` };
        });
      // On resume the members recorded on the run are used, never a fresh route: the config may have changed since.
      const stepsFor = async (task: (typeof plan.plan.tasks)[number], gw?: PreboundGateway, recorded?: RunMember[]): Promise<Record<string, StepRunner> | undefined> => {
        if (!task.coordinate) return undefined;
        const out: Record<string, StepRunner> = {};
        for (const m of recorded ?? stepMembersOf(task)) {
          if (out[m.id]) continue;
          const st = await tierFor(m);
          const routes = gw && tierId === "vm-docker" ? [...st.tier.routes, gw.route] : st.tier.routes;
          const secrets = { ...st.tier.secrets, ...(gw && tierId === "vm-docker" ? gw.secrets : {}) };
          out[m.id] = {
            adapter: st.adapter,
            ...(m.model ? { model: m.model } : {}),
            envMode: (st.tier.report.isSandbox ? "container" : "host") as "container" | "host",
            execFor: (runId: string) => createMaterializer({ tier: tierId, strategy: st.tier.strategy, paths: ws.paths, runId, settings: st.tier.dockerSettings, docker: realDockerCli, routes, egressDistDir: egressDistDir(), secrets, now: () => now })!.exec,
            redactValues: [...(st.adapter.credential && process.env[st.adapter.credential.env] ? [process.env[st.adapter.credential.env]!] : []), ...Object.values(st.tier.secrets)],
          };
        }
        return out;
      };
      const workflowFor = (runId: string, mt: MemberTier, kind: "task" | "broadcast" = "task", gw?: PreboundGateway, steps?: Record<string, StepRunner>) =>
        (kind === "broadcast" ? broadcastWorkflow : taskWorkflow)({
          ws,
          materializer: createMaterializer({ tier: tierId, strategy: mt.tier.strategy, paths: ws.paths, runId, settings: mt.tier.dockerSettings, docker: realDockerCli, routes: gw && tierId === "vm-docker" ? [...mt.tier.routes, gw.route] : mt.tier.routes, egressDistDir: egressDistDir(), secrets: { ...mt.tier.secrets, ...(gw && tierId === "vm-docker" ? gw.secrets : {}) }, now: () => now })!,
          ...(gw ? { tools: async ({ runId: id, task: t, held: h, treeDir }: { runId: string; task: (typeof plan.plan.tasks)[number]; held: typeof held; treeDir: string }) => (t.tools?.length ? gw.attach({ runId: id, selection: t.tools, record: async (rec) => { await ws.runs.writeEvidence(id, rec, h, "tools"); }, redactValues: [...(mt.adapter.credential && process.env[mt.adapter.credential.env] ? [process.env[mt.adapter.credential.env]!] : []), ...Object.values(mt.tier.secrets), ...(t.browser?.secrets ?? []).map((x) => process.env[x.ref.slice(4)]).filter((v): v is string => Boolean(v))], ...(t.web && project.config.web ? { web: { session: t.web, firecrawlUrl: project.config.web.firecrawlUrl } } : {}), ...(t.browser ? { browser: { session: t.browser, treeDir, ...(tierId === "vm-docker" ? { open: (b: { runId: string; record: (rec: Record<string, unknown>) => Promise<void> }) => openBrowserContainer({ session: t.browser!, treeDir, runId: b.runId, record: b.record, config: project.config, varDir: ws.paths.varDir }) } : {}) } } : {}) }) : null) } : {}),
          adapter: mt.adapter,
          ...(steps ? { steps } : {}),
          runCheck: checkRunner,
          adapterTimeoutMs: opts.adapterTimeoutMs,
          now: () => now,
          envMode: (mt.tier.report.isSandbox ? "container" : "host") as "container" | "host",
          // The evidence describes what ran: under Docker a tools run has the gateway's proxy route too.
          tierEvidence: gw && tierId === "vm-docker" ? { ...mt.tierEvidence, enforcement: enforcementReport(tierId, mt.tier.dockerSettings, [...mt.tier.routes, gw.route]) } : mt.tierEvidence,
          architecture: architecturePort,
          briefContext: (task: { contract: { filesAllowed: string[] } }) => briefContext(ws, (p) => matchesAnyPathPattern(p, task.contract.filesAllowed)),
          briefMemory: (task: { contract: { filesAllowed: string[] } }) => memoryContextFor(ws, (p) => matchesAnyPathPattern(p, task.contract.filesAllowed)),
          // Values in memory only, so the agent's summary never carries a key into evidence.
          // Browser session secrets (M4 slice o1) are redacted from the summary and brief as well as from tool evidence.
          redactValues: [...(mt.adapter.credential && process.env[mt.adapter.credential.env] ? [process.env[mt.adapter.credential.env]!] : []), ...Object.values(mt.tier.secrets), ...plan.plan.tasks.flatMap((x) => x.browser?.secrets ?? []).map((x) => process.env[x.ref.slice(4)]).filter((v): v is string => Boolean(v))],
        });

      // Span evidence: one provider per run, records written as the run's own evidence, flushed by the engine at every exit.
      const spans = tracingFor(ws, held, project.config);
      const tracing = spans.factory;
      const spanAttributesFor = (taskId: string, acceptanceIds: readonly string[], mt: MemberTier) => ({
        [SPAN_ATTRIBUTES.TASK_ID]: taskId,
        [SPAN_ATTRIBUTES.AC_ID]: [...acceptanceIds],
        [SPAN_ATTRIBUTES.ADAPTER_ID]: mt.adapter.id,
        [SPAN_ATTRIBUTES.GEN_AI_MODEL]: mt.member.model ?? `vendor-default:${mt.adapter.id}`,
      });
      const controller = new AbortController();
      const onSignal = (signal: NodeJS.Signals) => controller.abort(new Error(`received ${signal}`));
      const install = opts.installSignalHandlers ?? true;
      if (install) for (const s of SIGNALS) process.on(s, onSignal);
      try {
        const outcomes: { taskId: string; result: EngineResult }[] = [];
        const notes: Diagnostic[] = [];
        let firstPending: { id: string; kind: string; payloadRef: { path: string; sha256: string }; path: string; runId: string } | null = null;
        const planOrder = (taskId: string) => plan.plan.tasks.findIndex((t) => t.id === taskId);
        const inputFor = (task: (typeof plan.plan.tasks)[number], member: RunMember, withhold = false): TaskInput => ({
          workspaceRoot: ws.root,
          planId: plan.id,
          task,
          acceptanceCriteria: spec.spec.acceptanceCriteria,
          receiptChecks: planReceipt.checks ?? [],
          riskTier: tier,
          ...(member.model ? { model: member.model } : {}),
          member: { id: member.id, adapter: member.adapter, ...(member.model ? { model: member.model } : {}), reason: member.reason },
          ...(limits ? { limits } : {}),
          ...(planReceipt.browserScripts ? { protectedPaths: Object.keys(planReceipt.browserScripts) } : {}),
          ...(withhold ? { withholdFailedChecks: true } : {}),
        });
        const start = async (task: (typeof plan.plan.tasks)[number], withhold = false, toolCallsUsed = 0) => {
          await toolsTierCheck(task);
          const mt = await tierFor(routeOf(task));
          tierOfTask.set(task.id, mt);
          const gw = await gatewayFor(task, mt, toolCallsUsed);
          const steps = await stepsFor(task, gw);
          return runWorkflow(ws, workflowFor("pending", mt, "task", gw, steps), held, {
            input: inputFor(task, mt.member, withhold) as unknown as Record<string, unknown>,
            task: { planId: plan.id, taskId: task.id },
            member: mt.member,
            ...(task.coordinate ? { coordinate: { steps: stepMembersOf(task) } } : {}),
            riskTier: tier,
            durability,
            signal: controller.signal,
            now: () => now,
            tracing,
            spanAttributes: spanAttributesFor(task.id, task.acceptanceIds, mt),
          }).then((result) => ({ taskId: task.id, result }));
        };

        if (opts.resume) {
          // Orphaned broadcasts of this plan (M4 slice v) are recovered after the ordinary settling below.
          const orphansIn = (list: readonly LoadedRun[]) => [...orphanedBroadcasts(list)].map(([id, members]) => ({ id, members })).filter((o) => o.members.every((m) => m.run.kind === "workflow" && m.run.task?.planId === plan.id));
          // Before settling, a broadcast with a member left running is not yet an orphan; it may become one below.
          const memberStillOpen = incomplete.some((r) => r.run.kind === "workflow" && r.run.broadcast?.role === "member");
          if (incomplete.length === 0 && orphansIn(allRuns).length === 0 && !memberStillOpen) return refuse("no_run_to_resume", "No incomplete task run exists; start one with 'legion-flow execute'.");
          // Every decided, expired, or crashed run is settled, in plan order; a pending one is named and left waiting.
          const ordered = [...incomplete].sort((a, b) => planOrder((a.run as { task: { taskId: string } }).task.taskId) - planOrder((b.run as { task: { taskId: string } }).task.taskId));
          // Every member's tier is prepared before any run moves, so a refusal never hides an apply that already happened.
          // A broadcast's choice run applies a proposal already made and spawns nothing, so it needs no adapter (M4 slice t).
          const isChoiceRun = (t: (typeof ordered)[number]) => t.run.kind === "workflow" && t.run.workflowId === BROADCAST_WORKFLOW_ID;
          for (const target of ordered) {
            if (isChoiceRun(target)) continue;
            await tierFor((target.run.kind === "workflow" && target.run.member) || defaultMember());
            if (target.run.kind === "workflow" && target.run.coordinate) for (const s of target.run.coordinate.steps) await tierFor(s);
          }
          for (const target of ordered) {
            const taskId = (target.run as { task: { taskId: string } }).task.taskId;
            const open = (await ws.interrupts.list(target.run.id, now)).find((i) => !i.interrupt.consumedAt && i.effectiveStatus !== "cancelled");
            if (open && open.effectiveStatus === "pending") {
              firstPending ??= { id: open.interrupt.id, kind: open.interrupt.kind, payloadRef: open.interrupt.payloadRef, path: open.path, runId: target.run.id };
              notes.push({ code: "decision_pending", severity: "warning", message: `Run ${target.run.id} (${taskId}) waits on ${open.interrupt.id}; decide it before resuming.`, path: open.path });
              continue;
            }
            const resumedTask = plan.plan.tasks.find((t) => t.id === taskId);
            if (isChoiceRun(target)) {
              const member = (target.run.kind === "workflow" && target.run.member) || defaultMember();
              const adapter = adapterFor(member.adapter, project.config) ?? defaultAdapter;
              const wf = broadcastWorkflow({ ws, materializer: createMaterializer({ tier: "unhardened", strategy: "copy", paths: ws.paths, runId: target.run.id })!, adapter, runCheck: checkRunner, architecture: architecturePort, now: () => now });
              const spanAttributes = { [SPAN_ATTRIBUTES.TASK_ID]: taskId, [SPAN_ATTRIBUTES.AC_ID]: [...(resumedTask?.acceptanceIds ?? [])], [SPAN_ATTRIBUTES.ADAPTER_ID]: adapter.id, [SPAN_ATTRIBUTES.GEN_AI_MODEL]: member.model ?? `vendor-default:${adapter.id}` };
              const choiceOptions = { signal: controller.signal, now: () => now, tracing, spanAttributes };
              const result = open ? await resumeWorkflow(ws, wf, target.run.id, open.interrupt.id, held, choiceOptions) : await continueRun(ws, wf, target.run.id, held, choiceOptions);
              outcomes.push({ taskId, result });
              continue;
            }
            // Resume uses the member recorded on the run, never a fresh route: the config may have changed since.
            const mt = await tierFor((target.run.kind === "workflow" && target.run.member) || defaultMember());
            const resumeOptions = { signal: controller.signal, now: () => now, tracing, spanAttributes: spanAttributesFor(taskId, resumedTask?.acceptanceIds ?? [], mt) };
            tierOfTask.set(taskId, mt);
            const isChoice = target.run.kind === "workflow" && target.run.workflowId === BROADCAST_WORKFLOW_ID;
            const resumedGw = isChoice || !resumedTask ? undefined : await gatewayFor(resumedTask, mt);
            const wf = workflowFor(target.run.id, mt, isChoice ? "broadcast" : "task", resumedGw, !isChoice && resumedTask ? await stepsFor(resumedTask, resumedGw, target.run.kind === "workflow" ? target.run.coordinate?.steps : undefined) : undefined);
            const result = open ? await resumeWorkflow(ws, wf, target.run.id, open.interrupt.id, held, resumeOptions) : await continueRun(ws, wf, target.run.id, held, resumeOptions);
            outcomes.push({ taskId, result });
          }
          // A broadcast whose members all ended but whose choice run never came to exist (a crash between the two):
          // the choice is rebuilt from the members' own records with the same assembly a live broadcast uses, and opened
          // without preparing any adapter, since opening and applying a choice spawn nothing. Ties break by declaration
          // order (the original --members order is not recorded on the member runs).
          // Recomputed after the settling above: a member a crash left running has just been failed, so its broadcast is an orphan now.
          for (const o of orphansIn(await ws.runs.list())) {
            const taskId = (o.members[0]!.run as { task: { taskId: string } }).task.taskId;
            const known = plan.plan.tasks.find((t) => t.id === taskId);
            if (!known) {
              notes.push({ code: "broadcast_not_recovered", severity: "warning", message: `Broadcast ${o.id}: task ${taskId} is no longer in the plan, so its proposals stay as they are.` });
              continue;
            }
            if (appliedTaskIds(plan.id, await ws.runs.list()).has(taskId)) {
              notes.push({ code: "broadcast_not_recovered", severity: "info", message: `Broadcast ${o.id}: task ${taskId} is already applied, so there is nothing to choose.` });
              continue;
            }
            const order = memberIds(project.config.coordinator);
            const memberOf = (r: (typeof o.members)[number]) => (r.run.kind === "workflow" && r.run.member) || defaultMember();
            // A member no longer declared sorts last rather than first.
            const rankOf = (r: (typeof o.members)[number]) => (order.includes(memberOf(r).id) ? order.indexOf(memberOf(r).id) : order.length);
            const sorted = [...o.members].sort((a, b) => rankOf(a) - rankOf(b));
            const results = await Promise.all(sorted.map(async (r) => {
              const member = memberOf(r);
              if (r.run.status === "complete") return { member, result: { kind: "complete", runId: r.run.id, values: ((await ws.runs.loadLatestSnapshot(r.run.id))?.values ?? {}) as Record<string, unknown> } };
              const reason = r.run.kind === "workflow" ? r.run.reason : undefined;
              return { member, result: { kind: r.run.status === "failed" ? "failed" : "cancelled", runId: r.run.id, ...(reason ? { error: reason, reason } : {}) } };
            }));
            const assembled = await assembleChoice(results);
            notes.push({ code: "broadcast_recovered", severity: "warning", message: `Broadcast ${o.id} for ${taskId} had no choice run (it stopped between its members and the choice); recovered from ${sorted.length} member run(s): ${sorted.map((r) => r.run.id).join(", ")}.` }, ...assembled.lines);
            if (Object.keys(assembled.proposals).length === 0) {
              notes.push({ code: "broadcast_no_proposal", severity: "warning", message: `No member of ${o.id} produced a proposal, so there is nothing to choose; the checkout is untouched.` });
              continue;
            }
            const choiceMember = memberOf(sorted[0]!);
            const adapter = adapterFor(choiceMember.adapter, project.config) ?? defaultAdapter;
            const wf = broadcastWorkflow({ ws, materializer: createMaterializer({ tier: "unhardened", strategy: "copy", paths: ws.paths, runId: "pending" })!, adapter, runCheck: checkRunner, architecture: architecturePort, now: () => now });
            const choice = await runWorkflow(ws, wf, held, {
              input: { ...inputFor(known, choiceMember), broadcastId: o.id, candidates: assembled.candidates, proposals: assembled.proposals, recommendation: assembled.recommendation, sourceFiles: assembled.sourceFiles, ...(assembled.materializedAt ? { materializedAt: assembled.materializedAt } : {}) } as unknown as Record<string, unknown>,
              task: { planId: plan.id, taskId },
              broadcast: { id: o.id, role: "choice" },
              riskTier: tier,
              durability,
              signal: controller.signal,
              now: () => now,
              tracing,
              spanAttributes: { [SPAN_ATTRIBUTES.TASK_ID]: taskId, [SPAN_ATTRIBUTES.AC_ID]: [...known.acceptanceIds], [SPAN_ATTRIBUTES.ADAPTER_ID]: adapter.id, [SPAN_ATTRIBUTES.GEN_AI_MODEL]: choiceMember.model ?? `vendor-default:${adapter.id}` },
            });
            await ws.audit.append({ type: "broadcast_recovered", broadcastId: o.id, choiceRunId: choice.runId ?? null, taskId, members: sorted.map((r) => r.run.id) }, held);
            outcomes.push({ taskId, result: choice });
          }
          // Only orphans that could not be recovered: say why, and that nothing else was waiting.
          if (outcomes.length === 0 && !firstPending) return envelope("execute", "ok", project.phase, notes, nextActionFor(project.phase));
          if (outcomes.length === 0 && firstPending) {
            return envelope("execute", "awaiting_decision", project.phase, notes, {
              type: "human_decision",
              interruptId: firstPending.id,
              decisionKind: firstPending.kind as "approve_action",
              run: `legion-flow decide ${firstPending.id} --approve --approver <id>`,
              payloadRef: firstPending.payloadRef,
              responseSchema: SCHEMA_VERSIONS.DECISION,
            });
          }
        } else {
          if (incomplete.length > 0) {
            return refuse("run_in_progress", `Task run ${incomplete[0]!.run.id} is ${incomplete[0]!.run.status}; finish it with 'legion-flow execute --resume' first.`);
          }
          const batch = jobs > 1 ? selectBatch(plan.plan, runs, jobs) : null;
          if (opts.broadcast) {
            // M4 slice j2: the same task once per member, each withheld; then one human choice among the proposals.
            const known = plan.plan.tasks.find((t) => t.id === opts.taskId);
            if (!known) return refuse("task_unknown", `Task '${opts.taskId}' is not in the current plan (${plan.plan.tasks.map((t) => t.id).join(", ")}).`);
            if (known.coordinate) return refuse("broadcast_coordinate", `Task ${known.id} declares coordinate steps; a broadcast runs one member per run, so the two strategies do not combine.`, "FIX: run it with legion-flow execute, or remove coordinate from the task (the plan then needs approval again).");
            if (appliedTaskIds(plan.id, runs).has(known.id)) return refuse("task_already_applied", `Task '${known.id}' is already applied.`);
            const sel = selectNextTask(plan.plan, runs, known.id);
            if (sel.kind !== "task") return refuse("dependencies_unapplied", sel.kind === "blocked" ? sel.reason : "the task cannot run now");
            const ids = opts.members !== undefined ? opts.members.split(",").map((s) => s.trim()).filter(Boolean) : memberIds(project.config.coordinator);
            if (new Set(ids).size !== ids.length) return refuse("broadcast_members_invalid", "--members names a member twice.");
            const max = project.config.coordinator?.maxBroadcast ?? BROADCAST_DEFAULT_MAX;
            if (ids.length < 2) return refuse("broadcast_needs_members", `A broadcast needs at least two members; ${ids.length === 1 ? `only '${ids[0]}' would take part` : "none would"}.`, "FIX: declare members in project.json coordinator.members, or name two with --members.");
            if (ids.length > max) return refuse("broadcast_too_many", `${ids.length} members would take part; the cap is ${max} (coordinator.maxBroadcast, at most 4).`, "FIX: name the members with --members, or raise coordinator.maxBroadcast (a config change that needs new approvals).");
            const participants: RunMember[] = ids.map((id) => {
              const routed = routeTask(project.config, { member: id, contract: known.contract });
              if (!routed.ok) throw new PreparedRefusal(refuse("delegation_rejected", `Broadcast member: ${routed.reason}.`));
              return { ...routed.member, reason: "broadcast" };
            });
            const tiers: MemberTier[] = [];
            await toolsTierCheck(known);
            for (const m of participants) tiers.push(await tierFor(m));
            const broadcastId = newId("bcs");
            const first = tiers[0]!.tier;
            notes.push({ code: "execute_broadcast", severity: "info", message: `Broadcasting ${known.id} to ${participants.length} members (${participants.map((m) => m.id).join(", ")}) as ${broadcastId}: ${participants.length} runs in parallel, none applies by itself.${first.report.isSandbox ? ` Up to ${participants.length} containers may run at once, each with ${first.dockerSettings.memory} memory and ${first.dockerSettings.cpus} CPUs.` : ""}` });
            const settled = await Promise.allSettled(
              tiers.map(async (mt) =>
                runWorkflow(ws, workflowFor("pending", mt, "task", await gatewayFor(known, mt)), held, {
                  input: { ...inputFor(known, mt.member), withholdAlways: true } as unknown as Record<string, unknown>,
                  task: { planId: plan.id, taskId: known.id },
                  member: mt.member,
                  broadcast: { id: broadcastId, role: "member" },
                  riskTier: tier,
                  durability,
                  signal: controller.signal,
                  now: () => now,
                  tracing,
                  spanAttributes: spanAttributesFor(known.id, known.acceptanceIds, mt),
                }).then((result) => ({ mt, result })).catch((err: unknown) => {
                  controller.abort(err instanceof Error ? err : new Error(String(err)));
                  throw err;
                })
              )
            );
            const rejection = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
            if (rejection) throw rejection.reason;
            const results = settled.map((x) => (x as PromiseFulfilledResult<{ mt: MemberTier; result: EngineResult }>).value);
            const assembled = await assembleChoice(results.map(({ mt, result }) => ({ member: mt.member, result: result as unknown as Parameters<typeof assembleChoice>[0][number]["result"] })));
            const { candidates, proposals, sourceFiles, materializedAt, recommendation } = assembled;
            notes.push(...assembled.lines);
            if (Object.keys(proposals).length === 0) {
              const after = await ws.project.load(now);
              return envelope("execute", "blocked", phaseOf(after), [...notes, { code: "broadcast_no_proposal", severity: "error", message: `No member of ${broadcastId} produced a proposal, so there is nothing to choose; the checkout is untouched.` }], nextActionFor(phaseOf(after)));
            }
            if (!recommendation) notes.push({ code: "broadcast_no_recommendation", severity: "warning", message: "No proposal passed every check without breaking a rule, so nothing is recommended; a decision owner may still choose one with --edit." });
            const choiceTier = tiers[0]!;
            const choice = await runWorkflow(ws, workflowFor("pending", choiceTier, "broadcast"), held, {
              input: { ...inputFor(known, choiceTier.member), broadcastId, candidates, proposals, recommendation, sourceFiles, ...(materializedAt ? { materializedAt } : {}) } as unknown as Record<string, unknown>,
              task: { planId: plan.id, taskId: known.id },
              broadcast: { id: broadcastId, role: "choice" },
              riskTier: tier,
              durability,
              signal: controller.signal,
              now: () => now,
              tracing,
              spanAttributes: spanAttributesFor(known.id, known.acceptanceIds, choiceTier),
            });
            outcomes.push({ taskId: known.id, result: choice });
          } else if (batch && batch.tasks.length > 1) {
            for (const d of batch.deferred) notes.push({ code: "task_deferred", severity: "info", message: `${d.taskId} waits for a later batch: ${d.reason}.` });
            // Every task in the batch is routed and its tier prepared before any run starts: an undelegatable task refuses the whole batch.
            for (const t of batch.tasks) await tierFor(routeOf(t));
            const first = used[0]!.tier;
            notes.push({ code: "execute_batch", severity: "info", message: `Running ${batch.tasks.length} task(s) in parallel (${batch.tasks.map((t) => t.id).join(", ")}); applies go one at a time per checkout, in the order runs finish, rebasing on earlier applies.${first.report.isSandbox ? ` Up to ${batch.tasks.length} containers may run at once, each with ${first.dockerSettings.memory} memory and ${first.dockerSettings.cpus} CPUs.` : ""}` });
            // allSettled, not all: the engine lock must outlive every run. An unexpected error stops the siblings
            // (the abort signal) and is rethrown only once all of them have settled.
            const settled = await Promise.allSettled(batch.tasks.map((t) => start(t).catch((err: unknown) => { controller.abort(err instanceof Error ? err : new Error(String(err))); throw err; })));
            const firstRejection = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
            if (firstRejection) throw firstRejection.reason;
            outcomes.push(...settled.map((x) => (x as PromiseFulfilledResult<{ taskId: string; result: EngineResult }>).value));
          } else {
            // After a FAIL review, the way out is to re-execute the rejected task: allowed only by name and only then.
            const latestReview = runs
              .flatMap((r) => (r.run.kind === "workflow" && r.run.workflowId === "review" && r.run.status === "complete" && r.run.review ? [r.run.review] : []))
              .at(-1);
            const reviewFailedHere =
              latestReview?.verdict === "FAIL" &&
              latestReview.fingerprints.spec === spec.fingerprint &&
              latestReview.fingerprints.plan === plan.fingerprint &&
              latestReview.fingerprints.config === config;
            const rerunTask = opts.taskId && reviewFailedHere && appliedTaskIds(plan.id, runs).has(opts.taskId) ? plan.plan.tasks.find((t) => t.id === opts.taskId) : undefined;
            const selection: ReturnType<typeof selectNextTask> = rerunTask ? { kind: "task", task: rerunTask } : selectNextTask(plan.plan, runs, opts.taskId);
            if (selection.kind === "all_applied") {
              if (opts.taskId && plan.plan.tasks.some((t) => t.id === opts.taskId)) return refuse("task_already_applied", `Task '${opts.taskId}' is already applied; an applied task runs again only after a review at the current fingerprints failed.`);
              return refuse("no_task_remaining", "Every task in the plan is applied.", "Next: legion-flow ship", nextActionFor("plan_ready"));
            }
            if (selection.kind === "blocked") {
              const known = plan.plan.tasks.some((t) => t.id === opts.taskId);
              if (opts.taskId && !known) return refuse("task_unknown", `Task '${opts.taskId}' is not in the current plan (${plan.plan.tasks.map((t) => t.id).join(", ")}).`);
              if (opts.taskId && !selection.remaining.includes(opts.taskId)) return refuse("task_already_applied", `Task '${opts.taskId}' is already applied; an applied task runs again only after a review at the current fingerprints failed.`);
              return refuse("dependencies_unapplied", selection.reason);
            }
            if (batch) notes.push({ code: "execute_batch", severity: "info", message: `Only ${selection.task.id} can run now (${batch.deferred.length ? batch.deferred.map((d) => `${d.taskId}: ${d.reason}`).join("; ") : "no other task has its dependencies applied"}).` });
            // --retry (M4 slice g): every attempt but the last may withhold a failing R0 proposal; a retryable end starts the next attempt.
            // The attempts share the task's tool budget (M4 slice w): each starts with what the earlier ones left.
            let toolCallsUsed = 0;
            for (let attempt = 0; ; attempt++) {
              const last = attempt >= retries;
              const r = await start(selection.task, !last && tier === "R0", toolCallsUsed);
              if (r.result.runId && selection.task.tools?.length) toolCallsUsed += (await Promise.all(((await ws.runs.load(r.result.runId))?.evidenceIndex ?? []).filter((e) => e.producedBy === "tools").map(async (e) => (JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { kind?: string }).kind))).filter((k) => k === "tool_call").length;
              const code = r.result.kind === "failed" ? (/^([a-z_]+): /.exec(r.result.error)?.[1] ?? null) : null;
              const withheld = r.result.kind === "complete" && r.result.values.outcome === "withheld";
              const retryable = withheld || (code !== null && RETRYABLE_CODES.has(code));
              if (last || !retryable || controller.signal.aborted) {
                outcomes.push(r);
                break;
              }
              if (r.result.kind === "failed") await ws.audit.append({ type: "execution_failed", runId: r.result.runId, taskId: r.taskId, reason: r.result.error }, held);
              notes.push({ code: "execution_retry", severity: "warning", message: `Attempt ${attempt + 1} of ${retries + 1} (run ${r.result.runId}) ${withheld ? "proposed changes whose checks did not all pass; withheld, nothing applied" : `failed with ${code}`}. Starting attempt ${attempt + 2} with that in its brief.`, ...(r.result.runId ? { path: join(ws.paths.runsDir, r.result.runId) } : {}) });
            }
          }
        }

        const after = await ws.project.load(now);
        const phase = phaseOf(after);
        const common: Diagnostic[] = [
          ...(used[0] ? [{ code: "sandbox_tier", severity: (used[0].tier.report.isSandbox ? "info" : "warning") as "info" | "warning", message: `Tier ${used[0].tier.report.tier} (${used[0].tier.strategy} tree, ${used[0].tier.sourceMode} listing): ${used[0].tier.report.caveats[0]}.` }] : []),
          ...[...new Map(used.map((u) => [u.adapter.id, u.tier.credentialDiagnostics])).values()].flat(),
          ...[...new Map(used.map((u) => [`${u.member.id}`, u])).values()].filter((u) => u.member.id !== DEFAULT_MEMBER_ID || u.member.reason !== "default").map((u) => ({ code: "task_member", severity: "info" as const, message: `Member ${u.member.id} (${u.member.adapter}${u.member.model ? `, ${u.member.model}` : ""}) chosen by ${u.member.reason}.` })),
          ...spans.diagnostics(),
          ...mapNotes,
          ...notes,
        ];
        type Described = { status: ResultEnvelope["status"]; diagnostics: Diagnostic[]; next?: ResultEnvelope["nextAction"]; runId?: string };
        const describe = async ({ taskId, result }: { taskId: string; result: EngineResult }): Promise<Described> => {
          const head: Diagnostic = { code: "task", severity: "info", message: `Task ${taskId} via adapter ${tierOfTask.get(taskId)?.adapter.id ?? defaultAdapter.id}${tierOfTask.get(taskId) && tierOfTask.get(taskId)!.member.id !== DEFAULT_MEMBER_ID ? ` (member ${tierOfTask.get(taskId)!.member.id})` : ""} at risk tier ${tier}.` };
          switch (result.kind) {
            case "complete": {
              const outcome = String(result.values.outcome ?? "complete");
              const messages: Record<string, string> = {
                auto_applied: `Proposal applied automatically at ${tier} (run ${result.runId}).`,
                applied: `Proposal applied after a human decision (run ${result.runId}).`,
                no_changes: `The adapter changed nothing in contract; nothing to apply (run ${result.runId}).`,
                rejected: `Proposal rejected; the checkout is untouched (run ${result.runId}).`,
                withheld: `Proposal withheld: a check did not pass; nothing was applied (run ${result.runId}).`,
              };
              return { status: "ok", runId: result.runId, diagnostics: [head, { code: `execution_${outcome}`, severity: "info", message: messages[outcome] ?? `Run ${result.runId} completed (${outcome}).`, path: join(ws.paths.runsDir, result.runId) }] };
            }
            case "awaiting_decision": {
              const i = result.interrupt;
              if (i.action.name === CHOOSE_PROPOSAL_ACTION) {
                return {
                  status: "awaiting_decision",
                  runId: result.runId,
                  diagnostics: [{ code: "broadcast_choice", severity: "warning", message: `Broadcast run ${result.runId} awaits a decision owner's choice until ${i.expiresAt}: --approve takes the recommendation, --edit '{"member":"<id>"}' picks another, --reject applies nothing.`, path: join(ws.paths.project, ...i.payloadRef.path.split("/")) }],
                  next: { type: "human_decision", interruptId: i.id, decisionKind: i.kind, run: `legion-flow decide ${i.id} --approve --approver <id>`, payloadRef: i.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION },
                };
              }
              return {
                status: "awaiting_decision",
                runId: result.runId,
                diagnostics: [head, ...(await architectureDiagnostics(ws, i.payloadRef.path, Boolean(rules))), { code: "proposal_pending", severity: "warning", message: `Run ${result.runId} proposed changes (${i.action.riskClass}); a decision owner must approve before anything reaches the checkout. Expires ${i.expiresAt}.`, path: join(ws.paths.project, ...i.payloadRef.path.split("/")) }],
                next: { type: "human_decision", interruptId: i.id, decisionKind: i.kind, run: `legion-flow decide ${i.id} --approve --approver <id>`, payloadRef: i.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION },
              };
            }
            case "failed":
            case "cancelled": {
              const reason = result.kind === "failed" ? result.error : result.reason;
              await ws.audit.append({ type: result.kind === "failed" ? "execution_failed" : "execution_cancelled", runId: result.runId, taskId, reason }, held);
              return {
                status: "blocked",
                runId: result.runId,
                diagnostics: [head, { code: result.kind === "failed" ? "execution_failed" : "execution_cancelled", severity: "error", message: `Run ${result.runId} ${result.kind}: ${reason}`, path: join(ws.paths.runsDir, result.runId) }, { code: "sandbox_tree_kept", severity: "info", message: "The materialized tree is kept for inspection.", path: join(ws.paths.sandboxDir, result.runId, "tree") }],
                next: nextActionFor(phase),
              };
            }
            case "refused":
              return { status: "refused", ...(result.runId ? { runId: result.runId } : {}), diagnostics: [head, { code: result.code, severity: "error", message: result.message }], next: nextActionFor(phase) };
          }
        };
        const described = await Promise.all(outcomes.sort((a, b) => planOrder(a.taskId) - planOrder(b.taskId)).map(describe));
        const rank = (s: ResultEnvelope["status"]) => (s === "refused" ? 0 : s === "blocked" ? 1 : s === "awaiting_decision" ? 2 : 3);
        const worst = described.reduce<Described | null>((w, d) => (w === null || rank(d.status) < rank(w.status) ? d : w), null)!;
        const pendingNext: ResultEnvelope["nextAction"] | undefined = firstPending
          ? { type: "human_decision", interruptId: firstPending.id, decisionKind: firstPending.kind as "approve_action", run: `legion-flow decide ${firstPending.id} --approve --approver <id>`, payloadRef: firstPending.payloadRef, responseSchema: SCHEMA_VERSIONS.DECISION }
          : undefined;
        const status: ResultEnvelope["status"] = worst.status === "ok" && firstPending ? "awaiting_decision" : worst.status;
        const next = worst.next ?? pendingNext ?? (phase === "plan_ready" ? await planReadyNextAction(ws) : nextActionFor(phase));
        return envelope("execute", status, phase, [...common, ...described.flatMap((d) => d.diagnostics), ...phaseReasonDiagnostics(after)], next, [], described.length === 1 ? described[0]!.runId : undefined);
      } finally {
        if (install) for (const s of SIGNALS) process.off(s, onSignal);
        for (const gw of gateways) await gw.close().catch(() => undefined);
      }
    }, opts.resume ? "execute --resume" : "execute");
  } catch (err: unknown) {
    if (err instanceof PreparedRefusal) return err.envelope;
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("execute", ws, err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// planned verbs
// ---------------------------------------------------------------------------

/**
 * A catalog verb that is designed but not yet built. It registers so a host
 * gets a typed refusal naming the milestone, in the same shape as every other
 * result, instead of Commander's unknown-command text.
 */
export function plannedVerbCommand(name: string, milestone: string): CommandHandler<Record<string, unknown>> {
  return async (ctx) =>
    envelope(
      name,
      "refused",
      phaseOf(await ctx.workspace.project.load()),
      [
        {
          code: "verb_not_implemented",
          severity: "error",
          message: `'legion-flow ${name}' is planned for milestone ${milestone} and is not implemented yet.`,
          hint: "See docs/ARCHITECTURE.md section 13 for the milestone plan.",
        },
      ],
      { type: "command", run: "legion-flow status", hint: "Use the implemented verbs: init, status, next, doctor, spec, plan, approve, execute, review, eval, decide, ship, mcp, map." }
    );
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const DOCTOR_SEVERITY: Record<DiagnosticItem["status"], Diagnostic["severity"]> = {
  pass: "info",
  warn: "warning",
  fail: "error",
};

export function doctorItemToDiagnostic(item: DiagnosticItem): Diagnostic {
  return {
    code: item.code,
    severity: DOCTOR_SEVERITY[item.status],
    message: item.message,
    ...(item.fixHint ? { hint: item.fixHint } : {}),
  };
}

export interface DoctorOptions {
  metrics?: boolean;
  rebaselineAudit?: boolean;
  reason?: string;
  approver?: string;
  /** Test seam. */
  now?: Date;
}

/** Read-only facts about the project, as `metric_*` info diagnostics. Nothing is computed that is not already on disk. */
async function collectMetrics(ws: Workspace): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const metric = (name: string, value: string | number) => out.push({ code: `metric_${name}`, severity: "info", message: `${name}: ${value}` });
  const runs = await ws.runs.list();
  const byKind: Record<string, number> = {};
  for (const r of runs) byKind[`${r.run.kind}/${r.run.status}`] = (byKind[`${r.run.kind}/${r.run.status}`] ?? 0) + 1;
  metric("runs_total", runs.length);
  for (const [k, v] of Object.entries(byKind).sort()) metric(`runs_${k.replace("/", "_")}`, v);
  const plan = await ws.plans.current();
  if (plan && plan.kind === "valid") {
    const applied = appliedTaskIds(plan.id, runs).size;
    metric("tasks_applied", `${applied} of ${plan.plan.tasks.length}`);
  }
  let pending = 0;
  let expired = 0;
  for (const r of runs) {
    if (r.run.kind !== "workflow") continue;
    for (const i of await ws.interrupts.list(r.run.id)) {
      if (i.effectiveStatus === "pending") pending += 1;
      if (i.effectiveStatus === "expired") expired += 1;
    }
  }
  metric("interrupts_pending", pending);
  metric("interrupts_expired", expired);
  metric("releases", (await ws.releases.list()).length);
  const audit = await ws.audit.verify();
  metric("audit_events", audit.verifiedCount);
  // Usage and egress from adapter_outcome evidence.
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let known = 0;
  let unknown = 0;
  let requests = 0;
  let denied = 0;
  for (const r of runs) {
    if (r.run.kind !== "workflow") continue;
    let names: string[] = [];
    try {
      names = await readdir(join(r.dir, "evidence"));
    } catch {
      continue;
    }
    for (const name of names) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(await readFile(join(r.dir, "evidence", name), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.kind !== "adapter_outcome") continue;
      const usage = record.usage as { known: boolean; turns?: number | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null } | undefined;
      if (usage?.known) {
        known += 1;
        turns += usage.turns ?? 0;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        costUsd += usage.costUsd ?? 0;
      } else {
        unknown += 1;
      }
      const egress = record.egress as { shape?: string; summary?: { requests: number; denied: number } | null } | undefined;
      if (egress?.shape === "proxy" && egress.summary) {
        requests += egress.summary.requests;
        denied += egress.summary.denied;
      }
    }
  }
  // Counted per adapter run: a coordinate task (M4 slice m) has one per step and round.
  const unknownNote = unknown > 0 ? ` (unknown for ${unknown} adapter run${unknown === 1 ? "" : "s"} that reported none)` : "";
  metric("usage_turns", known > 0 ? `${turns}${unknownNote}` : `unknown${unknownNote}`);
  metric("usage_tokens", known > 0 ? `${inputTokens} in, ${outputTokens} out${unknownNote}` : `unknown${unknownNote}`);
  metric("usage_cost_usd", known > 0 ? `${costUsd.toFixed(4)}${unknownNote}` : `unknown${unknownNote}`);
  metric("egress_requests", `${requests} (${denied} denied)`);
  return out;
}

export const doctorCommand: CommandHandler<DoctorOptions> = async (ctx, opts) => {
  const ws = ctx.workspace;
  if (opts.rebaselineAudit) return rebaselineAudit(ctx, opts);
  const report = await runDoctor(ws);
  const diagnostics = report.diagnostics.map(doctorItemToDiagnostic);
  if (opts.metrics && report.project.kind === "valid") diagnostics.push(...(await collectMetrics(ws)));
  if (opts.metrics && report.project.kind !== "valid") diagnostics.push({ code: "metrics_unavailable", severity: "info", message: "No valid project here, so there are no metrics to report." });

  let nextAction: ResultEnvelope["nextAction"];
  if (!report.allPassed) {
    nextAction = { type: "command", run: "legion-flow doctor", hint: "Re-run after applying the FIX lines above." };
  } else if (report.project.kind !== "valid") {
    nextAction = { type: "command", run: "legion-flow init --adapter <id>", hint: "Readiness passed. Initialize a project next." };
  } else {
    nextAction = { type: "command", run: "legion-flow status", hint: "Readiness passed." };
  }

  return envelope("doctor", report.allPassed ? "ok" : "blocked", phaseOf(report.project), diagnostics, nextAction);
};

/**
 * The one audit repair, human-only: a decision owner on a terminal, a reason of
 * substance, and a chain that actually fails verification. The outcome is a
 * recorded baseline event; history is never rewritten.
 */
async function rebaselineAudit(ctx: Parameters<CommandHandler>[0], opts: DoctorOptions): Promise<ResultEnvelope> {
  const ws = ctx.workspace;
  const now = opts.now ?? new Date();
  const project = await ws.project.load(now);
  const phase = phaseOf(project);
  const usage = (code: string, message: string) =>
    envelope("doctor", "usage_error", phase, [{ code, severity: "error", message }], { type: "command", run: 'legion-flow doctor --rebaseline-audit --reason "<24+ chars>" --approver <id>' });
  if (!opts.reason || opts.reason.trim().length < 24) return usage("rebaseline_reason_required", "--rebaseline-audit needs --reason with at least 24 characters of substance.");
  if (!opts.approver) return usage("approver_required", "--rebaseline-audit needs --approver <id>, a decision owner of this project.");
  if (project.kind !== "valid") return projectUnusableRefusal("doctor", project);
  const owner = project.config.decisionOwners.find((o) => o.id === opts.approver);
  if (!owner) {
    return envelope("doctor", "refused", phase, [
      { code: "approver_not_decision_owner", severity: "error", message: `'${opts.approver}' is not a decision owner of this project (owners: ${project.config.decisionOwners.map((o) => o.id).join(", ")}).` },
    ], nextActionFor(phase));
  }
  if (!ctx.isTTY) {
    return envelope("doctor", "refused", phase, [{ code: "rebaseline_requires_tty", severity: "error", message: "An audit rebaseline is a human act and is honored only on an interactive terminal." }], nextActionFor(phase));
  }
  try {
    return await ws.lock.withLock(async (held) => {
      const before = await ws.audit.verify();
      if (before.valid) {
        return envelope("doctor", "refused", phase, [
          { code: "audit_rebaseline_unneeded", severity: "error", message: `The audit chain verifies clean (${before.verifiedCount} events); there is nothing to rebaseline.` },
        ], nextActionFor(phase));
      }
      const outcome = await ws.audit.rebaseline(opts.reason!.trim(), owner.id, held, now);
      const after = await ws.audit.verify();
      const diagnostics: Diagnostic[] = [
        { code: "audit_rebaselined", severity: "warning", message: `Audit chain rebaselined by ${owner.id}: ${outcome.keptLines} event(s) kept as an archived region, ${outcome.quarantinedLines} quarantined, prior verification: ${before.error ?? "invalid"}.`, path: ws.paths.chainJson },
        ...(outcome.quarantinePath ? [{ code: "audit_quarantine", severity: "info" as const, message: `Unparseable tail moved aside (${outcome.quarantinedBytes} bytes).`, path: outcome.quarantinePath }] : []),
        ...(outcome.archivedChainPath ? [{ code: "audit_chain_archived", severity: "info" as const, message: "The replaced chain index was archived.", path: outcome.archivedChainPath }] : []),
        { code: "audit_chain", severity: after.valid ? "info" : "error", message: after.valid ? `Audit chain verifies: ${after.verifiedCount} events, baselined at seq ${outcome.state.baseline?.seq}.` : `Audit chain still fails: ${after.error}` },
      ];
      return envelope("doctor", after.valid ? "ok" : "blocked", phase, diagnostics, nextActionFor(phase));
    }, "doctor --rebaseline-audit");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return lockHeldRefusal("doctor", ws, err);
    throw err;
  }
}

/** Doctor keeps its report layout; every line is still derived from the envelope. */
export const renderDoctorText: TextRenderer = (env) => {
  const rule = "=".repeat(50);
  const lines = [`Legion Flow Doctor Report`, rule];
  const metrics = env.diagnostics.filter((d) => d.code.startsWith("metric_"));
  for (const diag of env.diagnostics) {
    if (diag.code.startsWith("metric_")) continue;
    lines.push(renderDiagnostic(diag));
  }
  if (metrics.length > 0) {
    lines.push(rule, "Metrics");
    const width = Math.max(...metrics.map((m) => m.code.length - "metric_".length));
    for (const m of metrics) {
      const name = m.code.slice("metric_".length);
      lines.push(`  ${name.padEnd(width)}  ${m.message.slice(name.length + 2)}`);
    }
  }
  lines.push(rule);
  lines.push(`Result: ${env.status === "ok" ? "READINESS PASS" : "READINESS BLOCKED"}`);
  if (env.nextAction.type === "command") {
    lines.push(`Next: ${env.nextAction.run}`);
  }
  return lines.join("\n");
};
