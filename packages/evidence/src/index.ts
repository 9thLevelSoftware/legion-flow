import { context, type Attributes, type Tracer } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, type ReadableSpan, type SpanExporter, type SpanProcessor, type Span as SdkSpan } from "@opentelemetry/sdk-trace-base";
import { SPAN_ATTRIBUTE_KEYS, SPAN_NAMES, OtlpSpansEvidenceSchema, type OtlpSpansEvidence } from "@9thlevelsoftware/legion-flow-schema";
import type { HeldLock, Workspace } from "@9thlevelsoftware/legion-flow-persist";

export const EVIDENCE_SCOPE = "legion-flow";

/**
 * OTLP-JSON encoding of one attribute value. Integers are encoded as strings
 * in `intValue`, the protobuf JSON mapping's form (the OTel JS exporter has
 * shipped numbers); confirming this against a real collector is the fan-out
 * spike in M3 slice (d). Keys outside the pinned list are dropped by the caller.
 */
function encodeValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) {
    const values = value.map(encodeValue).filter((v): v is Record<string, unknown> => v !== null);
    return { arrayValue: { values } };
  }
  return null;
}

/** Only pinned keys survive; a future node cannot leak a path or a prompt by accident. */
export function encodeAttributes(attributes: Attributes): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const key of Object.keys(attributes).sort()) {
    if (!SPAN_ATTRIBUTE_KEYS.has(key)) continue;
    const value = encodeValue(attributes[key]);
    if (value) out.push({ key, value });
  }
  return out;
}

/** HrTime [seconds, nanos] to a decimal unix-nanosecond string; a Number would lose precision above 2^53. */
export function hrTimeToNanos(time: [number, number]): string {
  return (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString();
}

export function spanToOtlp(span: ReadableSpan): Record<string, unknown> {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: span.kind + 1, // OTLP SpanKind: UNSPECIFIED 0, INTERNAL 1 ...; the API enum starts at INTERNAL 0
    startTimeUnixNano: hrTimeToNanos(span.startTime),
    endTimeUnixNano: hrTimeToNanos(span.endTime),
    attributes: encodeAttributes(span.attributes),
    status: { code: span.status.code, ...(span.status.message ? { message: span.status.message } : {}) },
  };
}

/** One batch of spans as OTLP-JSON `resourceSpans`. */
export function batchToOtlp(spans: readonly ReadableSpan[], resourceAttributes: Attributes, scopeVersion: string): Record<string, unknown>[] {
  if (spans.length === 0) return [];
  return [
    {
      resource: { attributes: encodeAttributes(resourceAttributes).concat(Object.entries(resourceAttributes).filter(([k]) => k === "service.name").map(([k, v]) => ({ key: k, value: { stringValue: String(v) } }))) },
      scopeSpans: [{ scope: { name: EVIDENCE_SCOPE, version: scopeVersion }, spans: spans.map(spanToOtlp) }],
    },
  ];
}

export interface EvidenceExporterOptions {
  ws: Workspace;
  held: HeldLock;
  runId: string;
  serviceVersion?: string;
  /**
   * A loopback OTLP/HTTP collector that receives a copy of each record after
   * it is written (Optional CALL, off by default). The files in the run are the
   * evidence; the copy never gates and a failure never fails a run.
   */
  otlpEndpoint?: string;
  fanoutTimeoutMs?: number;
}

/** Post one batch to <endpoint>/v1/traces. A 2xx with rejected spans is a failure too. */
export async function postOtlp(endpoint: string, resourceSpans: unknown[], timeoutMs = 5000, extra: { headers?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  try {
    // No redirects (M4 slice n1): a hop would carry the records, and any auth header, to a host nobody chose.
    const res = await (extra.fetchImpl ?? fetch)(endpoint.replace(/\/+$/, "") + "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", ...(extra.headers ?? {}) },
      body: JSON.stringify({ resourceSpans }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) return { ok: false, reason: `collector answered HTTP ${res.status}; redirects are refused` };
    if (!res.ok) return { ok: false, reason: `collector answered HTTP ${res.status}`, status: res.status };
    try {
      const body = JSON.parse(text) as { partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string } };
      const rejected = Number(body.partialSuccess?.rejectedSpans ?? 0);
      if (rejected > 0) return { ok: false, reason: `collector rejected ${rejected} span(s): ${body.partialSuccess?.errorMessage ?? "no message"}` };
    } catch {
      // an empty or non-JSON 2xx body is accepted
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `collector unreachable: ${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}` };
  }
}

/**
 * The exporter: each batch becomes one `otlp_spans` evidence record on the
 * run, content-addressed and indexed as produced by "spans". Writes are queued
 * and awaited by forceFlush, since the processor's onEnd is synchronous.
 */
export class EvidenceSpanExporter implements SpanExporter {
  private readonly pending: Promise<void>[] = [];
  readonly recorded: { seq: number | "final"; sha256: string; path: string }[] = [];
  /** Export failures, for a diagnostic; a span record that did not land never fails a run. */
  failures = 0;
  /** Fan-out copies that the collector did not accept; reported, never gating. */
  fanoutFailures = 0;
  fanoutReasons: string[] = [];
  private seqOf: (spans: readonly ReadableSpan[]) => number | "final" = () => "final";

  constructor(private readonly options: EvidenceExporterOptions) {}

  setSeqResolver(resolve: (spans: readonly ReadableSpan[]) => number | "final"): void {
    this.seqOf = resolve;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const seq = this.seqOf(spans);
    const record: OtlpSpansEvidence = OtlpSpansEvidenceSchema.parse({
      kind: "otlp_spans",
      runId: this.options.runId,
      seq,
      resourceSpans: batchToOtlp(spans, { "service.name": EVIDENCE_SCOPE }, this.options.serviceVersion ?? "0.0.0"),
    });
    const write = this.options.ws.runs
      .writeEvidence(this.options.runId, record, this.options.held, "spans")
      .then(async (w) => {
        this.recorded.push({ seq, sha256: w.sha256, path: w.path });
        if (this.options.otlpEndpoint && record.resourceSpans.length > 0) {
          const posted = await postOtlp(this.options.otlpEndpoint, record.resourceSpans, this.options.fanoutTimeoutMs);
          if (!posted.ok) {
            this.fanoutFailures += 1;
            this.fanoutReasons.push(posted.reason);
          }
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((err: unknown) => {
        this.failures += 1;
        resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
      });
    this.pending.push(write);
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

/**
 * Collects the spans of one step and exports them when the engine's step span
 * ends (the flush signal), plus whatever is left at forceFlush. Node spans that
 * end after their step (none today) would join the next batch.
 */
export class StepSpanProcessor implements SpanProcessor {
  private buffer: ReadableSpan[] = [];
  private currentSeq: number | "final" = "final";

  constructor(private readonly exporter: EvidenceSpanExporter) {
    exporter.setSeqResolver(() => this.currentSeq);
  }

  onStart(_span: SdkSpan, _parentContext: ReturnType<typeof context.active>): void {}

  onEnd(span: ReadableSpan): void {
    this.buffer.push(span);
    if (span.name === SPAN_NAMES.STEP) {
      const seq = span.attributes["legion.seq"];
      this.currentSeq = typeof seq === "number" ? seq : "final";
      this.flushBuffer();
    }
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.exporter.export(batch, () => {});
  }

  async forceFlush(): Promise<void> {
    this.currentSeq = "final";
    this.flushBuffer();
    await this.exporter.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

export interface EvidenceTracing {
  tracer: Tracer;
  exporter: EvidenceSpanExporter;
  /** Export what is buffered; with `final`, also shut the provider down and audit the record hashes once. */
  flush(final: boolean): Promise<void>;
}

/**
 * One provider per run, never global. The returned `flush(true)` is what the
 * engine calls at every exit; it appends a single `evidence_recorded` audit
 * event naming every span record written for the run.
 */
export function createEvidenceTracing(options: EvidenceExporterOptions): EvidenceTracing {
  const exporter = new EvidenceSpanExporter(options);
  const processor = new StepSpanProcessor(exporter);
  const provider = new BasicTracerProvider({ resource: resourceFromAttributes({ "service.name": EVIDENCE_SCOPE }), spanProcessors: [processor] });
  const tracer = provider.getTracer(EVIDENCE_SCOPE, options.serviceVersion ?? "0.0.0");
  let closed = false;
  return {
    tracer,
    exporter,
    async flush(final) {
      if (closed) return;
      if (!final) {
        await processor.forceFlush();
        return;
      }
      closed = true;
      await provider.shutdown();
      if (exporter.recorded.length > 0) {
        await options.ws.audit.append(
          { type: "evidence_recorded", runId: options.runId, records: exporter.recorded.length, sha256: exporter.recorded.map((r) => r.sha256) },
          options.held
        );
      }
    },
  };
}
export * from "./bundle.js";
