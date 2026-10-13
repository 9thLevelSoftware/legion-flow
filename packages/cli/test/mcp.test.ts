import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { registerReadOnlyTool, READ_ONLY } from "../dist/mcp.js";
import { initCommand } from "../dist/index.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

describe("M3 slice (d): the read-only MCP server", () => {
  test("the only registration path refuses a tool without all three read-only hints or an output schema", () => {
    const registered: string[] = [];
    const fake = { registerTool: ((name: string) => { registered.push(name); }) as never };
    const ok = async () => ({ content: [{ type: "text" as const, text: "x" }], structuredContent: {} });
    assert.throws(() => registerReadOnlyTool(fake, "w", { title: "w", description: "d", outputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: false } }, ok), /must declare readOnlyHint/);
    assert.throws(() => registerReadOnlyTool(fake, "w", { title: "w", description: "d", outputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false } }, ok), /must declare readOnlyHint/);
    assert.throws(() => registerReadOnlyTool(fake, "w", { title: "w", description: "d", outputSchema: undefined as never, annotations: READ_ONLY }, ok), /outputSchema/);
    registerReadOnlyTool(fake, "fine", { title: "f", description: "d", outputSchema: z.object({}), annotations: READ_ONLY }, ok);
    assert.deepEqual(registered, ["fine"]);
  });

  test("over stdio through the SDK's own client: exactly seven tools, all read-only with output schemas; status returns a valid envelope; show refuses an unknown run", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-mcp-"));
    await initCommand({ cwd: root, isTTY: false, workspace: Workspace.at(root) }, { adapter: "fake", name: "M", owner: "lead" });
    const client = new Client({ name: "legion-flow-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--stdio"], cwd: root, stderr: "pipe" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["doctor", "map", "next", "recall", "runs", "show", "status"]);
      for (const t of tools) {
        assert.equal(t.annotations?.readOnlyHint, true, t.name);
        assert.equal(t.annotations?.destructiveHint, false, t.name);
        assert.equal(t.annotations?.openWorldHint, false, t.name);
        assert.ok(t.outputSchema, `${t.name} declares an output schema`);
      }
      const status = await client.callTool({ name: "status", arguments: {} });
      assert.notEqual(status.isError, true);
      const env = ResultEnvelopeSchema.parse(status.structuredContent);
      assert.equal(env.command, "status");
      assert.equal(env.phase, "initialized");
      const runs = await client.callTool({ name: "runs", arguments: {} });
      assert.deepEqual((runs.structuredContent as { runs: unknown[] }).runs, []);
      const missing = await client.callTool({ name: "show", arguments: { runId: "run_missing" } });
      assert.equal(missing.isError, true);
      const bad = await client.callTool({ name: "show", arguments: { runId: "../etc" } });
      assert.equal(bad.isError, true);
      const fresh = await client.callTool({ name: "map", arguments: { query: "freshness" } });
      assert.equal((fresh.structuredContent as { freshness: string }).freshness, "absent");
      const noIndex = await client.callTool({ name: "map", arguments: { query: "deps", target: "src/a.ts" } });
      assert.equal(noIndex.isError, true, "no index is an error, never an empty answer");
      const recallNothing = await client.callTool({ name: "recall", arguments: {} });
      assert.equal(recallNothing.isError, true, "recall with no query is an error that still fits the output schema");
      const recalled = await client.callTool({ name: "recall", arguments: { query: "anything" } });
      assert.equal((recalled.structuredContent as { recall: { blocks: { source: string }[] } }).recall.blocks.map((b) => b.source).join(","), "map,deterministic,human,llm,transcript");
      const noRules = await client.callTool({ name: "map", arguments: { query: "check" } });
      assert.equal(noRules.isError, true, "check without map.rules is an error");
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
