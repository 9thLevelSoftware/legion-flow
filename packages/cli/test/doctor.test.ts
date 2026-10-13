import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, compareVersions, NODE_FLOOR, type SystemProbe } from "../dist/index.js";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";

interface FakeMachine {
  node?: string;
  which?: Record<string, string[]>;
  run?: Record<string, string | null>;
  sqlite?: { ok: true; sqliteVersion: string } | { ok: false; reason: string };
}

/** The test adapter: scripted answers, no shell, no process. */
function fakeProbe(machine: FakeMachine): SystemProbe {
  return {
    nodeVersion: () => machine.node ?? NODE_FLOOR,
    which: async (binary) => machine.which?.[binary] ?? [],
    run: async (command, args) => machine.run?.[[command, ...args].join(" ")] ?? null,
    sqlite: async () => machine.sqlite ?? { ok: true, sqliteVersion: "3.0.0-fake" },
    browser: async () => null,
  };
}

describe("doctor behind the system-probe seam", () => {
  let ws: Workspace;

  before(async () => {
    ws = Workspace.at(await mkdtemp(join(tmpdir(), "legion-flow-doctor-")));
  });

  after(async () => {
    await rm(ws.root, { recursive: true, force: true });
  });

  const byCode = (report: Awaited<ReturnType<typeof runDoctor>>) =>
    Object.fromEntries(report.diagnostics.map((d) => [d.code, d]));

  test("the memory index driver is checked through the probe: a broken driver fails with a FIX line", async () => {
    const good = byCode(await runDoctor(ws, fakeProbe({})))["index_sqlite"];
    assert.equal(good?.status, "pass");
    const bad = byCode(await runDoctor(ws, fakeProbe({ sqlite: { ok: false, reason: "no such module: fts5" } })))["index_sqlite"];
    assert.equal(bad?.status, "fail");
    assert.match(bad?.message ?? "", /fts5/);
    assert.match(bad?.fixHint ?? "", /^FIX:/);
  });

  test("old Node fails the floor with the upgrade hint and blocks readiness", async () => {
    const report = await runDoctor(ws, fakeProbe({ node: "22.12.9" }));
    const diag = byCode(report)["node_version"];
    assert.equal(diag?.status, "fail");
    assert.match(diag?.message ?? "", /below required >= 22\.13\.0/);
    assert.match(diag?.fixHint ?? "", /22\.13\.0/);
    assert.equal(report.allPassed, false);
  });

  test("Node at and above the floor passes, and nothing else fails on an empty workspace", async () => {
    for (const node of [NODE_FLOOR, "22.13.1", "24.19.0"]) {
      const report = await runDoctor(ws, fakeProbe({ node }));
      assert.equal(byCode(report)["node_version"]?.status, "pass", node);
      assert.equal(report.allPassed, true, node);
      assert.equal(report.project.kind, "absent");
      assert.equal(byCode(report)["project_config"]?.status, "warn");
    }
  });

  test("a shadowing 'legion' on PATH warns; its absence produces no diagnostic", async () => {
    const shadowed = await runDoctor(ws, fakeProbe({ which: { legion: ["/usr/bin/legion"] } }));
    const diag = byCode(shadowed)["path_shadowing"];
    assert.equal(diag?.status, "warn");
    assert.match(diag?.message ?? "", /\/usr\/bin\/legion/);
    assert.equal(shadowed.allPassed, true, "shadowing is a warning, never an error");

    const clean = await runDoctor(ws, fakeProbe({}));
    assert.equal(byCode(clean)["path_shadowing"], undefined);
    assert.equal(byCode(clean)["path_sibling"], undefined);
  });

  test("Docker checks come from the sandbox preflight: absent client warns with its FIX line; a full stack passes; no container is started", async () => {
    const absent = await runDoctor(ws, fakeProbe({}));
    const warn = byCode(absent)["docker_cli"];
    assert.equal(warn?.status, "warn");
    assert.match(warn?.fixHint ?? "", /^FIX: install Docker Desktop/);
    assert.match(warn?.message ?? "", /--allow-no-sandbox/);
    assert.equal(byCode(absent)["docker_image"], undefined, "later layers are not reported when an earlier one fails");
    const stopped = await runDoctor(ws, fakeProbe({ which: { docker: ["/usr/bin/docker"] } }));
    assert.equal(byCode(stopped)["docker_cli"]?.status, "pass");
    assert.equal(byCode(stopped)["docker_daemon"]?.status, "warn");
    assert.match(byCode(stopped)["docker_daemon"]?.fixHint ?? "", /start Docker Desktop/);

    const present = await runDoctor(
      ws,
      fakeProbe({
        which: { docker: ["C:\\Program Files\\Docker\\docker.exe"], claude: ["C:\\bin\\claude.exe"], codex: ["C:\\npm\\codex.cmd"] },
        run: {
          "docker version --format {{.Client.Version}}|{{.Server.Os}}|{{.Server.Version}}": "27.0.0|linux|27.0.0",
          "docker image inspect node:22-alpine --format {{.Id}}|{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}": "sha256:" + "a".repeat(64) + "|node@sha256:" + "a".repeat(64),
          "claude --version": "2.1.295 (Claude Code)",
          "codex --version": "codex-cli 0.162.0",
        },
      })
    );
    for (const id of ["docker_cli", "docker_daemon", "docker_linux_engine", "docker_image"]) assert.equal(byCode(present)[id]?.status, "pass", id);
    assert.match(byCode(present)["docker_image"]?.message ?? "", /node@sha256/);
    assert.equal(byCode(present)["adapter_claude"]?.status, "pass");
    assert.equal(byCode(present)["adapter_codex"]?.status, "pass");
    assert.equal(byCode(present)["agent_image"]?.status, "warn", "the agent image is not built on the scripted machine");
    assert.equal(byCode(absent)["adapter_claude"]?.status, "warn");
    assert.match(byCode(absent)["adapter_claude"]?.fixHint ?? "", /^FIX: npm install -g @anthropic-ai\/claude-code/);
    const shadowed = await runDoctor(ws, fakeProbe({ which: { codex: ["/usr/bin/codex"] }, run: { "codex --version": "not-codex 9.9" } }));
    assert.equal(byCode(shadowed)["adapter_codex"]?.status, "fail");
  });

  test("the floor constant matches engines.node in both manifests", async () => {
    for (const rel of ["../package.json", "../../../package.json"]) {
      const manifest = JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8")) as {
        engines?: { node?: string };
      };
      assert.equal(manifest.engines?.node, `>=${NODE_FLOOR}`, rel);
    }
  });

  test("compareVersions orders dotted versions numerically", () => {
    assert.equal(compareVersions("22.13.0", "22.13.0"), 0);
    assert.equal(compareVersions("22.12.99", "22.13.0"), -1);
    assert.equal(compareVersions("22.13", "22.13.0"), 0);
    assert.equal(compareVersions("24.0.0", "22.99.99"), 1);
    assert.equal(compareVersions("22.13.1", "22.13.0"), 1);
  });
});
