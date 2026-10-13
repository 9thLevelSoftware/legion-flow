import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { initCommand, statusCommand, doctorCommand, doctorItemToDiagnostic } from "../dist/index.js";
import { ResultEnvelopeSchema, ProjectConfigSchema } from "@9thlevelsoftware/legion-flow-schema";
import { AuditChain, getLegionFlowPaths, Workspace } from "@9thlevelsoftware/legion-flow-persist";

const contextFor = (dir: string) => ({ cwd: dir, isTTY: false, workspace: Workspace.at(dir) });

describe("command handlers (in-process, envelope is the test surface)", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-commands-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = () => contextFor(root);

  test("status before init: blocked, uninitialized, points at init", async () => {
    const env = await statusCommand(ctx(), {});
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "blocked");
    assert.equal(env.phase, "uninitialized");
    assert.equal(env.diagnostics[0]?.code, "project_not_initialized");
    assert.equal(env.nextAction.type, "command");
  });

  test("doctor before init: project_config is a warning, phase uninitialized", async () => {
    const env = await doctorCommand(ctx(), {});
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.phase, "uninitialized");
    const project = env.diagnostics.find((d) => d.code === "project_config");
    assert.equal(project?.severity, "warning");
    assert.match(project?.hint ?? "", /legion-flow init/);
    assert.ok(env.diagnostics.some((d) => d.code === "node_version" && d.severity === "info"));
    assert.ok(env.diagnostics.some((d) => d.code === "audit_chain"));
  });

  test("init: writes a schema-valid project.json, appends to the audit chain, returns ok", async () => {
    const env = await initCommand(ctx(), { adapter: "fake", name: "TestApp", owner: "lead_dev" });
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "ok");
    assert.equal(env.phase, "initialized");
    assert.equal(env.nextAction.type, "command");

    const paths = getLegionFlowPaths(root);
    const config = ProjectConfigSchema.parse(JSON.parse(await readFile(paths.projectConfig, "utf8")));
    assert.equal(config.name, "TestApp");
    assert.equal(config.adapter.default, "fake");
    assert.equal(config.decisionOwners[0]?.id, "lead_dev");
    assert.equal(config.controlMode, "guarded");

    const facts = Object.fromEntries(env.diagnostics.map((d) => [d.code, d.message]));
    assert.match(facts["project_initialized"] ?? "", /TestApp \(prj_/);
    assert.equal(facts["adapter"], "Default adapter: fake");

    const chain = await new AuditChain(paths.eventsJsonl, paths.chainJson).verify();
    assert.equal(chain.valid, true);
    assert.equal(chain.verifiedCount, 1);
  });

  test("status after init: ok with project and adapter facts", async () => {
    const env = await statusCommand(ctx(), {});
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "ok");
    assert.equal(env.phase, "initialized");
    const facts = Object.fromEntries(env.diagnostics.map((d) => [d.code, d.message]));
    assert.match(facts["project"] ?? "", /^Project: TestApp \(prj_/);
    assert.equal(facts["adapter"], "Adapter: fake");
  });

  test("doctor after init: project_config and audit_chain are info, phase initialized", async () => {
    const env = await doctorCommand(ctx(), {});
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.phase, "initialized");
    assert.equal(env.diagnostics.find((d) => d.code === "project_config")?.severity, "info");
    assert.equal(env.diagnostics.find((d) => d.code === "audit_chain")?.severity, "info");
    // Docker may be absent on CI: that is a warning, never an error, so status stays ok.
    assert.equal(env.status, "ok");
  });

  test("doctor on a tampered audit chain: blocked, exit-3 territory, re-run hint", async () => {
    const paths = getLegionFlowPaths(root);
    const events = await readFile(paths.eventsJsonl, "utf8");
    await writeFile(paths.eventsJsonl, events.replace("project_initialized", "project_tampered"));
    const env = await doctorCommand(ctx(), {});
    assert.equal(env.status, "blocked");
    const audit = env.diagnostics.find((d) => d.code === "audit_chain");
    assert.equal(audit?.severity, "error");
    assert.match(audit?.hint ?? "", /rebaseline-audit/);
    assert.equal(env.nextAction.type, "command");
    assert.equal((env.nextAction as { run: string }).run, "legion-flow doctor");
  });

  test("init on an existing project: refused with project_exists, record untouched", async () => {
    const before = await readFile(getLegionFlowPaths(root).projectConfig, "utf8");
    const env = await initCommand(ctx(), { adapter: "other", name: "Second", owner: "someone" });
    ResultEnvelopeSchema.parse(env);
    assert.equal(env.status, "refused");
    assert.equal(env.phase, "initialized");
    const diag = env.diagnostics.find((d) => d.code === "project_exists");
    assert.match(diag?.message ?? "", /TestApp \(prj_/);
    assert.equal(await readFile(getLegionFlowPaths(root).projectConfig, "utf8"), before);
  });

  test("corrupt record: status is blocked with the cause, doctor fails the check, init refuses", async () => {
    const corrupt = await mkdtemp(join(tmpdir(), "legion-flow-corrupt-"));
    try {
      const paths = getLegionFlowPaths(corrupt);
      await mkdir(paths.project, { recursive: true });
      await writeFile(paths.projectConfig, "{ definitely not json", "utf8");
      const c = contextFor(corrupt);

      const status = await statusCommand(c, {});
      ResultEnvelopeSchema.parse(status);
      assert.equal(status.status, "blocked");
      assert.equal(status.phase, "uninitialized");
      const sd = status.diagnostics.find((d) => d.code === "project_config_invalid");
      assert.equal(sd?.severity, "error");
      assert.match(sd?.message ?? "", /malformed json/);

      const doctor = await doctorCommand(c, {});
      assert.equal(doctor.status, "blocked");
      assert.equal(doctor.phase, "uninitialized");
      assert.equal(doctor.diagnostics.find((d) => d.code === "project_config")?.severity, "error");

      const init = await initCommand(c, { adapter: "fake", name: "X", owner: "o" });
      assert.equal(init.status, "refused");
      assert.equal(init.diagnostics[0]?.code, "project_config_invalid");
      assert.equal(await readFile(paths.projectConfig, "utf8"), "{ definitely not json");
    } finally {
      await rm(corrupt, { recursive: true, force: true });
    }
  });

  test("schema-invalid record: parseable JSON with an inline apiKey is blocked, not accepted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-schema-invalid-"));
    try {
      const paths = getLegionFlowPaths(dir);
      await mkdir(paths.project, { recursive: true });
      await writeFile(
        paths.projectConfig,
        JSON.stringify({
          schema: "legion-flow-project/v1",
          id: "prj_bad",
          name: "Bad",
          decisionOwners: [{ id: "h", displayName: "H", kind: "human" }],
          adapter: { default: "fake", http: { apiKey: "sk-inline" } },
          createdAt: new Date().toISOString(),
        })
      );
      const status = await statusCommand(contextFor(dir), {});
      assert.equal(status.status, "blocked");
      assert.match(status.diagnostics[0]?.message ?? "", /schema: .*apiKey/);
      const doctor = await doctorCommand(contextFor(dir), {});
      assert.equal(doctor.diagnostics.find((d) => d.code === "project_config")?.severity, "error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("init while another process holds the engine lock: refused, exit-2 territory, holder named", async () => {
    const other = await mkdtemp(join(tmpdir(), "legion-flow-locked-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const paths = getLegionFlowPaths(other);
      await mkdir(dirname(paths.engineLock), { recursive: true });
      await writeFile(
        paths.engineLock,
        JSON.stringify({ pid: child.pid, acquiredAt: "2026-10-08T00:00:00.000Z", command: "sleeper" }) + "\n"
      );

      const env = await initCommand(contextFor(other), { adapter: "fake", name: "X", owner: "o" });
      ResultEnvelopeSchema.parse(env);
      assert.equal(env.status, "refused");
      assert.equal(env.phase, "uninitialized");
      const diag = env.diagnostics.find((d) => d.code === "engine_lock_held");
      assert.match(diag?.message ?? "", new RegExp(`PID ${child.pid}`));
      assert.match(diag?.message ?? "", /sleeper/);
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
      await rm(other, { recursive: true, force: true });
    }
  });

  test("doctorItemToDiagnostic maps pass/warn/fail to info/warning/error and keeps the hint", () => {
    const d = doctorItemToDiagnostic({ code: "x", check: "X", status: "fail", message: "m", fixHint: "f" });
    assert.deepEqual(d, { code: "x", severity: "error", message: "m", hint: "f" });
    const noHint = doctorItemToDiagnostic({ code: "y", check: "Y", status: "pass", message: "m" });
    assert.equal("hint" in noHint, false);
  });
});
