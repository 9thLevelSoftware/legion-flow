import { z } from "zod";
import { SCHEMA_VERSIONS, RISK_TIERS } from "./versions.js";

const Fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A member path: forward slashes, relative, no `..`, no backslash, never the manifest or the signature. */
const MemberPath = z.string().min(1).refine((p) => !p.startsWith("/") && !p.includes("\\") && !/^[A-Za-z]:/.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === "") && p !== BUNDLE_MANIFEST && p !== BUNDLE_SIGNATURE, "a forward-slash path relative to the bundle root");

export const BUNDLE_MANIFEST = "manifest.json";
export const BUNDLE_SIGNATURE = "signature.dsse.json";
export const BUNDLE_MEMBER_MAX_BYTES = 64 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 256 * 1024 * 1024;
export const BUNDLE_MANIFEST_MAX_BYTES = 1024 * 1024;
/** The in-toto predicate type of a bundle signature (M4 slice h). */
export const BUNDLE_PREDICATE_TYPE = "https://9thlevelsoftware.dev/legion-flow/bundle/v1";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * A bundle's manifest (M4 slice h): what one ship evaluation rested on, every member
 * by path, size, and sha256, sorted by path. Its bytes are the canonical JSON of this
 * object with no trailing newline, so a verifier compares exactly.
 */
export const BundleManifestSchema = z.object({
  schema: z.literal(SCHEMA_VERSIONS.BUNDLE),
  createdAt: z.string().datetime(),
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  releaseId: z.string().regex(/^rel_[0-9a-z]+$/).optional(),
  ready: z.boolean(),
  riskTier: z.enum(RISK_TIERS),
  fingerprints: z.object({ spec: Fingerprint, plan: Fingerprint, config: Fingerprint }).strict(),
  requiredGates: z.array(z.string().min(1)),
  members: z.array(z.object({ path: MemberPath, sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0) }).strict()),
}).strict();
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** What a signer asserts about a bundle: who signed, when, and which evaluation. A signature authenticates bytes, not truth. */
export const BundlePredicateSchema = z.object({
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  releaseId: z.string().regex(/^rel_[0-9a-z]+$/).optional(),
  ready: z.boolean(),
  signer: z.object({ id: z.string().min(1) }).strict(),
  signedAt: z.string().datetime(),
}).strict();
export type BundlePredicate = z.infer<typeof BundlePredicateSchema>;

export const BundleStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(z.object({ name: z.literal(BUNDLE_MANIFEST), digest: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict() }).strict()).length(1),
  predicateType: z.literal(BUNDLE_PREDICATE_TYPE),
  predicate: BundlePredicateSchema,
}).strict();
export type BundleStatement = z.infer<typeof BundleStatementSchema>;

/** A DSSE envelope with one Ed25519 signature; `keyid` is the sha256 of the signer's SPKI DER public key. */
export const DsseEnvelopeSchema = z.object({
  payloadType: z.literal(DSSE_PAYLOAD_TYPE),
  payload: z.string().min(1),
  signatures: z.array(z.object({ keyid: z.string().regex(/^[0-9a-f]{64}$/), sig: z.string().min(1) }).strict()).length(1),
}).strict();
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
