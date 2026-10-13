/**
 * The environment a spawned agent sees: a base allowlist, the adapter's own
 * credential variable by name, and the forced telemetry opt-outs. Everything
 * else in the operator's environment is dropped.
 */

export const BASE_ENV_ALLOWLIST: readonly string[] = ["PATH", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];

/** Forced into every spawned environment, whichever optional tools are installed (addendum row 29). */
export const FORCED_TELEMETRY_OPT_OUT: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: "1",
  DEEPEVAL_TELEMETRY_OPT_OUT: "1",
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  OPIK_USAGE_REPORT_ENABLED: "false",
  TELEMETRY_ENABLED: "false",
  MCP_USE_ANONYMIZED_TELEMETRY: "false",
  CREWAI_DISABLE_TELEMETRY: "true",
  GRAPHITI_TELEMETRY_ENABLED: "false",
  III_TELEMETRY_ENABLED: "false",
};

export interface BuildEnvOptions {
  /** `host`: the base allowlist applies. `container`: the image's own defaults apply and no host variable is forwarded. */
  mode?: "host" | "container";
  /** The adapter's credential variable, passed through by name when set in the source. */
  credentialEnv?: string;
  /** Extra names an adapter declares (never values). */
  extraAllowlist?: readonly string[];
  platform?: NodeJS.Platform;
}

/** Windows environment names are case-insensitive (`Path`, not `PATH`); match them that way there. */
export function buildAdapterEnv(source: NodeJS.ProcessEnv, options: BuildEnvOptions = {}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const base = options.mode === "container" ? [] : BASE_ENV_ALLOWLIST;
  const wanted = [...base, ...(options.extraAllowlist ?? []), ...(options.credentialEnv ? [options.credentialEnv] : [])];
  const out: Record<string, string> = {};
  const fold = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const wantedSet = new Set(wanted.map(fold));
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && wantedSet.has(fold(name))) out[name] = value;
  }
  return { ...out, ...FORCED_TELEMETRY_OPT_OUT };
}
