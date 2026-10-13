/**
 * The per-spawn sandbox check (M4 slice j1). One rule for every spawn of agent or
 * third-party code: a project with `sandbox.require` never runs it on the host
 * tier, and a coordinator member that requires a sandbox is never delegated to an
 * unhardened run (OpenClaw's `sandbox: "require"`). Approved verification checks,
 * browser-check `serve` commands, `browse`, and doctor's version probes are
 * commands a human wrote or a version read; they are outside this rule.
 */
export type SpawnKind = "adapter" | "reviewer" | "challenger" | "namer" | "drafter" | "language_server" | "mcp_server";

export interface SpawnVerdict {
  kind: SpawnKind;
  tier: string;
  require: boolean;
  member?: string;
  verdict: "allowed";
}

export function spawnAllowed(input: { kind: SpawnKind; tier: string; hardened: boolean; require?: boolean; member?: { id: string; sandbox?: "require" } }): { ok: true; record: SpawnVerdict } | { ok: false; code: "sandbox_required_by_policy" | "delegation_rejected"; message: string; hint: string } {
  const what = { adapter: "the coding agent", reviewer: "the reviewer", challenger: "the spec challenger", namer: "the observation namer", drafter: "the drafting agent", language_server: "a language server", mcp_server: "an MCP server" }[input.kind];
  if (!input.hardened && input.require) {
    return { ok: false, code: "sandbox_required_by_policy", message: `project.json sandbox.require is set, so ${what} never runs on the ${input.tier} tier, consent or not.`, hint: "FIX: use the default vm-docker tier, or remove sandbox.require from project.json (a config change that needs new approvals)." };
  }
  if (!input.hardened && input.member?.sandbox === "require") {
    return { ok: false, code: "delegation_rejected", message: `Member '${input.member.id}' requires a sandbox and this run is on the ${input.tier} tier; a run is never delegated to a member outside its sandbox.`, hint: "FIX: run on the vm-docker tier, or route the task to another member." };
  }
  return { ok: true, record: { kind: input.kind, tier: input.tier, require: input.require === true, ...(input.member ? { member: input.member.id } : {}), verdict: "allowed" } };
}
export const TOOLS_ROUTE_ALIAS = "legion-tools";
