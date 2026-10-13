import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { extractWithServer, fakeLspServerPath } from "@9thlevelsoftware/legion-flow-lsp";
import { dockerSession, realDockerCli, resolveDockerSettings, type DockerCli } from "@9thlevelsoftware/legion-flow-sandbox";
import { initCommand, mapCommand, runDoctor, type SystemProbe } from "../dist/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function project(serverArgs: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-map-lsp-"));
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "lib", "util.fl"), "def helper\n");
  await writeFile(join(root, "lib", "main.fl"), "def main\nhelper\n");
  await writeFile(join(root, "lib", "x.ts"), "export const x = 1;\n");
  const ws = Workspace.at(root);
  const ctx = (isTTY = true) => ({ cwd: root, isTTY, workspace: ws });
  await initCommand(ctx(), { adapter: "fake", name: "Lsp", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.map = { languageServers: [{ language: "fake", extensions: [".fl"], command: process.execPath, args: [fakeLspServerPath(), "--progress", "--index-ms", "200", ...serverArgs], timeoutMs: 20_000 }] };
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  return { root, ws, ctx };
}

describe("M4 slice (a3): language servers through map", () => {
  test("the host escape on a terminal maps the fake language beside TypeScript; a rerun reuses it; who-uses answers across it", async () => {
    const { root, ctx } = await project();
    try {
      const built = ResultEnvelopeSchema.parse(await mapCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true }));
      assert.equal(built.status, "ok", JSON.stringify(built.diagnostics));
      assert.match(built.diagnostics.find((d) => d.code === "map_language")?.message ?? "", /Language 'fake' \(\.fl\): 2 module\(s\), fake-lsp 1\.0\.0, unhardened/);
      assert.match(built.diagnostics.find((d) => d.code === "map_built")?.message ?? "", /3 modules/);
      const again = await mapCommand(ctx(), { sandbox: "unhardened", allowNoSandbox: true });
      assert.match(again.diagnostics.find((d) => d.code === "map_language")?.message ?? "", /reused from the previous snapshot \(unchanged files and configuration; server version confirmed the same/);
      const who = await mapCommand(ctx(), { whoUses: "helper" });
      assert.deepEqual(who.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["used by lib/main.fl"]);
      const deps = await mapCommand(ctx(), { deps: "lib/main.fl" });
      assert.deepEqual(deps.diagnostics.filter((d) => d.code === "map_result").map((d) => d.message), ["1 lib/util.fl"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("refusals before any server starts: no image on the default tier, the host without consent, consent off a terminal; build flags with a query are usage errors", async () => {
    const { root, ctx } = await project();
    try {
      const noImage = await mapCommand(ctx(), {});
      assert.equal(noImage.status, "refused");
      assert.equal(noImage.diagnostics[0]?.code, "language_server_image_missing");
      assert.match(noImage.diagnostics[0]?.hint ?? "", /^FIX:/);
      assert.equal((await mapCommand(ctx(), { sandbox: "unhardened" })).diagnostics[0]?.code, "sandbox_not_hardened");
      assert.equal((await mapCommand(ctx(false), { sandbox: "unhardened", allowNoSandbox: true })).diagnostics[0]?.code, "sandbox_confirmation_requires_tty");
      assert.equal((await mapCommand(ctx(), { rebuild: true, deps: "lib/x.ts" })).status, "usage_error");
      assert.equal((await mapCommand(ctx(), { sandbox: "cloud" })).status, "usage_error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor names each configured server: no image is a warning with a FIX line", async () => {
    const { root, ws } = await project();
    try {
      const probe: SystemProbe = { nodeVersion: () => "24.0.0", which: async () => [], run: async () => null, sqlite: async () => ({ ok: true, sqliteVersion: "3" }), browser: async () => null };
      const item = (await runDoctor(ws, probe)).diagnostics.find((d) => d.code === "language_server_fake");
      assert.equal(item?.status, "warn");
      assert.match(item?.fixHint ?? "", /^FIX:/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the vm-docker session argv: -i, no network, read-only root fs, the tree read-only at /work, env by name only", async () => {
    const seen: string[][] = [];
    const scripted: DockerCli = {
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      open: (args) => {
        seen.push([...args]);
        return { stdin: new PassThrough(), stdout: new PassThrough(), stderrTail: () => "", exited: new Promise(() => {}), kill: async () => {}, argv: ["docker", ...args] };
      },
    };
    const settings = { ...resolveDockerSettings(undefined), image: "example/server:1" };
    const opened = await dockerSession(scripted, settings, "lf-lsp-test")({ command: "server", args: ["--stdio"], root: "/tmp/tree", env: { SECRET_NAME: "value" } });
    const argv = seen[0]!;
    assert.equal(opened.serverRoot, "/work");
    assert.deepEqual(argv.slice(0, 2), ["run", "-i"]);
    assert.equal(argv[argv.indexOf("--network") + 1], "none");
    assert.ok(argv.includes("--read-only"));
    assert.ok(argv.includes("/tmp/tree:/work:ro"));
    assert.ok(argv.includes("SECRET_NAME") && !argv.join(" ").includes("value"), "the variable travels by name; its value never enters the argv");
    assert.deepEqual(argv.slice(-3), ["example/server:1", "server", "--stdio"]);
  });
});

describe("a real docker run -i session, where Docker and the pinned image answer", async () => {
  const exec = promisify(execFile);
  const image = resolveDockerSettings(undefined).image;
  const present = await exec("docker", ["image", "inspect", image]).then(() => true, () => false);
  test("the fake server inside the hardened container: symbols and references come back through /work URIs", { skip: present ? undefined : `${image} is not present locally` }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-lsp-docker-"));
    const files: Record<string, string> = { "a.fl": "def helper\n", "b.fl": "helper\n" };
    for (const [p, body] of Object.entries(files)) await writeFile(join(root, p), body);
    const settings = resolveDockerSettings(undefined);
    const session = await dockerSession(realDockerCli, settings, `lf-lsp-test-${Date.now().toString(36)}`)({
      command: "node",
      args: ["/legion/lsp/fake-server.js", "--progress", "--index-ms", "200"],
      root,
      env: {},
      extraMounts: [{ host: dirname(fakeLspServerPath()), guest: "/legion/lsp", readonly: true }],
    });
    try {
      const r = await extractWithServer({ session, language: "fake", hostRoot: root, serverRoot: session.serverRoot, files: Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })), timeoutMs: 60_000, settleMs: 300 });
      assert.equal(r.partial, undefined, session.stderrTail());
      assert.deepEqual(r.usages.map((u) => `${u.declaredIn}#${u.symbol}<-${u.usedBy}`), ["a.fl#helper<-b.fl"]);
    } finally {
      await session.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("rust-analyzer through the real runner on the host tier, where it is installed", async () => {
  const exec = promisify(execFile);
  const which = async (b: string) => exec(process.platform === "win32" ? "where.exe" : "which", [b]).then((r) => r.stdout.split(/\r?\n/)[0]!.trim(), () => null);
  const ra = await which("rust-analyzer");
  const cargo = await which("cargo");
  test("languageServerRunner, hostSession, and the allowlisted environment: the cross-file usage comes back", { skip: ra && cargo ? undefined : "rust-analyzer and cargo are not both on PATH" }, async () => {
    const { languageServerRunner } = await import("../dist/lsp-runner.js");
    const root = await mkdtemp(join(tmpdir(), "legion-flow-ra-runner-"));
    const files: Record<string, string> = {
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/main.rs": "mod util;\n\nfn main() {\n    util::helper();\n}\n",
      "src/util.rs": "pub fn helper() {}\n",
    };
    for (const [p, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), body);
    }
    try {
      const runner = languageServerRunner({ tier: "unhardened", dockerSettings: resolveDockerSettings(undefined) });
      const t0 = Date.now();
      const r = await runner.run({ language: "rust", extensions: [".rs"], command: "rust-analyzer", initializationOptions: { checkOnSave: false, cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } }, timeoutMs: 180_000 }, {
        root,
        files: ["src/main.rs", "src/util.rs"].map((path) => ({ path, sha256: sha(files[path]!) })),
      });
      console.log(`# rust-analyzer through the runner: ${r.usages.length} usage(s), partial=${r.partial ?? "no"}, ${Date.now() - t0} ms`);
      assert.ok(r.usages.some((u) => u.declaredIn === "src/util.rs" && u.symbol === "helper" && u.usedBy === "src/main.rs"), JSON.stringify({ usages: r.usages, partial: r.partial }));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });
});
