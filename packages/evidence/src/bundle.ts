/**
 * Ship bundles (M4 slice h): a plain directory holding everything one ship
 * evaluation rested on, a canonical manifest of it, and optionally one DSSE
 * envelope over an in-toto statement whose subject is the manifest. The writer
 * stages beside the destination and renames into place; the verifier treats the
 * directory as hostile input and reads nothing outside it. A signature
 * authenticates bytes, not truth.
 */
import { createHash, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  SCHEMA_VERSIONS,
  BUNDLE_MANIFEST,
  BUNDLE_SIGNATURE,
  BUNDLE_MEMBER_MAX_BYTES,
  BUNDLE_MAX_BYTES,
  BUNDLE_MANIFEST_MAX_BYTES,
  BUNDLE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  DSSE_PAYLOAD_TYPE,
  BundleManifestSchema,
  BundleStatementSchema,
  DsseEnvelopeSchema,
  PlanSchema,
  ProjectConfigSchema,
  ReleaseSchema,
  SpecSchema,
  SpecChallengeSchema,
  type BundleManifest,
  type BundlePredicate,
  type BundleStatement,
  type DsseEnvelope,
  type GateVerdict,
} from "@9thlevelsoftware/legion-flow-schema";
import { AuditChain, canonicalJson, configFingerprint, loadRun, planFingerprint, projectDirPaths, specFingerprint, verifyRunEvidence, type Workspace } from "@9thlevelsoftware/legion-flow-persist";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const posix = (p: string) => p.split(sep).join("/");

/** A typed refusal from the writer; the message starts with the code. */
export class BundleError extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "BundleError";
  }
}

/** The DSSE pre-authentication encoding: lengths are byte counts in decimal. */
export function pae(payloadType: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${body.length} `, "utf8"), body]);
}

/** A key's id: the sha256 of its SPKI DER public key. */
export function keyIdOf(publicKey: KeyObject): string {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

async function walk(dir: string, base = dir): Promise<{ path: string; abs: string; kind: "file" | "other" }[]> {
  const out: { path: string; abs: string; kind: "file" | "other" }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs, base)));
    else out.push({ path: posix(relative(base, abs)), abs, kind: entry.isFile() ? "file" : "other" });
  }
  return out;
}

/** Every file a ship evaluation rested on, by project-relative path. Throws `release_sources_changed` when a source no longer fingerprints as the run did. */
async function collectMembers(ws: Workspace, runId: string, releaseId?: string): Promise<{ path: string; abs: string }[]> {
  const loaded = await ws.runs.load(runId);
  if (!loaded || loaded.run.kind !== "ship" || loaded.run.status !== "complete") throw new BundleError("bundle_run_unusable", `${runId} is not a complete ship evaluation`);
  const fp = loaded.run.fingerprints;
  const members: { path: string; abs: string }[] = [];
  const add = (abs: string) => members.push({ path: posix(relative(ws.paths.project, abs)), abs });

  for (const f of await walk(loaded.dir)) {
    if (f.kind !== "file") throw new BundleError("bundle_source_unsafe", `${f.path} in the run is not a regular file`);
    add(f.abs);
  }
  const project = await ws.project.load();
  if (project.kind !== "valid" || configFingerprint(project.config) !== fp.config) throw new BundleError("release_sources_changed", "project.json no longer fingerprints as the evaluation's config");
  add(ws.paths.projectConfig);

  let spec: string | null = null;
  for (const id of await readdir(ws.paths.specsDir).catch(() => [] as string[])) {
    const s = await ws.specs.load(id);
    if (s.kind === "valid" && s.fingerprint === fp.spec) spec = s.dir;
  }
  if (!spec) throw new BundleError("release_sources_changed", "no spec fingerprints as the evaluation's spec");
  add(join(spec, "spec.json"));
  add(join(spec, "SPEC.md"));
  // The spec challenge record (M4 slice s) travels when its latest round was for this very spec; a record about
  // another version of the spec would answer questions about something else, so it stays behind.
  const challengeRaw = await readFile(join(spec, "challenge.json"), "utf8").catch(() => null);
  if (challengeRaw !== null) {
    const parsed = SpecChallengeSchema.safeParse((() => { try { return JSON.parse(challengeRaw); } catch { return null; } })());
    if (parsed.success && parsed.data.rounds.at(-1)?.specFingerprint === fp.spec) add(join(spec, "challenge.json"));
  }
  let plan: string | null = null;
  for (const id of await readdir(ws.paths.plansDir).catch(() => [] as string[])) {
    const p = await ws.plans.load(id);
    if (p.kind === "valid" && p.fingerprint === fp.plan) plan = p.dir;
  }
  if (!plan) throw new BundleError("release_sources_changed", "no plan fingerprints as the evaluation's plan");
  add(join(plan, "plan.json"));

  for (const a of (await ws.approvals.list()).valid) {
    const matches = a.fingerprints.spec === fp.spec && a.fingerprints.config === fp.config && (a.subject === "spec" || a.fingerprints.plan === fp.plan);
    if (matches) add(join(ws.paths.approvalsDir, `${a.id}.json`));
  }
  for (const r of await ws.reviews.list()) {
    if (r.fingerprints.spec === fp.spec && r.fingerprints.plan === fp.plan && r.fingerprints.config === fp.config) add(join(ws.paths.reviewsDir, `${r.id}.json`));
  }
  if (releaseId) {
    const release = (await ws.releases.list()).find((r) => r.id === releaseId);
    if (!release || release.runId !== runId) throw new BundleError("release_unknown", `${releaseId} is not a release of ${runId}`);
    add(join(ws.paths.releasesDir, `${releaseId}.json`));
  }
  // Anything else a verdict cites (outside the run and the chain) comes too, so every gate's bundle is complete by construction.
  for (const v of loaded.verdicts) {
    for (const e of v.evidence) {
      if (e.path.startsWith("audit/") || e.path.startsWith(`runs/${runId}/`)) continue;
      const abs = join(ws.paths.project, ...e.path.split("/"));
      if (await lstat(abs).then((s) => s.isFile(), () => false)) add(abs);
    }
  }
  add(ws.paths.eventsJsonl);
  add(ws.paths.chainJson);
  const seen = new Set<string>();
  return members.filter((m) => (seen.has(m.path) ? false : (seen.add(m.path), true))).sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface BundleSigner {
  key: KeyObject;
  publicKey: KeyObject;
  signerId: string;
}

export interface WrittenBundle {
  manifest: BundleManifest;
  manifestSha256: string;
  keyId?: string;
}

/** The DSSE envelope over a statement whose one subject is the manifest's bytes. */
export function signManifest(manifestBytes: Buffer, predicate: BundlePredicate, signer: { key: KeyObject; publicKey: KeyObject }): DsseEnvelope {
  const statement: BundleStatement = { _type: IN_TOTO_STATEMENT_TYPE, subject: [{ name: BUNDLE_MANIFEST, digest: { sha256: sha256(manifestBytes) } }], predicateType: BUNDLE_PREDICATE_TYPE, predicate };
  const payload = Buffer.from(canonicalJson(statement), "utf8");
  const sig = edSign(null, pae(DSSE_PAYLOAD_TYPE, payload), signer.key);
  return { payloadType: DSSE_PAYLOAD_TYPE, payload: payload.toString("base64"), signatures: [{ keyid: keyIdOf(signer.publicKey), sig: sig.toString("base64") }] };
}

/**
 * Write the bundle of one ship evaluation (and its release, when named) to `dest`,
 * which must not exist. Staged as a hidden sibling and renamed into place, so a
 * failure, including a signing failure, leaves nothing at `dest`. Call under the lock.
 */
export async function writeBundle(ws: Workspace, input: { runId: string; releaseId?: string; dest: string; signer?: BundleSigner; now?: Date }): Promise<WrittenBundle> {
  const now = input.now ?? new Date();
  if (await lstat(input.dest).then(() => true, () => false)) throw new BundleError("bundle_destination_exists", "the destination already exists; a bundle is never written over anything");
  const loaded = await ws.runs.load(input.runId);
  if (!loaded || loaded.run.kind !== "ship") throw new BundleError("bundle_run_unusable", `${input.runId} is not a ship evaluation`);
  const run = loaded.run;
  const sources = await collectMembers(ws, input.runId, input.releaseId);
  const stage = join(dirname(input.dest), `.${basename(input.dest)}.tmp-${randomBytes(4).toString("hex")}`);
  await mkdir(stage, { recursive: true });
  try {
    const members: BundleManifest["members"] = [];
    let total = 0;
    for (const m of sources) {
      const bytes = await readFile(m.abs);
      if (bytes.length > BUNDLE_MEMBER_MAX_BYTES) throw new BundleError("bundle_too_large", `${m.path} is over ${BUNDLE_MEMBER_MAX_BYTES} bytes`);
      total += bytes.length;
      if (total > BUNDLE_MAX_BYTES) throw new BundleError("bundle_too_large", `the bundle is over ${BUNDLE_MAX_BYTES} bytes`);
      const target = join(stage, ...m.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      members.push({ path: m.path, sha256: sha256(bytes), bytes: bytes.length });
    }
    const manifest = BundleManifestSchema.parse({
      schema: SCHEMA_VERSIONS.BUNDLE,
      createdAt: now.toISOString(),
      runId: run.id,
      ...(input.releaseId ? { releaseId: input.releaseId } : {}),
      ready: run.ready === true,
      riskTier: run.riskTier,
      fingerprints: run.fingerprints,
      requiredGates: run.requiredGates,
      members,
    });
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    await writeFile(join(stage, BUNDLE_MANIFEST), manifestBytes, { flag: "wx" });
    let keyId: string | undefined;
    if (input.signer) {
      const envelope = signManifest(manifestBytes, { runId: run.id, ...(input.releaseId ? { releaseId: input.releaseId } : {}), ready: manifest.ready, signer: { id: input.signer.signerId }, signedAt: now.toISOString() }, input.signer);
      keyId = envelope.signatures[0]!.keyid;
      await writeFile(join(stage, BUNDLE_SIGNATURE), canonicalJson(envelope), { flag: "wx" });
    }
    await rename(stage, input.dest);
    return { manifest, manifestSha256: sha256(manifestBytes), ...(keyId ? { keyId } : {}) };
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
}

export interface BundleVerification {
  integrity: "valid" | "invalid";
  authenticity: "verified" | "unverified" | "invalid";
  signed: boolean;
  keyId?: string;
  /** Why integrity or authenticity failed; empty when both hold. */
  problems: string[];
  manifest?: BundleManifest;
  manifestSha256?: string;
  verdicts: GateVerdict[];
  /** Integrity holds, and the signature verified when a public key was given. */
  passed: boolean;
}

/**
 * Verify a bundle with nothing but its own bytes and, optionally, a public key from
 * elsewhere. Checks: only manifest-listed regular files (plus the manifest and the
 * signature); a canonical manifest; every member's size and hash; the bundled ship
 * run, its verdicts, and its evidence; the spec, plan, and config fingerprints; the
 * release; the audit chain and the evaluation's events in it; the signature.
 * Re-runs no gate.
 */
export async function verifyBundle(dir: string, options: { publicKey?: KeyObject } = {}): Promise<BundleVerification> {
  const problems: string[] = [];
  const fail = (authenticity: BundleVerification["authenticity"] = "unverified", extra: Partial<BundleVerification> = {}): BundleVerification => ({ integrity: "invalid", authenticity, signed: false, problems, verdicts: [], passed: false, ...extra });
  const top = await lstat(dir).catch(() => null);
  if (!top?.isDirectory()) return (problems.push("the bundle is not a directory"), fail());

  // The manifest: capped, schema-valid, and exactly canonical.
  const mStat = await lstat(join(dir, BUNDLE_MANIFEST)).catch(() => null);
  if (!mStat?.isFile()) return (problems.push("manifest.json is missing or not a regular file"), fail());
  if (mStat.size > BUNDLE_MANIFEST_MAX_BYTES) return (problems.push("manifest.json is over the 1 MiB cap"), fail());
  const manifestBytes = await readFile(join(dir, BUNDLE_MANIFEST));
  let manifest: BundleManifest;
  try {
    const parsed = BundleManifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
    if (!parsed.success) return (problems.push(`manifest.json does not match ${SCHEMA_VERSIONS.BUNDLE}: ${parsed.error.issues[0]?.message ?? "invalid"}`), fail());
    manifest = parsed.data;
  } catch {
    return (problems.push("manifest.json is not JSON"), fail());
  }
  if (canonicalJson(manifest) !== manifestBytes.toString("utf8")) problems.push("manifest.json is not in canonical form");
  const manifestSha256 = sha256(manifestBytes);
  const listed = new Map(manifest.members.map((m) => [m.path, m]));
  if (listed.size !== manifest.members.length) problems.push("manifest.json lists a path twice");
  if (manifest.members.some((m, i) => i > 0 && manifest.members[i - 1]!.path >= m.path)) problems.push("manifest.json members are not sorted by path");

  // The directory: nothing unlisted, nothing that is not a regular file, nothing missing.
  const present = await walk(dir);
  for (const f of present) {
    if (f.kind !== "file") problems.push(`${f.path} is not a regular file`);
    else if (!listed.has(f.path) && f.path !== BUNDLE_MANIFEST && f.path !== BUNDLE_SIGNATURE) problems.push(`${f.path} is not listed in the manifest`);
  }
  const presentPaths = new Set(present.filter((f) => f.kind === "file").map((f) => f.path));
  let total = 0;
  for (const m of manifest.members) {
    if (!presentPaths.has(m.path)) {
      problems.push(`${m.path} is missing`);
      continue;
    }
    const abs = join(dir, ...m.path.split("/"));
    const st = await lstat(abs);
    total += st.size;
    if (st.size !== m.bytes || st.size > BUNDLE_MEMBER_MAX_BYTES) {
      problems.push(`${m.path} is ${st.size} bytes, the manifest says ${m.bytes}`);
      continue;
    }
    if (sha256(await readFile(abs)) !== m.sha256) problems.push(`${m.path} does not match its hash`);
  }
  if (total > BUNDLE_MAX_BYTES) problems.push("the bundle is over the 256 MiB cap");
  if (problems.length) return fail("unverified", { manifest, manifestSha256 });

  // The evaluation inside: the run, its verdicts and evidence, and what they rest on.
  const paths = projectDirPaths(dir);
  const loaded = await loadRun(paths, manifest.runId);
  const verdicts: GateVerdict[] = loaded?.verdicts ?? [];
  if (!loaded || loaded.run.kind !== "ship") problems.push(`the bundle holds no ship run ${manifest.runId}`);
  else {
    const run = loaded.run;
    if (run.status !== "complete") problems.push("the ship run is not complete");
    if (canonicalJson(run.fingerprints) !== canonicalJson(manifest.fingerprints) || run.riskTier !== manifest.riskTier || canonicalJson(run.requiredGates) !== canonicalJson(manifest.requiredGates)) problems.push("the manifest disagrees with the ship run's fingerprints, tier, or required gates");
    const gateIds = verdicts.map((v) => v.gateId).sort();
    if (canonicalJson(gateIds) !== canonicalJson([...run.requiredGates].sort())) problems.push(`the verdicts (${gateIds.join(", ")}) are not one per required gate`);
    const indexed = new Set(loaded.evidenceIndex.map((e) => `${e.path}\0${e.sha256}`));
    // Cited evidence is the run's own, or another bundled record at the same hash (an approval receipt), or the
    // audit chain, which has grown since the evaluation and is checked whole by the replay below instead.
    for (const v of verdicts) {
      for (const e of v.evidence) {
        if (indexed.has(`${e.path}\0${e.sha256}`) || listed.get(e.path)?.sha256 === e.sha256 || e.path.startsWith("audit/")) continue;
        problems.push(`${v.gateId} cites evidence the bundle does not hold at that hash: ${e.path}`);
      }
    }
    const ev = await verifyRunEvidence(paths, loaded);
    if (!ev.ok) problems.push(`run evidence: ${[...ev.missing.map((p) => `${p} missing`), ...ev.drifted.map((p) => `${p} drifted`)].join(", ")}`);
    const ready = run.requiredGates.every((g) => verdicts.some((v) => v.gateId === g && (v.status === "satisfied" || v.waiver !== null)));
    if (ready !== (run.ready === true) || ready !== manifest.ready) problems.push(`readiness disagrees: the verdicts say ${ready}, the run ${run.ready === true}, the manifest ${manifest.ready}`);
  }
  const readText = (p: string) => readFile(join(dir, ...p.split("/")), "utf8");
  const one = (re: RegExp) => manifest.members.filter((m) => re.test(m.path)).map((m) => m.path);
  try {
    const specs = one(/^specs\/[^/]+\/spec\.json$/);
    const plans = one(/^plans\/[^/]+\/plan\.json$/);
    if (specs.length !== 1 || plans.length !== 1) problems.push("the bundle must hold exactly one spec and one plan");
    else {
      const spec = SpecSchema.parse(JSON.parse(await readText(specs[0]!)));
      if (specFingerprint(spec, await readText(specs[0]!.replace(/spec\.json$/, "SPEC.md"))) !== manifest.fingerprints.spec) problems.push("the bundled spec does not fingerprint as the evaluation's");
      if (planFingerprint(PlanSchema.parse(JSON.parse(await readText(plans[0]!)))) !== manifest.fingerprints.plan) problems.push("the bundled plan does not fingerprint as the evaluation's");
      // A bundled challenge record must parse and be about the bundled spec (M4 slice s).
      const challenge = specs[0]!.replace(/spec\.json$/, "challenge.json");
      if (listed.has(challenge)) {
        const parsed = SpecChallengeSchema.safeParse(JSON.parse(await readText(challenge)));
        if (!parsed.success) problems.push("the bundled challenge record does not parse");
        else if (parsed.data.rounds.at(-1)?.specFingerprint !== manifest.fingerprints.spec) problems.push("the bundled challenge record is about another version of the spec");
      }
    }
    if (configFingerprint(ProjectConfigSchema.parse(JSON.parse(await readText("project.json")))) !== manifest.fingerprints.config) problems.push("the bundled project.json does not fingerprint as the evaluation's");
    if (manifest.releaseId) {
      const release = ReleaseSchema.parse(JSON.parse(await readText(`releases/${manifest.releaseId}.json`)));
      if (release.runId !== manifest.runId || canonicalJson(release.fingerprints) !== canonicalJson(manifest.fingerprints)) problems.push("the bundled release names another evaluation");
    }
  } catch (err: unknown) {
    problems.push(`a bundled record does not parse: ${(err as Error).message.split("\n")[0]}`);
  }

  // The audit chain replays, and holds the evaluation (and the release) wherever they sit, archived region included.
  const chain = await new AuditChain(paths.eventsJsonl, paths.chainJson).verify();
  if (!chain.valid) problems.push(`the audit chain does not verify: ${chain.error ?? "invalid"}`);
  const events = (await readText("audit/events.jsonl").catch(() => "")).split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l) as { type?: string; runId?: string; releaseId?: string }];
    } catch {
      return [];
    }
  });
  if (!events.some((e) => e.type === "ship_evaluated" && e.runId === manifest.runId)) problems.push(`the audit chain records no ship_evaluated for ${manifest.runId}`);
  if (manifest.releaseId && !events.some((e) => e.type === "shipped" && e.releaseId === manifest.releaseId)) problems.push(`the audit chain records no shipped for ${manifest.releaseId}`);
  const integrity = problems.length ? "invalid" : "valid";

  // The signature: structure and binding first, then the key, which always comes from outside.
  let authenticity: BundleVerification["authenticity"] = "unverified";
  let keyId: string | undefined;
  const sigPath = join(dir, BUNDLE_SIGNATURE);
  const signed = presentPaths.has(BUNDLE_SIGNATURE);
  if (signed) {
    try {
      const envelope = DsseEnvelopeSchema.parse(JSON.parse(await readFile(sigPath, "utf8")));
      const payload = Buffer.from(envelope.payload, "base64");
      const statement = BundleStatementSchema.parse(JSON.parse(payload.toString("utf8")));
      keyId = envelope.signatures[0]!.keyid;
      if (canonicalJson(statement) !== payload.toString("utf8")) throw new Error("the statement is not in canonical form");
      if (statement.subject[0]!.digest.sha256 !== manifestSha256) throw new Error("the statement names another manifest");
      if (statement.predicate.runId !== manifest.runId || statement.predicate.releaseId !== manifest.releaseId || statement.predicate.ready !== manifest.ready) throw new Error("the predicate disagrees with the manifest");
      if (options.publicKey) {
        if (keyIdOf(options.publicKey) !== keyId) throw new Error(`signed by key ${keyId.slice(0, 16)}, not the key given (${keyIdOf(options.publicKey).slice(0, 16)})`);
        if (!edVerify(null, pae(envelope.payloadType, payload), options.publicKey, Buffer.from(envelope.signatures[0]!.sig, "base64"))) throw new Error("the signature does not verify");
        authenticity = "verified";
      }
    } catch (err: unknown) {
      authenticity = "invalid";
      problems.push(`signature: ${(err as Error).message.split("\n")[0]}`);
    }
  } else if (options.publicKey) {
    authenticity = "invalid";
    problems.push("a public key was given but the bundle is not signed");
  }
  return { integrity, authenticity, signed, ...(keyId ? { keyId } : {}), problems, manifest, manifestSha256, verdicts, passed: integrity === "valid" && authenticity !== "invalid" && (!options.publicKey || authenticity === "verified") };
}
