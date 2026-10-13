/**
 * The broadcast choice (M4 slice j2). Every member has already worked the same
 * task in its own copy and withheld its proposal; this run holds one human
 * decision over all of them and applies the one chosen through the task
 * workflow's own apply node, so the source guard, the rebase, the hashing, and
 * the gates' view of an applied run are the same code. Nothing is merged.
 */
import { BROADCAST_WORKFLOW_ID, CHOOSE_PROPOSAL_ACTION, ProposalSchema, type Proposal, type RunMember } from "@9thlevelsoftware/legion-flow-schema";
import { taskWorkflow, type TaskPorts } from "./task-workflow.js";
import type { State, Workflow } from "./types.js";

const CHOICE_EXPIRES_MS = 24 * 60 * 60 * 1000;
const NO_RETRY = { maxAttempts: 1 };

/** One member's result, as the choice payload shows it. */
export interface BroadcastCandidate {
  member: RunMember;
  runId: string;
  /** False when the member produced no proposal it could stand behind; the reason says why. */
  eligible: boolean;
  reason: string;
  hasProposal: boolean;
  checks?: { passed: number; total: number };
  files?: string[];
  introduced?: number;
  impact?: { direct: number; transitive: number } | null;
  usage?: unknown;
  proposalSha256?: string;
}

/** The recommendation rule: eligible only; then fewest files touched; then member order. Null when none is eligible. */
export function recommendCandidate(candidates: readonly BroadcastCandidate[]): string | null {
  const eligible = candidates.map((c, i) => ({ c, i })).filter((x) => x.c.eligible && x.c.hasProposal);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (a.c.files?.length ?? 0) - (b.c.files?.length ?? 0) || a.i - b.i);
  return eligible[0]!.c.member.id;
}

export function broadcastWorkflow(ports: TaskPorts): Workflow {
  const task = taskWorkflow(ports);
  return {
    id: BROADCAST_WORKFLOW_ID,
    version: "1",
    entry: "choose",
    state: { log: { kind: "append" } },
    nodes: {
      choose: {
        retry: NO_RETRY,
        run: (state) => {
          const candidates = state.candidates as BroadcastCandidate[];
          const proposals = state.proposals as Record<string, Proposal>;
          const createsOrDeletes = Object.values(proposals).some((p) => p.files.some((f) => f.before === null || f.after === null));
          return {
            writes: {},
            interrupt: {
              kind: "approve_action",
              action: { name: CHOOSE_PROPOSAL_ACTION, riskClass: createsOrDeletes ? "create_delete" : "edit", args: { broadcastId: state.broadcastId, taskId: (state.task as { id: string }).id, members: candidates.map((c) => c.member.id) } },
              payload: { broadcastId: state.broadcastId, candidates, recommendation: state.recommendation ?? null },
              expiresInMs: CHOICE_EXPIRES_MS,
              onTimeout: "cancel",
              resume: { onApprove: "apply", onReject: "abandon" },
            },
          };
        },
      },
      apply: {
        retry: NO_RETRY,
        effect: "apply_proposal",
        run: async (state, ctx) => {
          const candidates = state.candidates as BroadcastCandidate[];
          const edited = ctx.decision?.decision === "edit" ? (ctx.decision.editedArgs as { member?: unknown } | null)?.member : undefined;
          const chosenId = typeof edited === "string" ? edited : (state.recommendation as string | null);
          const chosen = candidates.find((c) => c.member.id === chosenId && c.hasProposal);
          // decide refuses both of these first; the node still never applies on a guess.
          if (!chosen) {
            await ports.ws.audit.append({ type: "broadcast_unresolved", runId: ctx.runId, broadcastId: state.broadcastId, chosen: chosenId ?? null }, ctx.held);
            return { writes: { outcome: "no_choice", log: "no member with a proposal was chosen; nothing applied" } };
          }
          const proposal = ProposalSchema.parse((state.proposals as Record<string, unknown>)[chosen.member.id]);
          // A content-addressed copy into this run: the applied run's own evidence is where the gates and the rebase look.
          const copy = await ports.ws.runs.writeEvidence(ctx.runId, proposal, ctx.held, "apply");
          await ports.ws.audit.append({ type: "broadcast_chosen", runId: ctx.runId, broadcastId: state.broadcastId, member: chosen.member.id, memberRunId: chosen.runId, proposalSha256: copy.sha256, memberProposalSha256: chosen.proposalSha256 ?? null, recommended: chosen.member.id === state.recommendation, interruptId: ctx.decision?.interruptId ?? null }, ctx.held);
          const applyState: State = { ...state, proposal, proposalRef: { path: copy.path, sha256: copy.sha256 }, treeMode: proposal.treeMode, treeFingerprint: proposal.treeFingerprint, treeDir: undefined };
          const node = task.nodes.apply!;
          const result = await (typeof node === "function" ? node : node.run)(applyState, ctx);
          return { ...result, writes: { ...result.writes, chosenMember: chosen.member, chosenRunId: chosen.runId } };
        },
      },
      abandon: {
        retry: NO_RETRY,
        run: async (state, ctx) => {
          await ports.ws.audit.append({ type: "broadcast_rejected", runId: ctx.runId, broadcastId: state.broadcastId, interruptId: ctx.decision?.interruptId ?? null }, ctx.held);
          return { writes: { outcome: "rejected", log: "every proposal rejected; nothing applied" } };
        },
      },
    },
  };
}
