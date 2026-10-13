/**
 * Optional CALL hooks (M4 slice l). A hook declared in project.json is inert until
 * a decision owner consents to it, as configured, on a terminal; any change to
 * the hook ends the consent. After each command the runner flushes: for every
 * enabled hook it delivers the audit events of its chosen types past a cursor, one
 * POST each, the audit event alone, and records the outcome. With no enabled hook
 * the flush does nothing at all: no lock, no read, no network.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_EVENT_TYPES, HOOK_AUDIT_TYPES, SCHEMA_VERSIONS, type Diagnostic, type HookConfig, type HookConsent, type ProjectConfig, type ResultEnvelope } from "@9thlevelsoftware/legion-flow-schema";
import { atomicWriteFile, canonicalJson, LockAcquisitionError, newId, sha256Hex, type HeldLock, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { postOtlp } from "@9thlevelsoftware/legion-flow-evidence";
import { spawnAllowed, resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { replayFacts } from "@9thlevelsoftware/legion-flow-memory";

export const HOOK_MAX_ATTEMPTS = 5;
/** At most this many deliveries per hook per flush, so a backlog behind a slow endpoint cannot hold the lock for long. */
export const HOOK_FLUSH_BATCH = 20;
/** OTLP batching (M4 slice w): records per request, and the cap on their combined resourceSpans JSON. */
export const OTLP_BATCH_RECORDS = 20;
export const OTLP_BATCH_BYTES = 1024 * 1024;
const HOOK_PAYLOAD_MAX = 64 * 1024;

export const hookConfigSha256 = (h: HookConfig) => createHash("sha256").update(canonicalJson(h)).digest("hex");
/**
 * What a consent binds to: the hook entry, and for a memory_export hook the mcpServers entry it names too
 * (M4 slice n2), so rewriting that server's command, arguments, or image ends the consent.
 */
export function hookConsentSha256(h: HookConfig, config: ProjectConfig): string {
  if (h.kind !== "memory_export") return hookConfigSha256(h);
  const server = (config.mcpServers ?? []).find((s) => s.name === h.server) ?? null;
  return createHash("sha256").update(canonicalJson({ hook: h, server })).digest("hex");
}
/** What a hook sends, in words. */
const whatItSends = (h: HookConfig) => (h.kind === "otlp" ? "run span records (otlp)" : h.kind === "memory_export" ? `facts and observations (memory_export${h.includeLlm ? ", agent facts included" : ""})` : (h.on ?? []).join(", "));
/** Where a hook sends, in words. */
const whereTo = (h: HookConfig) => (h.kind === "memory_export" ? `MCP server ${h.server}.${h.tool ?? "add_memory"} (${h.sandbox ?? "vm-docker"})` : new URL(h.url!).host);

/** Each declared hook and whether a consent receipt enables it as configured now. */
/** What to fix when a hook's credential fails (M4 slice s). */
function hookCredentialFix(hook: HookConfig): string {
  if (hook.kind === "memory_export") return `FIX: check the mcpServers entry '${hook.server}' (its command, image, and envKeys) and that the server offers the ${hook.tool ?? "add_memory"} tool; run legion-flow tools to probe it.`;
  const names = (hook.secrets ?? []).map((s) => s.ref.slice(4));
  return names.length ? `FIX: check ${names.join(", ")} in the environment that runs legion-flow; the endpoint refused it or it is not set.` : "FIX: the endpoint refused the request without a credential; declare the secret header it expects in the hook's secrets.";
}

/** Event types a hook's `on` may name: the registry, minus the hook's own delivery events, which are never sent. */
export function unknownHookEvents(hook: HookConfig): string[] {
  return (hook.on ?? []).filter((t) => !(AUDIT_EVENT_TYPES as readonly string[]).includes(t) || (HOOK_AUDIT_TYPES as readonly string[]).includes(t));
}

export async function hookStates(ws: Workspace, config: ProjectConfig): Promise<{ hook: HookConfig; enabled: boolean; consent?: HookConsent; reason: string; failing?: string; unknownEvents?: string[] }[]> {
  const consents = await ws.consents.list();
  const failingOf = async (name: string) => ((JSON.parse(await readFile(cursorPath(ws, name), "utf8").catch(() => "{}")) as { credentialFailure?: { reason: string } }).credentialFailure?.reason);
  const failing = new Map<string, string>();
  for (const h of config.hooks ?? []) {
    const f = await failingOf(h.name);
    if (f) failing.set(h.name, f);
  }
  return (config.hooks ?? []).map((hook) => ({ ...stateOf(hook), ...(failing.has(hook.name) ? { failing: failing.get(hook.name)! } : {}), ...(unknownHookEvents(hook).length ? { unknownEvents: unknownHookEvents(hook) } : {}) }));
  function stateOf(hook: HookConfig): { hook: HookConfig; enabled: boolean; consent?: HookConsent; reason: string } {
    const latest = consents.filter((c) => c.hook === hook.name).at(-1);
    const sha = hookConsentSha256(hook, config);
    if (!latest) return { hook, enabled: false, reason: "no consent" };
    if (latest.action === "disable") return { hook, enabled: false, consent: latest, reason: `disabled by ${latest.decidedBy.id}` };
    if (latest.configSha256 !== sha) return { hook, enabled: false, consent: latest, reason: "the hook changed after consent; consent again" };
    return { hook, enabled: true, consent: latest, reason: `enabled by ${latest.decidedBy.id}` };
  }
}

const cursorPath = (ws: Workspace, name: string) => join(ws.paths.varDir, "hooks", `cursor-${name}.json`);

/** Write a hook cursor only when it changed, so an idle flush leaves var/ alone (M4 slice u). */
async function writeCursor(ws: Workspace, name: string, cursor: unknown): Promise<void> {
  const text = JSON.stringify(cursor, null, 2) + "\n";
  if ((await readFile(cursorPath(ws, name), "utf8").catch(() => null)) === text) return;
  await atomicWriteFile(cursorPath(ws, name), text);
}

type LoggedEvent = { seq: number; event: Record<string, unknown>; end: number };

/** Counts for tests: how many flushes read the whole log and how many read only from a cursor (M4 slice s/t). */
export const hookReadStats = { full: 0, windowed: 0 };

/**
 * Parse complete audit lines from `buf`, which starts at byte `base` of the log. Rules (M4 slice t):
 * offsets are byte positions, never string indices (a non-ASCII character would shift them); only a line that ends
 * in "\n" and parses is an event with an end offset, so a half-written tail is never stepped over.
 */
function parseLines(buf: Buffer, base: number): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i).toString("utf8");
    start = i + 1;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event._seq === "number") out.push({ seq: event._seq, event, end: base + i + 1 });
    } catch {
      // not an event line
    }
  }
  return out;
}

/**
 * Read the log from a cursor's `{ seq, offset }` (the byte just after the line with that seq), or whole. The window is
 * trusted only when its first complete line carries seq + 1 (or it is empty at the end of the file); a rebaseline,
 * a shorter log, or an offset that lands mid-line falls back to a full read.
 */
async function readEvents(ws: Workspace, from: { seq: number; offset: number } | null = null): Promise<LoggedEvent[]> {
  const fh = await open(ws.paths.eventsJsonl, "r").catch(() => null);
  if (!fh) return [];
  try {
    const size = (await fh.stat()).size;
    if (from && from.offset <= size) {
      const length = size - from.offset;
      const buf = Buffer.alloc(length);
      // A short read is safe: the unread bytes stay zero, so the line they belong to never ends in a newline and the
      // tail rule leaves it, and every event after it, for the next flush.
      if (length) await fh.read(buf, 0, length, from.offset);
      const events = parseLines(buf, from.offset);
      const startsRight = (length === 0 && from.offset === size) || (events.length > 0 && events[0]!.seq === from.seq + 1 && (from.offset === 0 || (await precededByNewline(fh, from.offset))));
      if (startsRight) {
        hookReadStats.windowed++;
        return events;
      }
    }
    hookReadStats.full++;
    const buf = Buffer.alloc(size);
    if (size) await fh.read(buf, 0, size, 0);
    return parseLines(buf, 0);
  } finally {
    await fh.close();
  }
}

/** A window must begin at a line boundary: the byte before it is a newline. */
async function precededByNewline(fh: Awaited<ReturnType<typeof open>>, offset: number): Promise<boolean> {
  const one = Buffer.alloc(1);
  await fh.read(one, 0, 1, offset - 1);
  return one[0] === 0x0a;
}

/** Deliver every enabled hook's pending events; never throws, never gates, and touches nothing when no hook is enabled. */
export async function flushHooks(ws: Workspace, fetchImpl: typeof fetch = fetch): Promise<Diagnostic[]> {
  const project = await ws.project.load().catch(() => null);
  if (!project || project.kind !== "valid" || !(project.config.hooks ?? []).length) return [];
  const enabled = (await hookStates(ws, project.config)).filter((s) => s.enabled);
  if (enabled.length === 0) return [];
  try {
    return await ws.lock.withLock(async (held) => deliver(ws, project.config, enabled, held, fetchImpl), "hooks");
  } catch (err: unknown) {
    if (err instanceof LockAcquisitionError) return [{ code: "hook_flush_skipped", severity: "info", message: "Another command holds the engine lock; hook deliveries wait for the next command." }];
    throw err;
  }
}

async function deliver(ws: Workspace, config: ProjectConfig, enabled: { hook: HookConfig; consent?: HookConsent }[], held: HeldLock, fetchImpl: typeof fetch): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  type RawCursor = Record<string, unknown> & { seq?: number; offset?: number; baseline?: string | null; fromSeqOverride?: { consentId: string; fromSeq: number } };
  const cursorsBefore = new Map<string, RawCursor>();
  for (const { hook } of enabled) cursorsBefore.set(hook.name, JSON.parse(await readFile(cursorPath(ws, hook.name), "utf8").catch(() => "{}")) as RawCursor);
  // After an audit rebaseline the chain's numbers restart below where a hook stopped (M4 slice u). Each cursor records
  // the baseline it was taken under; meeting a newer one, its floor drops to the kept lines, so everything recorded
  // after the repair is delivered. Rules: the floor is max(cursor, consent) clamped once, and held as an override
  // tied to that consent, because every delivery path raises the cursor back to the consent's fromSeq; seq-keyed
  // state (attempts, partial, offset) resets with the clamp; a cursor written before this rule (no baseline field)
  // records the current baseline and is never clamped, so an old repair causes no redelivery.
  const chain = await ws.audit.readChain();
  const baselineId = chain.baseline?.priorBytesSha256 ?? null;
  const effective = new Map<string, HookConsent | undefined>();
  for (const { hook, consent } of enabled) {
    const c = cursorsBefore.get(hook.name)!;
    const legacy = typeof c.seq === "number" && c.baseline === undefined;
    if (!legacy && c.baseline !== baselineId && chain.baseline && (!consent || chain.baseline.at > consent.decidedAt)) {
      const floor = Math.min(Math.max(c.seq ?? 0, consent?.fromSeq ?? 0), chain.baseline.seq);
      c.seq = floor;
      delete c.offset;
      delete c.partial;
      c.attempts = {};
      if (consent) c.fromSeqOverride = { consentId: consent.id, fromSeq: floor };
      c.baseline = baselineId;
      await atomicWriteFile(cursorPath(ws, hook.name), JSON.stringify(c, null, 2) + "\n");
    }
    const ov = c.fromSeqOverride;
    effective.set(hook.name, consent && ov && ov.consentId === consent.id ? { ...consent, fromSeq: ov.fromSeq } : consent);
  }
  // The read is bounded by the oldest settled cursor (M4 slice t): a paused or lagging hook keeps the window wide.
  const starts = [...cursorsBefore.values()];
  let window: { seq: number; offset: number } | null = null;
  if (starts.every((c) => typeof c.seq === "number" && typeof c.offset === "number")) {
    for (const c of starts) if (window === null || c.offset! < window.offset) window = { seq: c.seq!, offset: c.offset! };
  }
  const events = await readEvents(ws, window);
  const endOf = new Map(events.map((e) => [e.seq, e.end]));
  const lastSeq = events.at(-1)?.seq;
  await mkdir(join(ws.paths.varDir, "hooks"), { recursive: true });
  for (const { hook } of enabled) {
    await deliverOne(hook, effective.get(hook.name));
    // Settle the offset beside the seq every delivery path left (M4 slice t). The delivery functions rebuild their
    // cursor field by field, so the offset is written here, after them: the end of the line with that seq when it
    // was read, the old offset when the seq did not move, or none (a full read next time).
    const path = cursorPath(ws, hook.name);
    const after = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<string, unknown> & { seq?: number };
    const before = cursorsBefore.get(hook.name)!;
    if (typeof after.seq !== "number") continue;
    const offset = endOf.get(after.seq) ?? (after.seq === before.seq ? before.offset : undefined);
    const settled: Record<string, unknown> = { ...after, baseline: baselineId, ...(before.fromSeqOverride ? { fromSeqOverride: before.fromSeqOverride } : {}) };
    if (offset === undefined) delete settled.offset;
    else settled.offset = offset;
    if (JSON.stringify(settled) === JSON.stringify(after)) continue;
    await atomicWriteFile(path, JSON.stringify(settled, null, 2) + "\n");
  }
  return out;

  async function deliverOne(hook: HookConfig, consent: HookConsent | undefined): Promise<void> {
    if (hook.kind === "otlp") {
      out.push(...(await deliverSpans(ws, hook, consent, events, held, fetchImpl, lastSeq)));
      return;
    }
    if (hook.kind === "memory_export") {
      out.push(...(await deliverMemory(ws, config, hook, consent, events, held, lastSeq)));
      return;
    }
    const stored = JSON.parse(await readFile(cursorPath(ws, hook.name), "utf8").catch(() => "{}")) as { seq?: number; attempts?: Record<string, number>; credentialFailure?: { reason: string; at: string } };
    const cursor: { seq: number; attempts: Record<string, number>; credentialFailure?: { reason: string; at: string }; baseline?: string | null; fromSeqOverride?: unknown } = { seq: Math.max(stored.seq ?? 0, consent?.fromSeq ?? 0), attempts: stored.attempts ?? {}, ...(stored.credentialFailure ? { credentialFailure: stored.credentialFailure } : {}), ...((stored as { baseline?: string | null }).baseline !== undefined ? { baseline: (stored as { baseline?: string | null }).baseline } : {}), ...((stored as { fromSeqOverride?: unknown }).fromSeqOverride ? { fromSeqOverride: (stored as { fromSeqOverride?: unknown }).fromSeqOverride } : {}), ...(typeof (stored as { offset?: unknown }).offset === "number" ? { offset: (stored as { offset?: number }).offset } : {}) };
    const pending = events.filter((e) => e.seq > cursor.seq && (hook.on ?? []).includes(String(e.event.type)) && !(HOOK_AUDIT_TYPES as readonly string[]).includes(String(e.event.type)));
    let delivered = 0;
    let stopped = false;
    for (const e of pending.slice(0, HOOK_FLUSH_BATCH)) {
      const body = JSON.stringify({ hook: hook.name, project: config.id, event: e.event });
      let failure: string | null = null;
      // An oversize event fails the same way every time: abandoned at once, not retried.
      const permanent = body.length > HOOK_PAYLOAD_MAX;
      if (permanent) failure = `the event is ${body.length} bytes, over the ${HOOK_PAYLOAD_MAX}-byte cap`;
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "legion-flow-hooks" };
      let credential = false;
      for (const s of hook.secrets ?? []) {
        const value = process.env[s.ref.slice(4)];
        if (value === undefined && !failure) [failure, credential] = [`${s.ref.slice(4)} is not set`, true];
        else if (value !== undefined) headers[s.header] = `${s.prefix ?? ""}${value}`;
      }
      if (!failure) {
        try {
          // No redirects: a hop to another host would carry the event and the secret header somewhere nobody consented to.
          const res = await fetchImpl(hook.url!, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(hook.timeoutMs ?? 5000) });
          if (res.status >= 300 && res.status < 400) failure = `HTTP ${res.status} redirect refused: a hook is delivered only to the URL consented to`;
          else if (res.status === 401 || res.status === 403) [failure, credential] = [`HTTP ${res.status}`, true];
          else if (!res.ok) failure = `HTTP ${res.status}`;
          await res.body?.cancel().catch(() => undefined);
        } catch (err: unknown) {
          failure = (err as Error).message.slice(0, 200);
        }
      }
      // A credential problem (M4 slice s) pauses the hook: no attempt counted, nothing abandoned, the cursor kept; it
      // retries after every command and `hooks` shows it failing until the key is fixed.
      if (failure && credential) {
        // The audit records the pause when it begins or its reason changes, never once per command.
        if (cursor.credentialFailure?.reason !== failure) await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, seq: e.seq, eventType: e.event.type, reason: failure, credential: true }, held);
        cursor.credentialFailure = { reason: failure, at: cursor.credentialFailure?.reason === failure ? cursor.credentialFailure.at : new Date().toISOString() };
        out.push({ code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} is paused: ${failure}. Nothing is lost; delivery resumes in order once the credential works.`, hint: hookCredentialFix(hook) });
        stopped = true;
        break;
      }
      if (!failure) {
        delete cursor.credentialFailure;
        cursor.seq = e.seq;
        delete cursor.attempts[String(e.seq)];
        delivered++;
        await ws.audit.append({ type: "hook_delivered", hook: hook.name, seq: e.seq, eventType: e.event.type }, held);
        continue;
      }
      const attempts = (cursor.attempts[String(e.seq)] ?? 0) + 1;
      if (permanent || attempts >= HOOK_MAX_ATTEMPTS) {
        cursor.seq = e.seq;
        delete cursor.attempts[String(e.seq)];
        await ws.audit.append({ type: "hook_delivery_abandoned", hook: hook.name, seq: e.seq, eventType: e.event.type, reason: failure, attempts }, held);
        out.push({ code: "hook_delivery_abandoned", severity: "warning", message: `Hook ${hook.name} gave up on event ${e.seq} (${String(e.event.type)}) after ${attempts} attempts: ${failure}.` });
        continue;
      }
      cursor.attempts[String(e.seq)] = attempts;
      await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, seq: e.seq, eventType: e.event.type, reason: failure, attempts }, held);
      out.push({ code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} could not deliver event ${e.seq} (${String(e.event.type)}): ${failure}; attempt ${attempts} of ${HOOK_MAX_ATTEMPTS}, retried after the next command.` });
      stopped = true;
      break; // keep order: later events wait behind this one
    }
    // Nothing left that this hook wants: its cursor moves to the end of what was read, so the next window starts there.
    if (!stopped && pending.length <= HOOK_FLUSH_BATCH && lastSeq !== undefined) cursor.seq = Math.max(cursor.seq, lastSeq);
    await writeCursor(ws, hook.name, cursor);
    if (delivered) out.push({ code: "hook_delivered", severity: "info", message: `Hook ${hook.name} delivered ${delivered} event(s).` });
  }
}

/**
 * An otlp hook (M4 slice n1): each run's span records, exactly as written as evidence, posted to the hook's
 * OTLP/HTTP endpoint, one record per POST. A run is in scope when its evidence_recorded event (appended once
 * its spans are complete) comes after the consent. The cursor is the seq of the last run fully sent, plus
 * how far into the next run it got.
 */
async function deliverSpans(ws: Workspace, hook: HookConfig, consent: HookConsent | undefined, events: { seq: number; event: Record<string, unknown> }[], held: HeldLock, fetchImpl: typeof fetch, lastSeq?: number): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const stored = JSON.parse(await readFile(cursorPath(ws, hook.name), "utf8").catch(() => "{}")) as { seq?: number; partial?: { seq: number; done: number }; attempts?: Record<string, number>; credentialFailure?: { reason: string; at: string } };
  const cursor: { seq: number; partial?: { seq: number; done: number }; attempts: Record<string, number>; credentialFailure?: { reason: string; at: string }; baseline?: string | null; fromSeqOverride?: unknown; single?: string[] } = { seq: Math.max(stored.seq ?? 0, consent?.fromSeq ?? 0), ...(stored.partial ? { partial: stored.partial } : {}), attempts: stored.attempts ?? {}, ...(stored.credentialFailure ? { credentialFailure: stored.credentialFailure } : {}), ...((stored as { baseline?: string | null }).baseline !== undefined ? { baseline: (stored as { baseline?: string | null }).baseline } : {}), ...((stored as { fromSeqOverride?: unknown }).fromSeqOverride ? { fromSeqOverride: (stored as { fromSeqOverride?: unknown }).fromSeqOverride } : {}), ...(typeof (stored as { offset?: unknown }).offset === "number" ? { offset: (stored as { offset?: number }).offset } : {}), ...(Array.isArray((stored as { single?: unknown }).single) ? { single: (stored as { single: string[] }).single } : {}) };
  const save = () => writeCursor(ws, hook.name, cursor);
  // Batching (M4 slice w) changes how many requests go out, never what is retried or abandoned: a record that failed
  // before, or was in a batch that failed, goes alone and keeps its own attempts; a missing or altered record is
  // abandoned alone and never joins a batch; a credential failure pauses whatever the batch size.
  const mustGoAlone = (sha: string) => cursor.attempts[sha] !== undefined || (cursor.single ?? []).includes(sha);
  const loadRecord = async (runId: string, sha: string): Promise<{ spans: unknown[]; bytes: number } | null> => {
    const bytes = await readFile(join(ws.paths.runsDir, runId, "evidence", `${sha}.json`)).catch(() => null);
    if (!bytes || sha256Hex(bytes) !== sha) return null;
    const spans = (JSON.parse(bytes.toString("utf8")) as { resourceSpans?: unknown[] }).resourceSpans ?? [];
    return { spans, bytes: Buffer.byteLength(JSON.stringify(spans)) };
  };
  const headers: Record<string, string> = {};
  let missingSecret: string | null = null;
  for (const s of hook.secrets ?? []) {
    const value = process.env[s.ref.slice(4)];
    if (value === undefined) missingSecret ??= `${s.ref.slice(4)} is not set`;
    else headers[s.header] = `${s.prefix ?? ""}${value}`;
  }
  let delivered = 0;
  let budget = HOOK_FLUSH_BATCH;
  const summary = () => (delivered ? [{ code: "hook_delivered", severity: "info" as const, message: `Hook ${hook.name} sent ${delivered} span record(s).` }] : []);
  for (const e of events.filter((x) => x.seq > cursor.seq && x.event.type === "evidence_recorded")) {
    const runId = String(e.event.runId);
    const shas = (e.event.sha256 as string[] | undefined) ?? [];
    for (let i = cursor.partial?.seq === e.seq ? cursor.partial.done : 0; i < shas.length; i++) {
      if (budget <= 0) {
        await save();
        return [...out, ...summary()];
      }
      // A batch: two or more consecutive records of this run that have never failed, within the record and byte caps.
      if (missingSecret === null && !mustGoAlone(shas[i]!)) {
        const batch: { sha: string; spans: unknown[] }[] = [];
        let bytes = 0;
        for (let j = i; j < shas.length && batch.length < Math.min(OTLP_BATCH_RECORDS, budget); j++) {
          if (mustGoAlone(shas[j]!)) break;
          const rec = await loadRecord(runId, shas[j]!);
          if (!rec || (batch.length > 0 && bytes + rec.bytes > OTLP_BATCH_BYTES)) break;
          batch.push({ sha: shas[j]!, spans: rec.spans });
          bytes += rec.bytes;
        }
        if (batch.length >= 2) {
          const posted = await postOtlp(hook.url!, batch.flatMap((b) => b.spans), hook.timeoutMs ?? 5000, { headers, fetchImpl });
          if (posted.ok) {
            for (const b of batch) {
              delivered++;
              delete cursor.attempts[b.sha];
              await ws.audit.append({ type: "hook_delivered", hook: hook.name, runId, evidenceSha256: b.sha, batch: batch.length }, held);
            }
            delete cursor.credentialFailure;
            budget -= batch.length;
            i += batch.length - 1;
            cursor.partial = { seq: e.seq, done: i + 1 };
            continue;
          }
          const credential = posted.status === 401 || posted.status === 403;
          cursor.partial = { seq: e.seq, done: i };
          if (credential) {
            if (cursor.credentialFailure?.reason !== posted.reason) await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, runId, evidenceSha256: batch[0]!.sha, reason: posted.reason, credential: true, batch: batch.length }, held);
            cursor.credentialFailure = { reason: posted.reason, at: cursor.credentialFailure?.reason === posted.reason ? cursor.credentialFailure.at : new Date().toISOString() };
            await save();
            return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} is paused: ${posted.reason}. Nothing is lost; delivery resumes in order once the credential works.`, hint: hookCredentialFix(hook) }, ...summary()];
          }
          // Any other failure: the batch's records go alone from the next flush, each with its own attempts.
          cursor.single = [...new Set([...(cursor.single ?? []), ...batch.map((b) => b.sha)])];
          await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, runId, evidenceSha256: batch[0]!.sha, reason: posted.reason, batch: batch.length }, held);
          await save();
          return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} could not send a batch of ${batch.length} span records of ${runId}: ${posted.reason}; they are retried one by one after the next command.` }, ...summary()];
        }
      }
      budget--;
      const sha = shas[i]!;
      let failure: string | null = missingSecret;
      let credential = missingSecret !== null;
      let permanent = false;
      let resourceSpans: unknown[] = [];
      if (!failure) {
        const bytes = await readFile(join(ws.paths.runsDir, runId, "evidence", `${sha}.json`)).catch(() => null);
        if (!bytes) [failure, permanent] = ["the span record is missing", true];
        else if (sha256Hex(bytes) !== sha) [failure, permanent] = ["the span record no longer matches its hash", true];
        else resourceSpans = (JSON.parse(bytes.toString("utf8")) as { resourceSpans?: unknown[] }).resourceSpans ?? [];
      }
      if (!failure) {
        const posted = await postOtlp(hook.url!, resourceSpans, hook.timeoutMs ?? 5000, { headers, fetchImpl });
        if (!posted.ok) {
          failure = posted.reason;
          credential = posted.status === 401 || posted.status === 403;
        }
      }
      if (failure && credential) {
        if (cursor.credentialFailure?.reason !== failure) await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, runId, evidenceSha256: sha, reason: failure, credential: true }, held);
        cursor.credentialFailure = { reason: failure, at: cursor.credentialFailure?.reason === failure ? cursor.credentialFailure.at : new Date().toISOString() };
        cursor.partial = { seq: e.seq, done: i };
        await save();
        return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} is paused: ${failure}. Nothing is lost; delivery resumes in order once the credential works.`, hint: hookCredentialFix(hook) }, ...summary()];
      }
      if (failure) {
        const attempts = (cursor.attempts[sha] ?? 0) + 1;
        if (!permanent && attempts < HOOK_MAX_ATTEMPTS) {
          cursor.attempts[sha] = attempts;
          cursor.partial = { seq: e.seq, done: i };
          await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, runId, evidenceSha256: sha, reason: failure, attempts }, held);
          await save();
          return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} could not send span record ${sha.slice(0, 12)} of ${runId}: ${failure}; attempt ${attempts} of ${HOOK_MAX_ATTEMPTS}, retried after the next command.` }, ...summary()];
        }
        delete cursor.attempts[sha];
        await ws.audit.append({ type: "hook_delivery_abandoned", hook: hook.name, runId, evidenceSha256: sha, reason: failure, attempts }, held);
        out.push({ code: "hook_delivery_abandoned", severity: "warning", message: `Hook ${hook.name} gave up on span record ${sha.slice(0, 12)} of ${runId}: ${failure}.` });
      } else {
        delivered++;
        delete cursor.credentialFailure;
        delete cursor.attempts[sha];
        await ws.audit.append({ type: "hook_delivered", hook: hook.name, runId, evidenceSha256: sha }, held);
      }
      if (cursor.single) {
        cursor.single = cursor.single.filter((s) => s !== sha);
        if (!cursor.single.length) delete cursor.single;
      }
      cursor.partial = { seq: e.seq, done: i + 1 };
    }
    cursor.seq = e.seq;
    delete cursor.partial;
  }
  if (lastSeq !== undefined && !cursor.partial) cursor.seq = Math.max(cursor.seq, lastSeq);
  await save();
  return [...out, ...summary()];
}

/** One memory item to export: its stable id and the three fields the tool receives (fixed in code; no person's identifier). */
interface MemoryItem {
  id: string;
  args: { name: string; episode_body: string; source_description: string };
}

/**
 * A memory_export hook (M4 slice n2): each fact that became active (learned, approved as a replacement, or
 * recorded by a retro) and each committed observation after the consent goes to the named MCP server's memory
 * tool, one call per item. Agent-recorded facts only with includeLlm. The server is started only when something
 * is pending, in the hook's tier, and stopped when the flush ends.
 */
async function deliverMemory(ws: Workspace, config: ProjectConfig, hook: HookConfig, consent: HookConsent | undefined, events: { seq: number; event: Record<string, unknown> }[], held: HeldLock, lastSeq?: number): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const stored = JSON.parse(await readFile(cursorPath(ws, hook.name), "utf8").catch(() => "{}")) as { seq?: number; partial?: { seq: number; done: number }; attempts?: Record<string, number>; credentialFailure?: { reason: string; at: string } };
  const cursor: { seq: number; partial?: { seq: number; done: number }; attempts: Record<string, number>; credentialFailure?: { reason: string; at: string }; baseline?: string | null; fromSeqOverride?: unknown } = { seq: Math.max(stored.seq ?? 0, consent?.fromSeq ?? 0), ...(stored.partial ? { partial: stored.partial } : {}), attempts: stored.attempts ?? {}, ...(stored.credentialFailure ? { credentialFailure: stored.credentialFailure } : {}), ...((stored as { baseline?: string | null }).baseline !== undefined ? { baseline: (stored as { baseline?: string | null }).baseline } : {}), ...((stored as { fromSeqOverride?: unknown }).fromSeqOverride ? { fromSeqOverride: (stored as { fromSeqOverride?: unknown }).fromSeqOverride } : {}), ...(typeof (stored as { offset?: unknown }).offset === "number" ? { offset: (stored as { offset?: number }).offset } : {}) };
  const save = () => writeCursor(ws, hook.name, cursor);
  const triggers = events.filter((e) => e.seq > cursor.seq && ["fact_learned", "fact_superseded", "retro_recorded", "observation_committed"].includes(String(e.event.type)));
  if (triggers.length === 0) {
    // Nothing this hook exports was recorded: move its cursor to the end of what was read, so it never holds the window open.
    if (lastSeq !== undefined && lastSeq > cursor.seq && !cursor.partial) {
      cursor.seq = lastSeq;
      await save();
    }
    return [];
  }
  const episodes = (await ws.episodes.list()).flatMap((x) => (x.kind === "valid" ? [x.episode] : []));
  const rows = new Map(replayFacts(episodes).map((r) => [r.id, r]));
  const factItem = (id: string, row: { subject: string; predicate: string; object: { ref: string } | { text: string }; origin: string; validAt: string }): MemoryItem => ({ id, args: { name: id, episode_body: `${row.subject} ${row.predicate} ${"ref" in row.object ? row.object.ref : row.object.text}`, source_description: `legion-flow ${row.origin} fact, valid from ${row.validAt}` } });
  /** The items an event stands for, or a reason it stands for nothing that can be found. */
  const itemsOf = (e: { event: Record<string, unknown> }): MemoryItem[] | string => {
    const t = String(e.event.type);
    if (t === "fact_learned" || t === "fact_superseded") {
      const id = String(t === "fact_learned" ? e.event.factId : e.event.newFactId);
      const row = rows.get(id);
      if (!row) return `fact ${id} is not in memory`;
      const sent = row.origin === "llm" && !hook.includeLlm ? [] : [factItem(id, row)];
      if (t === "fact_learned") return sent;
      // M4 slice t: each retired fact goes out after the new one, so the memory server learns the old statement no longer holds.
      const retired = ((e.event.oldFactIds as string[] | undefined) ?? []).flatMap((old): MemoryItem[] => {
        const r = rows.get(old);
        if (!r || (r.origin === "llm" && !hook.includeLlm)) return [];
        return [{ id: `${old}#retired`, args: { name: `${old}#retired`, episode_body: `retired: ${r.subject} ${r.predicate} ${"ref" in r.object ? r.object.ref : r.object.text}; superseded by ${id}`, source_description: `legion-flow supersession, recorded ${String(e.event._timestamp ?? "")}` } }];
      });
      return [...sent, ...retired];
    }
    const ep = episodes.find((x) => x.id === e.event.episodeId);
    if (!ep) return `episode ${String(e.event.episodeId)} is not in memory`;
    if (ep.kind === "retro") return ep.facts.filter((f) => f.origin !== "llm" || hook.includeLlm).map((f) => factItem(`${ep.id}#${f.id}`, f));
    if (ep.kind === "observation") return [{ id: ep.id, args: { name: ep.id, episode_body: `${ep.name}: ${ep.summary}`, source_description: `legion-flow observation, committed ${ep.createdAt}` } }];
    return `episode ${ep.id} is not a retro or an observation`;
  };
  const pending = triggers.map((e) => ({ e, items: itemsOf(e) }));
  if (!pending.some((p) => typeof p.items === "string" || p.items.length > 0)) {
    cursor.seq = triggers.at(-1)!.seq;
    delete cursor.partial;
    await save();
    return [];
  }
  // Something is pending. Start the server once for this flush, and only when there is an item to send:
  // an unfindable fact is abandoned without one.
  const needsServer = pending.some((p) => Array.isArray(p.items) && p.items.length > 0);
  const server = (config.mcpServers ?? []).find((s) => s.name === hook.server);
  const tier = hook.sandbox ?? "vm-docker";
  let failureAll: string | null = null;
  if (!server) failureAll = `project.json mcpServers declares no server '${hook.server}'`;
  else {
    const policy = spawnAllowed({ kind: "mcp_server", tier, hardened: tier === "vm-docker", ...(config.sandbox?.require ? { require: true } : {}) });
    if (!policy.ok) failureAll = policy.message;
    else if (tier === "vm-docker" && !server.image) failureAll = `server ${server.name} has no image for the vm-docker tier`;
  }
  const mcp = failureAll || !needsServer ? null : await import("./mcp-client.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  let client: InstanceType<typeof Client> | null = null;
  let kill: (() => Promise<void>) | null = null;
  const toolName = hook.tool ?? "add_memory";
  try {
    if (mcp && server) {
      try {
        const { open, env } = mcp.serverSession(server, tier, resolveDockerSettings(config.sandbox));
        const session = await open({ command: server.command, args: server.args ?? [], root: ws.root, env });
        kill = () => session.kill();
        client = new Client({ name: "legion-flow-memory-export", version: "0" });
        await client.connect(new mcp.PipedTransport(session), { timeout: server.timeoutMs ?? 30_000 });
        const listed = await client.listTools(undefined, { timeout: server.timeoutMs ?? 30_000 });
        if (!listed.tools.some((t) => t.name === toolName)) failureAll = `server ${server.name} offers no tool ${toolName}`;
      } catch (err: unknown) {
        failureAll = `server ${server.name} could not start: ${(err as Error).message.slice(0, 200)}`;
      }
    }
    let delivered = 0;
    let budget = HOOK_FLUSH_BATCH;
    for (const { e, items } of pending) {
      if (typeof items === "string") {
        await ws.audit.append({ type: "hook_delivery_abandoned", hook: hook.name, seq: e.seq, reason: items, attempts: 1 }, held);
        out.push({ code: "hook_delivery_abandoned", severity: "warning", message: `Hook ${hook.name} skipped event ${e.seq}: ${items}.` });
        cursor.seq = e.seq;
        delete cursor.partial;
        continue;
      }
      for (let i = cursor.partial?.seq === e.seq ? cursor.partial.done : 0; i < items.length; i++) {
        if (budget-- <= 0) {
          await save();
          return [...out, ...(delivered ? [{ code: "hook_delivered", severity: "info" as const, message: `Hook ${hook.name} exported ${delivered} item(s).` }] : [])];
        }
        const item = items[i]!;
        let failure = failureAll;
        // M4 slice s: a failure of the server itself is the environment, not this item: pause, count nothing, abandon nothing.
        if (failureAll) {
          if (cursor.credentialFailure?.reason !== failureAll) await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, seq: e.seq, item: item.id, reason: failureAll, credential: true }, held);
          cursor.credentialFailure = { reason: failureAll, at: cursor.credentialFailure?.reason === failureAll ? cursor.credentialFailure.at : new Date().toISOString() };
          cursor.partial = { seq: e.seq, done: i };
          await save();
          return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} is paused: ${failureAll}. Nothing is lost; delivery resumes in order once the server starts.`, hint: hookCredentialFix(hook) }, ...(delivered ? [{ code: "hook_delivered", severity: "info" as const, message: `Hook ${hook.name} exported ${delivered} item(s).` }] : [])];
        }
        if (!failure) {
          try {
            const result = (await client!.callTool({ name: toolName, arguments: item.args }, undefined, { timeout: server!.timeoutMs ?? 30_000 })) as { isError?: boolean; content?: { text?: string }[] };
            if (result.isError) failure = `the tool answered an error: ${String(result.content?.[0]?.text ?? "").slice(0, 160)}`;
          } catch (err: unknown) {
            failure = (err as Error).message.slice(0, 200);
          }
        }
        if (failure) {
          const attempts = (cursor.attempts[item.id] ?? 0) + 1;
          if (attempts < HOOK_MAX_ATTEMPTS) {
            cursor.attempts[item.id] = attempts;
            cursor.partial = { seq: e.seq, done: i };
            await ws.audit.append({ type: "hook_delivery_failed", hook: hook.name, seq: e.seq, item: item.id, reason: failure, attempts }, held);
            await save();
            return [...out, { code: "hook_delivery_failed", severity: "warning", message: `Hook ${hook.name} could not export ${item.id}: ${failure}; attempt ${attempts} of ${HOOK_MAX_ATTEMPTS}, retried after the next command.` }, ...(delivered ? [{ code: "hook_delivered", severity: "info" as const, message: `Hook ${hook.name} exported ${delivered} item(s).` }] : [])];
          }
          delete cursor.attempts[item.id];
          await ws.audit.append({ type: "hook_delivery_abandoned", hook: hook.name, seq: e.seq, item: item.id, reason: failure, attempts }, held);
          out.push({ code: "hook_delivery_abandoned", severity: "warning", message: `Hook ${hook.name} gave up on ${item.id}: ${failure}.` });
        } else {
          delivered++;
          delete cursor.credentialFailure;
          delete cursor.attempts[item.id];
          await ws.audit.append({ type: "hook_delivered", hook: hook.name, seq: e.seq, item: item.id }, held);
        }
        cursor.partial = { seq: e.seq, done: i + 1 };
      }
      cursor.seq = e.seq;
      delete cursor.partial;
    }
    if (lastSeq !== undefined && !cursor.partial) cursor.seq = Math.max(cursor.seq, lastSeq);
    await save();
    return [...out, ...(delivered ? [{ code: "hook_delivered", severity: "info" as const, message: `Hook ${hook.name} exported ${delivered} item(s).` }] : [])];
  } finally {
    await client?.close().catch(() => undefined);
    await kill?.().catch(() => undefined);
  }
}

export interface HooksOptions {
  enable?: string;
  disable?: string;
  approver?: string;
}

type Envelope = (status: ResultEnvelope["status"], diagnostics: Diagnostic[], next: ResultEnvelope["nextAction"]) => Promise<ResultEnvelope>;

/** `hooks`: list, or `--enable` / `--disable` as a decision owner on a terminal. */
export async function hooksVerb(ws: Workspace, isTTY: boolean, config: ProjectConfig, opts: HooksOptions, envelope: Envelope, held: HeldLock, statusNext: () => Promise<ResultEnvelope["nextAction"]>): Promise<ResultEnvelope> {
  const name = opts.enable ?? opts.disable;
  if (opts.enable !== undefined && opts.disable !== undefined) return envelope("usage_error", [{ code: "hooks_usage", severity: "error", message: "Give --enable or --disable, not both." }], { type: "command", run: "legion-flow hooks" });
  if (name === undefined) {
    const states = await hookStates(ws, config);
    if (states.length === 0) return envelope("ok", [{ code: "hooks_none", severity: "info", message: "project.json declares no hooks; Legion calls no external service." }], await statusNext());
    return envelope("ok", states.flatMap((s): Diagnostic[] => [
      { code: s.enabled ? "hook_enabled" : "hook_disabled", severity: "info" as const, message: `${s.hook.name} -> ${whereTo(s.hook)} on ${whatItSends(s.hook)}: ${s.enabled ? "enabled" : "disabled"} (${s.reason}).` },
      ...(s.enabled && s.failing ? [{ code: "hook_failing", severity: "warning" as const, message: `${s.hook.name} is failing: ${s.failing}; its events wait, none is lost.`, hint: hookCredentialFix(s.hook) }] : []),
      ...(s.unknownEvents ? [{ code: "hook_event_unknown", severity: "warning" as const, message: `${s.hook.name} names event type(s) that never fire: ${s.unknownEvents.join(", ")}.` }] : []),
    ]), await statusNext());
  }
  if (!isTTY) return envelope("refused", [{ code: "hook_consent_requires_tty", severity: "error", message: "Consent to an external call is a human act and is recorded only from a terminal." }], { type: "none", reason: "Consent is a human act." });
  const owner = config.decisionOwners.find((o) => o.id === opts.approver);
  if (!owner) return envelope("refused", [{ code: "approver_not_decision_owner", severity: "error", message: `--approver must name a decision owner (owners: ${config.decisionOwners.map((o) => o.id).join(", ")}).` }], { type: "none", reason: "Only a decision owner consents." });
  const hook = (config.hooks ?? []).find((h) => h.name === name);
  if (!hook) return envelope("refused", [{ code: "hook_unknown", severity: "error", message: `project.json declares no hook '${name}'.` }], await statusNext());
  const action = opts.enable !== undefined ? "enable" : "disable";
  // M4 slice s: a type outside the registry (a typo) or a hook's own delivery event would never fire.
  const unknown = action === "enable" ? unknownHookEvents(hook) : [];
  if (unknown.length) return envelope("refused", [{ code: "hook_event_unknown", severity: "error", message: `Hook ${hook.name} names event type(s) that never fire: ${unknown.join(", ")}. A hook may name any recorded event except the hooks' own delivery events.`, hint: `Known types include ${AUDIT_EVENT_TYPES.filter((t) => !HOOK_AUDIT_TYPES.includes(t)).slice(0, 8).join(", ")}, ...` }], await statusNext());
  if (action === "enable" && hook.kind === "memory_export") {
    if (!(config.mcpServers ?? []).some((s) => s.name === hook.server)) return envelope("refused", [{ code: "hook_server_unknown", severity: "error", message: `Hook ${hook.name} names server '${hook.server}', which project.json mcpServers does not declare.` }], await statusNext());
    const policy = spawnAllowed({ kind: "mcp_server", tier: hook.sandbox ?? "vm-docker", hardened: (hook.sandbox ?? "vm-docker") === "vm-docker", ...(config.sandbox?.require ? { require: true } : {}) });
    if (!policy.ok) return envelope("refused", [{ code: policy.code, severity: "error", message: policy.message, hint: policy.hint }], await statusNext());
  }
  const fromSeq = (await ws.audit.readChain()).length;
  const consent: HookConsent = { schema: SCHEMA_VERSIONS.HOOK_CONSENT, id: newId("hkc"), hook: hook.name, configSha256: hookConsentSha256(hook, config), action, ...(action === "enable" ? { fromSeq } : {}), decidedBy: owner, decidedAt: new Date().toISOString(), source: "tty" };
  const path = await ws.consents.record(consent, held);
  await ws.audit.append({ type: action === "enable" ? "hook_enabled" : "hook_disabled", hook: hook.name, configSha256: consent.configSha256, to: whereTo(hook), kind: hook.kind ?? "event", on: hook.on ?? null, decidedBy: owner.id }, held);
  return envelope("ok", [{ code: action === "enable" ? "hook_enabled" : "hook_disabled", severity: "info", message: action === "enable" ? `${hook.name} is enabled by ${owner.id}: ${whatItSends(hook)} recorded from now on go to ${whereTo(hook)}. Any change to the hook disables it until you consent again.` : `${hook.name} is disabled by ${owner.id}; nothing more is sent.`, path }], await statusNext());
}
