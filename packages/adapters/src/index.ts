import type { Adapter } from "@9thlevelsoftware/legion-flow-engine";
import { FakeAdapter } from "./fake.js";
import { claudeAdapter, codexAdapter, VendorAdapter } from "./vendor.js";
import type { AdapterDefinition, AdapterProvider } from "./definitions.js";

export { buildAdapterEnv, BASE_ENV_ALLOWLIST, FORCED_TELEMETRY_OPT_OUT } from "./env.js";
export type { BuildEnvOptions } from "./env.js";
export { spawnFrozen } from "@9thlevelsoftware/legion-flow-engine";
export { FakeAdapter, FAKE_ADAPTER_PLAN_RELATIVE, adaptersDistDir } from "./fake.js";
export type { FakeAdapterPlan } from "./fake.js";
export {
  AGENT_CLI_VERSIONS,
  AGENT_BASE_IMAGE,
  agentImageTag,
  agentDockerfile,
  ADAPTER_DEFINITIONS,
  CLAUDE_DEFINITION,
  CODEX_DEFINITION,
  PLACEHOLDER_KEY,
  adapterDefinition,
  withProvider,
  codexCatalog,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  vendorPrefixMatches,
} from "./definitions.js";
export type { AdapterDefinition, AdapterProvider, VendorPrefix } from "./definitions.js";
export { parseClaudeOutput, parseCodexOutput } from "./usage.js";
export type { ParsedVendorOutput } from "./usage.js";
export { claudeAdapter, codexAdapter, pointerPrompt, VendorAdapter } from "./vendor.js";

/** Adapter ids the registry knows. */
export const ADAPTER_IDS = ["fake", "claude", "codex"] as const;

/** The definition an adapter actually runs with: a provider-derived one for a claude adapter built with a provider (M4 slice y). */
export function definitionOf(adapter: Adapter): AdapterDefinition | null {
  return adapter instanceof VendorAdapter ? adapter.def : null;
}

export function adapterById(id: string, options: { provider?: AdapterProvider } = {}): Adapter | null {
  switch (id) {
    case "fake":
      return new FakeAdapter();
    case "claude":
      return claudeAdapter(options.provider);
    case "codex":
      return codexAdapter(options.provider);
    default:
      return null;
  }
}
