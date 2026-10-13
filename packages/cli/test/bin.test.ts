import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const binPath = join(__dirname, "..", "dist", "bin.js");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [binPath, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Only what bin.ts itself does: sibling refusal, bare-command default, help rewrite, exit mapping. */
describe("legion-flow binary", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "legion-flow-bin-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("refuses legion-cli verbs with exit 2", async () => {
    const r = await run(["intent"], tempDir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /belongs to legion-cli/);
  });

  test("refuses legion-ascended verbs with exit 2", async () => {
    const r = await run(["start"], tempDir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /belongs to legion-ascended/);
  });

  test("bare command defaults to status; uninitialized is blocked, exit 3", async () => {
    const r = await run([], tempDir);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^status: blocked/);
  });

  test("--json yields exactly one envelope document on stdout and the status exit code", async () => {
    const r = await run(["status", "--json"], tempDir);
    assert.equal(r.code, 3);
    const envelope = ResultEnvelopeSchema.parse(JSON.parse(r.stdout));
    assert.equal(envelope.command, "status");
    assert.equal(envelope.status, "blocked");
  });

  test("--json with no verb also defaults to status", async () => {
    const r = await run(["--json"], tempDir);
    assert.equal(r.code, 3);
    const envelope = ResultEnvelopeSchema.parse(JSON.parse(r.stdout));
    assert.equal(envelope.command, "status");
  });

  test("a refusal through the binary: one envelope on stdout, exit 2", async () => {
    const r = await run(["recall", "--json"], tempDir);
    assert.equal(r.code, 2);
    const envelope = ResultEnvelopeSchema.parse(JSON.parse(r.stdout));
    assert.ok(envelope.status === "refused" || envelope.status === "usage_error", envelope.status);
    assert.equal(envelope.command, "recall");
  });

  test("bare mcp is a Commander usage error: exit 2, nothing on stdout (only --stdio owns stdout)", async () => {
    const r = await run(["mcp", "--json"], tempDir);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
    const both = await run(["mcp", "--stdio", "--http"], tempDir);
    assert.equal(both.code, 2, "exactly one transport");
    assert.equal(both.stdout, "");
  });

  test("help --all is rewritten to help-all and lists the catalog", async () => {
    const r = await run(["help", "--all"], tempDir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Full Command Catalog/);
    assert.match(r.stdout, /ship/);
    assert.match(r.stdout, /\[HUMAN-ONLY\]/);
  });

  test("--help exits 0; a usage error exits 2 with no envelope", async () => {
    const help = await run(["--help"], tempDir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: legion-flow/);

    const bad = await run(["init", "--json"], tempDir); // missing required --adapter
    assert.equal(bad.code, 2);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /required option/);
  });
});
