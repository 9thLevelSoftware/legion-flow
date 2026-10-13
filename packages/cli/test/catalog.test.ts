import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { createCli, COMMAND_CATALOG, plannedMarker, type RunnerIo } from "../dist/index.js";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

function captureIo(): RunnerIo & { out: string[]; err: string[]; exitCode: number | undefined } {
  const io = {
    out: [] as string[],
    err: [] as string[],
    exitCode: undefined as number | undefined,
    stdout(text: string) {
      io.out.push(text);
    },
    stderr(text: string) {
      io.err.push(text);
    },
    setExitCode(code: number) {
      io.exitCode = code;
    },
  };
  return io;
}

describe("command catalog is the single source of registration", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-catalog-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("every catalog verb is registered, plus help-all", () => {
    const registered = new Set(createCli().commands.map((c) => c.name()));
    for (const entry of COMMAND_CATALOG) {
      assert.ok(registered.has(entry.name), `${entry.name} is in the catalog but not registered`);
    }
    assert.ok(registered.has("help-all"));
    assert.equal(registered.size, COMMAND_CATALOG.length + 1, "no command is registered outside the catalog");
  });

  test("catalog milestones match the architecture document's verb table", () => {
    const byName = Object.fromEntries(COMMAND_CATALOG.map((e) => [e.name, e]));
    for (const name of ["init", "status", "doctor"]) {
      assert.equal(byName[name]?.milestone, "M0");
      assert.ok(byName[name]?.handler, `${name} is M0 and must have a handler`);
    }
    for (const name of ["spec", "approve", "plan", "decide", "ship"]) assert.equal(byName[name]?.milestone, "M1");
    assert.equal(byName["execute"]?.milestone, "M2");
    for (const name of ["review", "eval"]) assert.equal(byName[name]?.milestone, "M3");
    // Built so far: all of M0 and M1, and execute from M2 slice (a).
    for (const name of ["spec", "plan", "approve", "ship", "decide", "execute", "next", "review", "eval"]) assert.ok(byName[name]?.handler, `${name} is built and must have a handler`);
    assert.equal(byName["next"]?.milestone, "M2");
    assert.ok(byName["mcp"]?.server && !byName["mcp"]?.handler, "mcp is a server entry, outside the envelope runner");
    for (const name of ["map", "learn", "retro", "recall"]) {
      assert.equal(byName[name]?.milestone, "M4");
      assert.ok(byName[name]?.handler, `${name} is built in M4 and must have a handler`);
    }
    // Since M4 slice (c) no catalog verb is planned; the mechanism is tested below with a synthetic entry.
    assert.equal(COMMAND_CATALOG.filter((e) => !e.handler && !e.server).length, 0);
  });

  test("a planned verb answers --json with a refused envelope naming its milestone, whatever the argv (synthetic entry: none is left in the catalog)", async () => {
    const synthetic = { name: "futureverb", summary: "A verb that is designed but not built", usage: "legion-flow futureverb", humanOnly: false, category: "inspection" as const, milestone: "M4" as const, options: [] };
    const catalog = [...COMMAND_CATALOG, synthetic];
    for (const entry of catalog.filter((e) => !("handler" in e && e.handler) && !("server" in e && e.server))) {
      const io = captureIo();
      const cli = createCli({ io, catalog, context: () => ({ cwd: root, isTTY: false, workspace: Workspace.at(root) }) });
      try {
        await cli.parseAsync(["node", "legion-flow", entry.name, "--json", "--some-flag", "value", "extra"]);
      } catch (err) {
        assert.fail(`${entry.name} threw ${err instanceof CommanderError ? err.code : String(err)} instead of refusing`);
      }
      assert.equal(io.out.length, 1, `${entry.name} wrote ${io.out.length} documents`);
      const envelope = ResultEnvelopeSchema.parse(JSON.parse(io.out[0]!));
      assert.equal(envelope.command, entry.name);
      assert.equal(envelope.status, "refused");
      assert.equal(envelope.diagnostics[0]?.code, "verb_not_implemented");
      assert.match(envelope.diagnostics[0]?.message ?? "", new RegExp(`milestone ${entry.milestone}`));
      assert.equal(io.exitCode, 2);
    }
  });

  test("help-all lists every verb and marks the planned ones", async () => {
    const io = captureIo();
    await createCli({ io }).parseAsync(["node", "legion-flow", "help-all"]);
    const text = io.out.join("");
    for (const entry of COMMAND_CATALOG) {
      assert.ok(text.includes(`${entry.name.padEnd(12)} - ${entry.summary}`), `${entry.name} missing from help-all`);
      const line = text.split("\n").find((l) => l.startsWith(entry.name.padEnd(12)))!;
      assert.equal(line.includes(plannedMarker(entry.milestone)), !entry.handler && !entry.server, `planned marker wrong for ${entry.name}`);
      assert.equal(line.includes("[HUMAN-ONLY]"), entry.humanOnly, `human-only tag wrong for ${entry.name}`);
    }
  });

  test("options are registered from the catalog: init requires --adapter and defaults --name", async () => {
    const init = createCli().commands.find((c) => c.name() === "init")!;
    const flags = init.options.map((o) => o.flags);
    assert.ok(flags.includes("-a, --adapter <id>"));
    assert.ok(flags.includes("-n, --name <name>"));
    assert.equal(init.options.find((o) => o.long === "--adapter")?.mandatory, true);
    assert.equal(init.options.find((o) => o.long === "--name")?.defaultValue, "legion-flow-project");
  });
});
