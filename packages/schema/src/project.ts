import { z } from "zod";
import { SCHEMA_VERSIONS, CONTROL_MODES, RISK_TIERS } from "./versions.js";
import { MapRulesSchema, LanguageServersSchema, McpServersSchema } from "./map.js";
import { MemoryConfigSchema } from "./memory.js";
import { CoordinatorConfigSchema } from "./coordinator.js";
import { HooksSchema } from "./hooks.js";
import { WebConfigSchema } from "./web.js";

export const DecisionOwnerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.literal("human"),
}).strict();

export type DecisionOwner = z.infer<typeof DecisionOwnerSchema>;

/**
 * One allowlisted upstream behind the egress proxy. `host` is a bare hostname
 * or IP (no scheme, no path, no wildcard, which the addendum warns matches
 * every subdomain); `ref` is a variable name the proxy resolves in its own
 * environment, never a value.
 */
/** "/seg" or "/seg/seg": no trailing slash, no dot segments, no query. */
export const EGRESS_BASE_PATH = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A provider root: https anywhere, http only on loopback; no query, fragment, or userinfo. */
export function providerUrlOk(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.search || u.hash || u.username || u.password) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

export const EgressRouteSchema = z.object({
  alias: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  host: z.string().regex(/^(?!.*[*/:@\s])[A-Za-z0-9.-]+$/),
  port: z.number().int().min(1).max(65535).optional(),
  scheme: z.enum(["https", "http"]).default("https"),
  /**
   * A path the proxy puts in front of every forwarded path (M4 slice y), such as "/anthropic" for a provider whose API
   * sits under one. A prefix, not a confinement: the host is the boundary, and any path on it is reachable.
   */
  basePath: z.string().regex(EGRESS_BASE_PATH).optional(),
  secrets: z.array(z.object({
    header: z.string().regex(/^[A-Za-z0-9-]+$/),
    ref: z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/),
    /** Text placed before the value, such as "Bearer ". */
    prefix: z.string().optional(),
  }).strict()).default([]),
}).strict();

export type EgressRoute = z.infer<typeof EgressRouteSchema>;

export const ProjectConfigSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.PROJECT),
  id: z.string().min(1),
  name: z.string().min(1),
  decisionOwners: z.array(DecisionOwnerSchema).min(1),
  riskPolicyVersion: z.string().default("risk-policy/v1"),
  defaultRiskTier: z.enum(RISK_TIERS).default("R1"),
  controlMode: z.enum(CONTROL_MODES).default("guarded"),
  adapter: z.object({
    default: z.string().min(1),
    /**
     * A provider for the project's default adapter (M4 slices y, aa): an Anthropic-compatible root for claude, an
     * OpenAI-compatible (Responses API) root for codex, the variable holding its key (sent as a bearer token by the egress
     * proxy, never a value here), and the model, which codex requires. Ignored by fake; other vendors keep their own API.
     */
    http: z.object({
      baseUrl: z.string().url().refine(providerUrlOk, { message: "adapter.http.baseUrl must be https (http only on loopback), with no query, fragment, or credentials" }).optional(),
      model: z.string().optional(),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(), // Never inline apiKey!
      /** The model's context window in tokens, for codex's model catalog (M4 slice aa); 128,000 when unset. Too small only compacts early. */
      contextWindow: z.number().int().min(8_192).max(4_000_000).optional(),
    }).strict().refine((h) => !h.baseUrl || h.apiKeyEnv, { message: "adapter.http.baseUrl needs apiKeyEnv, the variable that holds the provider's key" }).optional(),
    /** Hard usage limits; an adapter that cannot report a limited quantity is refused rather than run unbounded. */
    limits: z.object({
      maxTurns: z.number().int().positive().optional(),
      costLimitUsd: z.number().positive().optional(),
    }).strict().optional(),
  }).strict(),
  createdAt: z.string().datetime(),
  /**
   * Sandbox settings. Optional with no defaults on purpose: defaults live in
   * the sandbox package, so an upgrade never shifts an existing config
   * fingerprint. Setting them is a deliberate change that re-approves the plan.
   */
  sandbox: z.object({
    docker: z.object({
      image: z.string().min(1).optional(),
      memory: z.string().regex(/^[0-9]+[kmg]?$/i).optional(),
      cpus: z.number().positive().optional(),
      pidsLimit: z.number().int().positive().optional(),
      /** "uid:gid"; defaults by platform. */
      user: z.string().regex(/^[0-9]+:[0-9]+$/).optional(),
      /** The browser container's image (M4 slice o2); the locally built legion-flow-browser image when unset. */
      browserImage: z.string().min(1).optional(),
    }).strict().optional(),
    materialize: z.enum(["copy", "worktree"]).optional(),
    /** M4 slice j1: refuse the host tier for every agent and third-party spawn (adapters, reviewers, language servers, MCP servers). */
    require: z.boolean().optional(),
  }).strict().optional(),
  /** Spec settings (M4 slice j3): `challenge: "required"` makes approve spec wait for a complete, current challenge round. */
  spec: z.object({ challenge: z.enum(["required", "optional"]).optional() }).strict().optional(),
  /** Optional CALL hooks (M4 slice l): declared here, enabled only by a consent receipt. */
  hooks: HooksSchema.optional(),
  /** The tool gateway's budget (M4 slice k): tool calls per run, 20 when unset, at most 200. */
  toolPolicy: z.object({ maxSteps: z.number().int().min(1).max(200).optional() }).strict().optional(),
  /** Web fetching (M4 slice z): the self-hosted Firecrawl the built-in `web` server calls, on loopback only. Never started by Legion. */
  web: WebConfigSchema.optional(),
  /** Coordinator members and routes (M4 slice j1). */
  coordinator: CoordinatorConfigSchema.optional(),
  /** The independent reviewer: a second adapter, and a model when it shares the executor's adapter. No default, on purpose. */
  review: z.object({
    adapter: z.string().min(1),
    model: z.string().min(1).optional(),
  }).strict().optional(),
  /** The eval judge: an OpenAI-compatible endpoint on loopback, and its model. A remote judge would be egress and is refused. */
  judge: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  }).strict().optional(),
  /** Evidence settings: an optional loopback OTLP/HTTP collector that receives a copy of every span record. Off by default; never gates. */
  evidence: z.object({
    otlpEndpoint: z.string().url().optional(),
  }).strict().optional(),
  /** The code map: architecture rules (M4 slice a2). Rules make architecture_conformance a required gate at every tier. */
  map: z.object({ rules: MapRulesSchema.optional(), languageServers: LanguageServersSchema.optional() }).strict().optional(),
  /** Memory settings (M4 slice b). */
  memory: MemoryConfigSchema.optional(),
  /** Stdio MCP servers Legion may spawn and probe as tool providers (M4 slice f, ADR-0005). */
  mcpServers: McpServersSchema.optional(),
  /** Hosts an operator allows beyond the adapter's own provider routes. Deny-all is not configurable. */
  egress: z.object({
    routes: z.array(EgressRouteSchema),
  }).strict().optional(),
  /** Which spec and plan are current. The only mutable part of the record; excluded from the config fingerprint. */
  current: z.object({
    specId: z.string().regex(/^spc_[0-9a-z]+$/).optional(),
    planId: z.string().regex(/^pln_[0-9a-z]+$/).optional(),
  }).strict().optional(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
