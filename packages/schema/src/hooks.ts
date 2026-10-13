import { z } from "zod";
import { SCHEMA_VERSIONS } from "./versions.js";
import { loopbackUrlProblem } from "./net.js";
import type { AuditEventType } from "./audit-events.js";

/**
 * Optional CALL hooks (M4 slice l): an outbound delivery of audit events to an
 * external service. Declaring one does nothing: a hook is enabled only by a
 * decision owner's consent receipt bound to the sha256 of its config entry.
 */
const urlField = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://") || loopbackUrlProblem(u, "url") === null, "https, or http on a loopback host")
  .refine((u) => {
    try {
      const p = new URL(u);
      return !p.username && !p.password;
    } catch {
      return false;
    }
  }, "no user or password in the URL: a credential goes in secrets, by variable name");

export const HookConfigSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /**
   * `event` (absent means event): audit events to a webhook; `otlp` (M4 slice n1): span records to an
   * OTLP/HTTP endpoint such as Langfuse or Opik; `memory_export` (M4 slice n2): facts and observations to an
   * MCP server's memory tool, Graphiti's add_memory shape.
   */
  kind: z.enum(["event", "otlp", "memory_export"]).optional(),
  /** Event hooks: audit event types delivered, such as shipped or proposal_applied. */
  on: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).optional(),
  /** Event and otlp hooks: https anywhere, or http on loopback for a local collector. */
  url: urlField.optional(),
  secrets: z.array(z.object({ header: z.string().regex(/^[A-Za-z0-9-]+$/), ref: z.string().regex(/^env:[A-Z_][A-Z0-9_]*$/), prefix: z.string().optional() }).strict()).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
  /** memory_export: the declared mcpServers entry that receives memory; its envKeys carry its credentials. */
  server: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
  /** memory_export: the tool called per item; add_memory when unset. */
  tool: z.string().min(1).optional(),
  /** memory_export: also send facts agents recorded (origin llm); off when unset. */
  includeLlm: z.boolean().optional(),
  /** memory_export: where the server runs, vm-docker when unset; unhardened is a decision owner's consent, inside the consent hash, to run it on the host. */
  sandbox: z.enum(["vm-docker", "unhardened"]).optional(),
}).strict()
  .refine((h) => (h.kind ?? "event") !== "event" || (h.on?.length ?? 0) > 0, { message: "an event hook names the audit event types it delivers in on" })
  .refine((h) => (h.kind ?? "event") === "event" || h.on === undefined, { message: "only an event hook takes on" })
  .refine((h) => h.kind === "memory_export" || h.url !== undefined, { message: "an event or otlp hook needs a url" })
  .refine((h) => h.kind !== "memory_export" || (h.url === undefined && h.secrets === undefined && h.server !== undefined), { message: "a memory_export hook names a server and takes no url or secrets (the server's envKeys carry its credentials)" })
  .refine((h) => h.kind === "memory_export" || (h.server === undefined && h.tool === undefined && h.includeLlm === undefined && h.sandbox === undefined), { message: "server, tool, includeLlm, and sandbox belong to a memory_export hook" })
  .refine((h) => h.kind !== "otlp" || h.url === undefined || !/\/v1\/traces\/?$/.test(new URL(h.url).pathname), { message: "an otlp hook's url is the OTLP base; /v1/traces is appended, so drop it from the url" });
export type HookConfig = z.infer<typeof HookConfigSchema>;

export const HooksSchema = z.array(HookConfigSchema).refine((hs) => new Set(hs.map((h) => h.name)).size === hs.length, "hook names must be unique");

/** A decision owner's consent to one hook as configured; a later revocation, or any change to the hook, ends it. */
export const HookConsentSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.HOOK_CONSENT),
  id: z.string().regex(/^hkc_[0-9a-z]+$/),
  hook: z.string().min(1),
  /** sha256 of the hook's config entry in canonical JSON. */
  configSha256: z.string().regex(/^[0-9a-f]{64}$/),
  action: z.enum(["enable", "disable"]),
  /** For enable: the audit chain length at consent; only later events are delivered. */
  fromSeq: z.number().int().min(0).optional(),
  /** The decision owner, in the shape project.json declares (defined here to keep schema free of an import cycle). */
  decidedBy: z.object({ id: z.string().min(1), displayName: z.string().min(1), kind: z.literal("human") }).strict(),
  decidedAt: z.string().datetime(),
  source: z.literal("tty"),
}).strict();
export type HookConsent = z.infer<typeof HookConsentSchema>;

/** Audit event types a delivery records; they never trigger a delivery themselves. */
export const HOOK_AUDIT_TYPES: readonly AuditEventType[] = ["hook_enabled", "hook_disabled", "hook_delivered", "hook_delivery_failed", "hook_delivery_abandoned"];
