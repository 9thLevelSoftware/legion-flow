import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, trace } from "@opentelemetry/api";
import { SPAN_ATTRIBUTES, SPAN_NAMES, OtlpSpansEvidenceSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { createEvidenceTracing, hrTimeToNanos, encodeAttributes } from "../dist/index.js";

describe("evidence span records", () => {
  test("nanosecond times are decimal strings with full precision; only pinned attribute keys survive; arrays encode", () => {
    assert.equal(hrTimeToNanos([1791500000, 123456789]), "1791500000123456789");
    const encoded = encodeAttributes({
      [SPAN_ATTRIBUTES.RUN_ID]: "run_x",
      [SPAN_ATTRIBUTES.SEQ]: 3,
      [SPAN_ATTRIBUTES.AC_ID]: ["AC-01", "AC-02"],
      [SPAN_ATTRIBUTES.GEN_AI_COST]: 0.25,
      "legion.secret.path": "D:\\somewhere\\private",
      "prompt": "never recorded",
    });
    const keys = encoded.map((e) => e.key);
    assert.deepEqual(keys, ["gen_ai.usage.cost", "legion.ac.id", "legion.run.id", "legion.seq"]);
    assert.deepEqual(encoded.find((e) => e.key === "legion.seq")?.value, { intValue: "3" });
    assert.deepEqual(encoded.find((e) => e.key === "gen_ai.usage.cost")?.value, { doubleValue: 0.25 });
    assert.deepEqual(encoded.find((e) => e.key === "legion.ac.id")?.value, { arrayValue: { values: [{ stringValue: "AC-01" }, { stringValue: "AC-02" }] } });
  });

  test("spans parent explicitly to the run span, a step span flushes one record per step, the final flush writes the rest and audits once", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-evidence-"));
    const ws = Workspace.at(root);
    try {
      await ws.lock.withLock(async (held) => {
        await ws.project.create({ name: "E", adapterId: "fake", ownerId: "lead" }, held);
        const { run } = await ws.runs.create({ kind: "workflow", workflowId: "t", graphFingerprint: "sha256:" + "a".repeat(64), durability: "sync" }, held);
        const tracing = createEvidenceTracing({ ws, held, runId: run.id, serviceVersion: "9.9.9" });
        const t0 = new Date("2026-10-09T12:00:00.000Z");
        const runSpan = tracing.tracer.startSpan(SPAN_NAMES.RUN, { startTime: t0, attributes: { [SPAN_ATTRIBUTES.RUN_ID]: run.id, [SPAN_ATTRIBUTES.OBSERVATION_TYPE]: "run" } });
        const parent = trace.setSpan(context.active(), runSpan);
        const node = tracing.tracer.startSpan(`${SPAN_NAMES.NODE_PREFIX}a`, { startTime: t0, attributes: { [SPAN_ATTRIBUTES.RUN_ID]: run.id, [SPAN_ATTRIBUTES.SEQ]: 1, [SPAN_ATTRIBUTES.NODE]: "a", "legion.secret.path": "x" } }, parent);
        node.end(new Date(t0.getTime() + 5));
        const step = tracing.tracer.startSpan(SPAN_NAMES.STEP, { startTime: t0, attributes: { [SPAN_ATTRIBUTES.SEQ]: 1 } }, parent);
        step.end(new Date(t0.getTime() + 6));
        await tracing.flush(false);
        assert.equal(tracing.exporter.recorded.length, 1, "one record for step 1");
        assert.equal(tracing.exporter.recorded[0]?.seq, 1);

        runSpan.end(new Date(t0.getTime() + 10));
        const chainBefore = (await ws.audit.verify()).verifiedCount;
        await tracing.flush(true);
        assert.equal(tracing.exporter.recorded.length, 2, "the run span lands in the final record");
        assert.equal(tracing.exporter.recorded[1]?.seq, "final");
        await tracing.flush(true);
        assert.equal(tracing.exporter.recorded.length, 2, "a second final flush is a no-op");
        assert.equal((await ws.audit.verify()).verifiedCount, chainBefore + 1, "one evidence_recorded event");

        const first = OtlpSpansEvidenceSchema.parse(JSON.parse(await readFile(join(ws.paths.project, ...tracing.exporter.recorded[0]!.path.split("/")), "utf8")));
        const spans = (first.resourceSpans[0] as { scopeSpans: { scope: { name: string; version: string }; spans: Record<string, unknown>[] }[] }).scopeSpans[0]!;
        assert.equal(spans.scope.version, "9.9.9");
        assert.equal(spans.spans.length, 2, "the node span and the step span");
        const nodeSpan = spans.spans.find((s) => s.name === "legion.node.a")!;
        assert.equal(nodeSpan.parentSpanId, runSpan.spanContext().spanId, "parented explicitly to the run span");
        assert.match(String(nodeSpan.startTimeUnixNano), /^\d{19}$/);
        assert.equal(String(nodeSpan.endTimeUnixNano), (BigInt(String(nodeSpan.startTimeUnixNano)) + 5_000_000n).toString());
        const attrs = (nodeSpan.attributes as { key: string }[]).map((a) => a.key);
        assert.ok(!attrs.includes("legion.secret.path"), "the unpinned key was dropped");
        assert.ok(attrs.includes("legion.node"));

        const loaded = await ws.runs.load(run.id);
        assert.equal(loaded?.evidenceIndex.filter((e) => e.producedBy === "spans").length, 2, "both records are indexed as produced by spans");
        assert.equal((await ws.runs.verifyEvidence(loaded!)).ok, true);
        assert.equal((await readdir(join(loaded!.dir, "evidence"))).length, 2);
      }, "test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { postOtlp } from "../dist/index.js";

describe("loopback OTLP fan-out", async () => {
  test("each record is posted after it is written; a refusing or absent collector is counted, never thrown", async () => {
    const received: unknown[] = [];
    let mode: "ok" | "reject" | "500" = "ok";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        if (mode === "500") { res.writeHead(500); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: mode === "reject" ? { rejectedSpans: "2", errorMessage: "bad" } : {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const root = await mkdtemp(join(tmpdir(), "legion-flow-fanout-"));
    const ws = Workspace.at(root);
    try {
      await ws.lock.withLock(async (held) => {
        await ws.project.create({ name: "F", adapterId: "fake", ownerId: "lead" }, held);
        const { run } = await ws.runs.create({ kind: "workflow", workflowId: "t", graphFingerprint: "sha256:" + "a".repeat(64), durability: "sync" }, held);
        const tracing = createEvidenceTracing({ ws, held, runId: run.id, otlpEndpoint: endpoint });
        const span = tracing.tracer.startSpan(SPAN_NAMES.RUN, { attributes: { [SPAN_ATTRIBUTES.RUN_ID]: run.id } });
        span.end();
        await tracing.flush(true);
        assert.equal(tracing.exporter.recorded.length, 1);
        assert.equal(tracing.exporter.fanoutFailures, 0);
        assert.equal(received.length, 1, "the copy was posted");
        assert.ok(Array.isArray((received[0] as { resourceSpans: unknown[] }).resourceSpans));
      }, "test");
      mode = "reject";
      assert.match((await postOtlp(endpoint, [{}])).ok ? "" : (await postOtlp(endpoint, [{}]) as { reason: string }).reason, /rejected 2 span/);
      mode = "500";
      const fivehundred = await postOtlp(endpoint, [{}]);
      assert.equal(fivehundred.ok, false);
      server.close();
      const gone = await postOtlp(endpoint, [{}], 500);
      assert.match(gone.ok ? "" : gone.reason, /unreachable/);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Pinned: otel/opentelemetry-collector:0.123.0 @ sha256:e5e4a13f0ea98e7ca1d1d809be040180540146888d0d764abd4e1277cba87350
  const exec = promisify(execFile);
  const collectorImage = "otel/opentelemetry-collector:0.123.0";
  const present = await exec("docker", ["image", "inspect", collectorImage]).then(() => true, () => false);
  test("a real collector decodes our records: string intValue as an integer, nanoseconds exactly", { skip: present ? undefined : `${collectorImage} is not present locally` }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-otelcol-"));
    const name = "lf-otelcol-test";
    try {
      await writeFile(join(dir, "config.yaml"), "receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  debug:\n    verbosity: detailed\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n");
      await exec("docker", ["rm", "-f", name]).catch(() => {});
      await exec("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1:14319:4318", "-v", `${dir}:/etc/lf:ro`, collectorImage, "--config", "/etc/lf/config.yaml"]);
      let posted: Awaited<ReturnType<typeof postOtlp>> = { ok: false, reason: "not tried" };
      for (let i = 0; i < 30 && !posted.ok; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const { batchToOtlp } = await import("../dist/index.js");
        const fake = {
          name: "legion.node.spawn",
          kind: 0,
          spanContext: () => ({ traceId: "5b8efff798038103d269b633813fc60c", spanId: "eee19b7ec3c1b174", traceFlags: 1 }),
          startTime: [1791500000, 123456789],
          endTime: [1791500000, 128456789],
          attributes: { [SPAN_ATTRIBUTES.SEQ]: 3, [SPAN_ATTRIBUTES.AC_ID]: ["AC-01"] },
          status: { code: 0 },
        };
        posted = await postOtlp("http://127.0.0.1:14319", batchToOtlp([fake as never], { "service.name": "legion-flow" }, "0.0.0"), 2000);
      }
      assert.equal(posted.ok, true, posted.ok ? "" : posted.reason);
      await new Promise((r) => setTimeout(r, 1000));
      const { stdout, stderr } = await exec("docker", ["logs", name]);
      const logs = stdout + stderr;
      assert.match(logs, /legion\.seq: Int\(3\)/);
      assert.match(logs, /legion\.ac\.id: Slice\(\["AC-01"\]\)/);
      assert.match(logs, /22:53:20\.123456789/);
    } finally {
      await exec("docker", ["rm", "-f", name]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
