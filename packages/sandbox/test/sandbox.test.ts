import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, access, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getLegionFlowPaths, fingerprintTree } from "@9thlevelsoftware/legion-flow-persist";
import {
  createMaterializer,
  enforcementReport,
  materializerFor,
  SANDBOX_TIERS,
  dockerPreflight,
  dockerCheapChecks,
  dockerExec,
  hostExec,
  expandArgv,
  mountMapper,
  hardeningArgs,
  runImage,
  resolveDockerSettings,
  realDockerCli,
  copyStrategy,
  worktreeStrategy,
  egressDistDir,
  type DockerCli,
  type DockerResult,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
const ok = (stdout: string): DockerResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const fail = (code: number, stderr: string): DockerResult => ({ code, signal: null, stdout: "", stderr, timedOut: false });

/** A docker client with scripted answers keyed by the first words of the argv. */
function scripted(answers: Record<string, DockerResult | ((args: readonly string[]) => DockerResult)>): DockerCli & { calls: string[][] } {
  const cli = {
    calls: [] as string[][],
    async run(args: readonly string[]) {
      cli.calls.push([...args]);
      const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
      if (!key) return fail(1, `unscripted: ${args.join(" ")}`);
      const a = answers[key]!;
      return typeof a === "function" ? a(args) : a;
    },
  };
  return cli;
}

const settings = resolveDockerSettings(undefined, "win32");
const adaptersDir = resolve(import.meta.dirname ?? ".", "..", "..", "adapters", "dist");

describe("sandbox tiers at slice (b): catalog, report, flags, mapper", () => {
  test("unhardened and vm-docker are available; the reports say what each enforces", () => {
    assert.deepEqual(SANDBOX_TIERS.filter((t) => t.available).map((t) => t.id), ["unhardened", "vm-docker"]);
    const plain = enforcementReport("unhardened");
    assert.equal(plain.isSandbox, false);
    assert.ok(plain.caveats.includes("this is not a sandbox"));
    const docker = enforcementReport("vm-docker", settings);
    assert.equal(docker.networkEnforced, true);
    assert.equal(docker.credentialsOutsideAgent, true);
    assert.equal(docker.docker?.user, "1000:1000");
    assert.ok(docker.caveats.some((c) => c.includes("Docker Desktop is itself a Linux VM")));
    assert.equal(enforcementReport("jail-bwrap").notEnforced[0], "this tier is not available in this build");
    assert.equal(materializerFor("vm-docker", getLegionFlowPaths("x")), null, "the slice (a) helper still only knows the host tier");
  });

  test("settings resolve defaults by platform and honor project overrides; the hardening set is exact", () => {
    assert.equal(resolveDockerSettings(undefined, "win32").image, "node:22-alpine");
    assert.equal(resolveDockerSettings({ docker: { image: "x:1", memory: "4g", user: "2:2" } }, "linux").user, "2:2");
    const args = hardeningArgs(settings, "lf-run_x");
    assert.deepEqual(args.slice(0, 6), ["run", "--pull", "never", "--rm", "--name", "lf-run_x"], "nothing is ever pulled");
    assert.deepEqual(hardeningArgs(settings, "lf-proxy-x", { keep: true, detach: true, network: "lf-net-x" }).slice(0, 8), ["run", "--pull", "never", "-d", "--name", "lf-proxy-x", "--network", "lf-net-x"], "the proxy keeps its container for logs");
    assert.equal(runImage(settings), "node:22-alpine");
    assert.equal(runImage({ ...settings, imageId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    for (const flag of ["--network", "--read-only", "--cap-drop", "--security-opt", "--init", "--tmpfs", "--user", "--pids-limit", "--memory", "--cpus"]) {
      assert.ok(args.includes(flag), `${flag} missing`);
    }
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  });

  test("the mount mapper translates by the longest matching mount and refuses an unmounted path", () => {
    const map = mountMapper([
      { host: "D:\\ws\\.legion-flow\\var\\sandbox\\run_1\\tree", guest: "/work" },
      { host: "D:\\ws\\.legion-flow\\var\\cache\\runs\\run_1", guest: "/legion/run" },
    ]);
    assert.equal(map("D:\\ws\\.legion-flow\\var\\sandbox\\run_1\\tree"), "/work");
    assert.equal(map("D:\\ws\\.legion-flow\\var\\sandbox\\run_1\\tree\\src\\a.ts"), "/work/src/a.ts");
    assert.equal(map("D:\\ws\\.legion-flow\\var\\cache\\runs\\run_1\\prompt.md"), "/legion/run/prompt.md");
    assert.throws(() => map("D:\\elsewhere\\x"), /not under any mount/);
  });
});

describe("image pinning (preflight resolves a local Id; every container runs by it)", () => {
  const id = "sha256:" + "c".repeat(64);

  test("the probe runs by the resolved Id; a locally built image without a RepoDigest records its Id as the identity; an unreadable Id fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-pin-probe-"));
    const writeThroughMount = (args: readonly string[]) => {
      const mount = args.find((a) => a.endsWith(":/work"))!;
      writeFileSync(join(mount.slice(0, -":/work".length), "probe.txt"), "probe-ok\n");
      return ok("1000");
    };
    const cli = scripted({ version: ok("27.0|linux|27.0"), "image inspect": ok(id + "|"), "rm -f": ok(""), "ps -a": ok(""), "network ls": ok(""), run: writeThroughMount });
    const report = await dockerPreflight({ settings: { ...settings, image: "local-built:1" }, paths: getLegionFlowPaths(root), adaptersDir, probe: true, docker: cli }).finally(() => rm(root, { recursive: true, force: true }));
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(report.imageId, id);
    assert.equal(report.imageDigest, id, "no RepoDigest: the Id is the identity");
    const probe = cli.calls.find((c) => c[0] === "run")!;
    assert.ok(probe.includes(id) && !probe.includes("local-built:1"), "the probe proves the exact image that will run");
    assert.deepEqual(probe.slice(1, 3), ["--pull", "never"]);

    const garbled = await dockerCheapChecks({ settings, docker: scripted({ version: ok("27.0|linux|27.0"), "image inspect": ok("node@sha256:" + "a".repeat(64)) }) });
    assert.equal(garbled.checks.at(-1)?.status, "fail");
    assert.equal(garbled.imageId, undefined);
    assert.match(garbled.checks.at(-1)?.fix ?? "", /^FIX: /);
  });

  test("the agent and the egress proxy both run by the pinned Id, and a vanished image is a named spawn error, never a pull", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-pin-"));
    try {
      const runDir = join(getLegionFlowPaths(root).cacheRunsDir, "run_p");
      await mkdir(runDir, { recursive: true });
      const pinned = { ...settings, imageId: id };
      const cli = scripted({
        "rm -f": ok(""), "network rm": ok(""), "network create": ok("netid"), "network connect": ok(""),
        run: (args) => {
          if (args.includes("-d")) { void writeFile(join(runDir, "egress-ready"), "now\n"); return ok("proxyid"); }
          return fail(125, "docker: Error response from daemon: No such image: " + id);
        },
      });
      const exec = dockerExec(cli, pinned, "run_p", { routes: [{ alias: "up", host: "api.example.com", scheme: "https", secrets: [] }], runDirFor: () => runDir, egressDistDir: "D:\\egress\\dist", secrets: {}, now: () => new Date("2026-10-12T12:00:00.000Z") });
      const outcome = await exec({ command: "node", args: () => ["x.js"], cwd: () => "/work", mounts: [], env: {}, timeoutMs: 1000, signal: new AbortController().signal });
      const runs = cli.calls.filter((c) => c[0] === "run");
      assert.equal(runs.length, 2, "proxy and agent");
      for (const r of runs) assert.ok(r.includes(id) && !r.includes("node:22-alpine"), "both run by the Id: " + r.join(" "));
      assert.equal(outcome.exitCode, 125);
      assert.match(outcome.spawnError ?? "", /no longer present; it is never pulled/);
      assert.ok(outcome.spawnError!.includes("node:22-alpine") && outcome.spawnError!.includes(id), "names the tag and the Id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("docker preflight against a scripted client", () => {
  const paths = getLegionFlowPaths("x");
  const probeInput = { settings, paths, adaptersDir, probe: false };

  test("each failure names its FIX line and stops at the first missing layer", async () => {
    const noCli = await dockerPreflight({ ...probeInput, docker: scripted({ version: { code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" } }) });
    assert.equal(noCli.ok, false);
    assert.equal(noCli.checks.at(-1)?.id, "docker_cli");
    assert.match(noCli.checks.at(-1)?.fix ?? "", /^FIX: install Docker Desktop/);

    const noDaemon = await dockerPreflight({ ...probeInput, docker: scripted({ version: fail(1, "error during connect: pipe not found") }) });
    assert.equal(noDaemon.checks.at(-1)?.id, "docker_daemon");
    assert.match(noDaemon.checks.at(-1)?.fix ?? "", /start Docker Desktop/);

    const windows = await dockerPreflight({ ...probeInput, docker: scripted({ version: ok("27.0|windows|27.0") }) });
    assert.equal(windows.checks.at(-1)?.id, "docker_linux_engine");

    const noImage = await dockerPreflight({ ...probeInput, docker: scripted({ version: ok("27.0|linux|27.0"), "image inspect": fail(1, "No such image") }) });
    assert.equal(noImage.checks.at(-1)?.id, "docker_image");
    assert.equal(noImage.checks.at(-1)?.fix, "FIX: docker pull node:22-alpine");
  });

  test("the cheap checks pass without a container; the probe records uid and digest; env travels as names only", async () => {
    const cli = scripted({
      version: ok("27.0|linux|27.0"),
      "image inspect": ok("sha256:" + "a".repeat(64) + "|node@sha256:" + "a".repeat(64)),
      "rm -f": ok(""),
      run: (args) => (args.includes("-e") ? ok("") : ok("1000")),
    });
    const cheap = await dockerCheapChecks({ docker: cli, settings });
    assert.ok(cheap.checks.every((c) => c.status === "pass"));
    assert.equal(cheap.imageDigest, "node@sha256:" + "a".repeat(64));
    assert.equal(cheap.imageId, "sha256:" + "a".repeat(64));
    assert.equal(cli.calls.some((c) => c[0] === "run"), false, "no container for the cheap checks");

    const exec = dockerExec(cli, settings, "run_x");
    const controller = new AbortController();
    const outcome = await exec({
      command: "node",
      args: (map) => [map("D:\\ws\\tree\\script.js")],
      cwd: (map) => map("D:\\ws\\tree"),
      mounts: [{ host: "D:\\ws\\tree", guest: "/work" }, { host: "D:\\ws\\adapters", guest: "/legion/adapters", readonly: true }],
      env: { DO_NOT_TRACK: "1", SECRET_VALUE: "do-not-record" },
      timeoutMs: 1000,
      signal: controller.signal,
    });
    assert.equal(outcome.exitCode, 0);
    const argv = outcome.argv!;
    assert.equal(argv[0], "docker");
    assert.ok(argv.includes("-v") && argv.includes("D:\\ws\\adapters:/legion/adapters:ro"));
    assert.ok(argv.includes("-e") && argv.includes("SECRET_VALUE"));
    assert.equal(argv.some((a) => a.includes("do-not-record")), false, "values never enter the recorded argv");
    assert.deepEqual(argv.slice(-3), ["node:22-alpine", "node", "/work/script.js"]);
    assert.equal(argv[argv.indexOf("-w") + 1], "/work");
  });

  test("with routes, the exec creates an internal network, starts the proxy with secret names only, joins the agent to the network, and tears both down", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-egress-scripted-"));
    try {
      const paths = getLegionFlowPaths(root);
      const runDir = join(paths.cacheRunsDir, "run_e");
      await mkdir(runDir, { recursive: true });
      const cli = scripted({
        "rm -f": ok(""),
        "network rm": ok(""),
        "network create": ok("netid"),
        "network connect": ok(""),
        run: (args) => {
          if (args.includes("-d")) {
            // the proxy container writes its ready file once listening; the scripted one does it on start
            void writeFile(join(runDir, "egress-ready"), "now\n");
            return ok("proxyid");
          }
          return ok("agent-done");
        },
      });
      const exec = dockerExec(cli, settings, "run_e", {
        routes: [{ alias: "up", host: "api.example.com", scheme: "https", secrets: [{ header: "authorization", ref: "env:LF_KEY" }] }],
        runDirFor: () => runDir,
        egressDistDir: "D:\\egress\\dist",
        secrets: { LF_KEY: "real-value" },
        now: () => new Date("2026-10-08T12:00:00.000Z"),
      });
      const outcome = await exec({
        command: "node",
        args: () => ["-e", "0"],
        cwd: (map) => map(root),
        mounts: [{ host: root, guest: "/work" }],
        env: { DO_NOT_TRACK: "1", ANTHROPIC_API_KEY: "real-key-by-name" },
        constants: { HOME: "/home/node" },
        baseUrl: { envName: "ANTHROPIC_BASE_URL", alias: "anthropic" },
        timeoutMs: 1000,
        signal: new AbortController().signal,
      });
      assert.equal(outcome.egress?.shape, "proxy");
      const calls = cli.calls.map((c) => c.join(" "));
      assert.ok(calls.some((c) => c.startsWith("network create --internal") && c.includes("lf-net-run_e")));
      const proxyRun = cli.calls.find((c) => c[0] === "run" && c.includes("-d"))!;
      assert.ok(proxyRun.includes("lf-proxy-run_e") && proxyRun.includes("lf-net-run_e"));
      assert.ok(proxyRun.includes("-e") && proxyRun.includes("LF_KEY"), "the secret travels as a name");
      assert.equal(proxyRun.some((a) => a.includes("real-value")), false);
      assert.ok(proxyRun.includes("D:\\egress\\dist:/legion/egress:ro"));
      assert.ok(calls.some((c) => c === "network connect lf-out-run_e lf-proxy-run_e"), "the proxy joins a per-run outbound network, never the shared bridge");
      assert.ok(calls.some((c) => c.startsWith("network create ") && !c.includes("--internal") && c.includes("lf-out-run_e")));
      assert.ok(proxyRun.includes("host.docker.internal:host-gateway"));
      const agentRun = cli.calls.find((c) => c[0] === "run" && !c.includes("-d"))!;
      assert.equal(agentRun[agentRun.indexOf("--network") + 1], "lf-net-run_e");
      assert.ok(agentRun.includes("LF_EGRESS_URL"), "the agent learns the proxy address by name");
      assert.ok(agentRun.includes("ANTHROPIC_BASE_URL=http://lf-proxy-run_e:8080/anthropic"), "the tier fills the base URL from the proxy route, inline");
      assert.ok(agentRun.includes("HOME=/home/node"), "declared constants are inline");
      assert.ok(agentRun.includes("ANTHROPIC_API_KEY") && !agentRun.some((a) => a.includes("real-key-by-name")), "secrets travel by name only");
      assert.ok(agentRun.includes("--tmpfs") && agentRun.some((a) => a.startsWith("/home/node:")), "the home tmpfs is part of the hardening set");
      assert.equal(JSON.parse(await readFile(join(runDir, "egress-routes.json"), "utf8"))[0].alias, "up");
      const agentIdx = calls.findIndex((c) => c.startsWith("run ") && !c.includes(" -d "));
      assert.ok(calls.lastIndexOf("rm -f lf-proxy-run_e") > agentIdx, "the proxy is removed after the agent");
      assert.ok(calls.lastIndexOf("network rm lf-net-run_e") > agentIdx, "the network is removed after the agent");
      assert.ok(calls.lastIndexOf("network rm lf-out-run_e") > agentIdx, "the outbound network is removed too");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tree strategies", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "legion-flow-strategy-"));
    await git(repo, "init", "-q", "-b", "main");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), "dist/\n");
    await writeFile(join(repo, "src", "a.ts"), "a\n");
    await writeFile(join(repo, "src", "old.ts"), "old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "init");
    await writeFile(join(repo, "src", "a.ts"), "a modified\n");
    await writeFile(join(repo, "src", "new.ts"), "new\n");
    await rm(join(repo, "src", "old.ts"));
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, "dist", "a.js"), "ignored\n");
    await mkdir(join(repo, ".legion-flow", "var"), { recursive: true });
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("copy and worktree fingerprint identically to the checkout in git mode, with the working-tree changes overlaid and ignored files absent", async () => {
    const paths = getLegionFlowPaths(repo);
    const source = await fingerprintTree(repo, { mode: "git" });
    const copy = copyStrategy(paths);
    const c = await copy.materialize({ runId: "run_c", sourceRoot: repo, sourceMode: "git" });
    assert.equal((await fingerprintTree(c.treeDir, { mode: "fs" })).fingerprint, source.fingerprint);
    await copy.dispose(c.treeDir);
    await assert.rejects(access(join(paths.sandboxDir, "run_c")));

    const wt = worktreeStrategy(paths);
    const w = await wt.materialize({ runId: "run_w", sourceRoot: repo, sourceMode: "git" });
    const wtFiles = await fingerprintTree(w.treeDir, { mode: "fs" });
    assert.equal(wtFiles.fingerprint, source.fingerprint);
    assert.equal(await readFile(join(w.treeDir, "src", "a.ts"), "utf8"), "a modified\n");
    assert.ok(!("src/old.ts" in wtFiles.files), "deleted in the working tree, deleted in the worktree");
    assert.ok(!("dist/a.js" in wtFiles.files), "ignored files never enter the tree");
    await wt.dispose(w.treeDir);
    await assert.rejects(access(w.treeDir));
    await assert.rejects(wt.materialize({ runId: "run_x", sourceRoot: repo, sourceMode: "fs" }), /worktree_requires_git/);
  });
});

describe("real Docker (skipped when the daemon or the image is absent)", async () => {
  const cheap = await dockerCheapChecks({ docker: realDockerCli, settings: resolveDockerSettings(undefined) }).catch(() => null);
  const available = cheap?.checks.every((c) => c.status === "pass") ?? false;
  const reason = available ? undefined : `docker not usable here: ${cheap?.checks.find((c) => c.status !== "pass")?.message ?? "client failed"}`;

  test("preflight with the probe passes and the fake agent edits the mounted tree from inside a hardened container; a timeout kills the container", { skip: reason }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-docker-"));
    try {
      await mkdir(join(root, ".legion-flow", "var"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "a\n");
      const paths = getLegionFlowPaths(root);
      const s = resolveDockerSettings(undefined);
      const report = await dockerPreflight({ docker: realDockerCli, settings: s, paths, adaptersDir, probe: true });
      assert.equal(report.ok, true, JSON.stringify(report.checks));
      assert.match(report.probeUid ?? "", /^\d+$/);
      assert.match(report.imageDigest ?? "", /^node@sha256:/);

      const m = createMaterializer({ tier: "vm-docker", strategy: "copy", paths, runId: "run_d", settings: s, docker: realDockerCli })!;
      const { treeDir } = await m.materialize({ runId: "run_d", sourceRoot: root, sourceMode: "fs" });
      const runDir = join(paths.cacheRunsDir, "run_d");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "prompt.md"), "# p\n");
      await writeFile(join(runDir, "brief.json"), JSON.stringify({ filesAllowed: ["src/a.ts"], expectedArtifacts: ["gen/out.txt"] }));
      const outcome = await m.exec({
        command: "node",
        args: (map) => [map(join(adaptersDir, "fake-agent.js")), map(join(runDir, "prompt.md")), map(treeDir), "-"],
        cwd: (map) => map(treeDir),
        mounts: [{ host: treeDir, guest: "/work" }, { host: runDir, guest: "/legion/run" }, { host: adaptersDir, guest: "/legion/adapters", readonly: true }],
        env: { DO_NOT_TRACK: "1" },
        timeoutMs: 120_000,
        signal: new AbortController().signal,
      });
      assert.equal(outcome.exitCode, 0, outcome.stderrTail);
      assert.match(await readFile(join(treeDir, "src", "a.ts"), "utf8"), /fake adapter touched/);
      assert.match(await readFile(join(treeDir, "gen", "out.txt"), "utf8"), /created by/);
      assert.match(await readFile(join(runDir, "summary.md"), "utf8"), /Touched 2/);

      const slow = await m.exec({
        command: "node",
        args: () => ["-e", "setTimeout(()=>{}, 60000)"],
        cwd: (map) => map(treeDir),
        mounts: [{ host: treeDir, guest: "/work" }],
        env: {},
        timeoutMs: 3000,
        signal: new AbortController().signal,
      });
      assert.equal(slow.timedOut, true);
      const left = await realDockerCli.run(["ps", "-a", "--filter", "name=lf-run_d", "--format", "{{.Names}}"]);
      assert.equal(left.stdout.trim(), "", "the container was killed and removed");
      await m.dispose(treeDir);

      // Egress: a host-side upstream records what arrives; the agent reaches it only through the proxy, with the real key set there.
      const seen: { url: string; authorization: string | undefined }[] = [];
      const upstream = createServer((req, res) => {
        seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream-ok");
      });
      await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
      const upstreamPort = (upstream.address() as AddressInfo).port;
      try {
        const me = createMaterializer({
          tier: "vm-docker",
          strategy: "copy",
          paths,
          runId: "run_e",
          settings: s,
          docker: realDockerCli,
          routes: [{ alias: "up", host: "host.docker.internal", port: upstreamPort, scheme: "http", secrets: [{ header: "authorization", ref: "env:LF_TEST_EGRESS_KEY" }] }],
          egressDistDir: egressDistDir(),
          secrets: { LF_TEST_EGRESS_KEY: "Bearer the-real-key" },
        })!;
        const tree2 = await me.materialize({ runId: "run_e", sourceRoot: root, sourceMode: "fs" });
        const agentRunDir = join(paths.cacheRunsDir, "run_e");
        await mkdir(agentRunDir, { recursive: true });
        const script = [
          'const get = (u) => fetch(u, { signal: AbortSignal.timeout(5000) }).then(async (r) => r.status + " " + (await r.text()).slice(0, 40)).catch((e) => "error " + e.name);',
          "(async () => {",
          '  console.log("via-proxy:", await get(process.env.LF_EGRESS_URL + "/up/hello?secret=no"));',
          '  console.log("denied:", await get(process.env.LF_EGRESS_URL + "/elsewhere/x"));',
          '  require("fs").writeFileSync("/legion/run/egress.jsonl", "tampered\\n"); console.log("tamper: wrote into my own run dir");',
          `  console.log("direct:", await get("http://host.docker.internal:${upstreamPort}/direct"));`,
          "})();",
        ].join("\n");
        const out = await me.exec({
          command: "node",
          args: () => ["-e", script],
          cwd: (map) => map(tree2.treeDir),
          mounts: [{ host: tree2.treeDir, guest: "/work" }, { host: agentRunDir, guest: "/legion/run" }],
          env: { DO_NOT_TRACK: "1", LF_TEST_EGRESS_KEY: "placeholder" },
          timeoutMs: 120_000,
          signal: new AbortController().signal,
        });
        assert.equal(out.exitCode, 0, out.stderrTail);
        assert.match(out.stdoutTail, /via-proxy: 200 upstream-ok/);
        assert.match(out.stdoutTail, /denied: 403/);
        assert.match(out.stdoutTail, /direct: error (TimeoutError|TypeError)/, "the agent cannot reach the host directly");
        assert.equal(seen.length, 1, "only the proxied request reached the upstream");
        assert.equal(seen[0]!.url, "/hello?secret=no");
        assert.equal(seen[0]!.authorization, "Bearer the-real-key", "the real key was set by the proxy, replacing the agent's placeholder");
        assert.equal(out.egress?.shape, "proxy");
        if (out.egress?.shape !== "proxy") return;
        assert.equal(out.egress.summary?.requests, 2, "the agent's write into its own run dir did not touch the proxy's log");
        assert.equal(out.egress.summary?.denied, 1);
        assert.equal(await readFile(join(agentRunDir, "egress.jsonl"), "utf8"), "tampered\n", "the agent wrote where it can, which is not where the proxy logs");
        assert.ok((await readFile(join(paths.varDir, "egress", "run_e", "egress.jsonl"), "utf8")).split("\n").filter(Boolean).length === 2);
        assert.deepEqual(out.egress.summary?.hosts, ["host.docker.internal"]);
        assert.ok(out.egress.proxyArgv.includes("LF_TEST_EGRESS_KEY") && !out.egress.proxyArgv.some((a) => a.includes("the-real-key")));
        const leftovers = await realDockerCli.run(["ps", "-a", "--filter", "label=legion-flow.run=run_e", "--format", "{{.Names}}"]);
        assert.equal(leftovers.stdout.trim(), "", "proxy removed");
        const nets = await realDockerCli.run(["network", "ls", "--filter", "label=legion-flow.run=run_e", "--format", "{{.Name}}"]);
        assert.equal(nets.stdout.trim(), "", "both networks removed");
        await me.dispose(tree2.treeDir);
      } finally {
        upstream.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (j1): the per-spawn sandbox check", () => {
  test("the policy refuses the host tier for every kind; a member that requires a sandbox is never delegated to an unhardened run; a hardened run is allowed and recorded", async () => {
    const { spawnAllowed } = await import("../dist/index.js");
    for (const kind of ["adapter", "reviewer", "language_server", "mcp_server"] as const) {
      const r = spawnAllowed({ kind, tier: "unhardened", hardened: false, require: true });
      assert.equal(r.ok ? "ok" : r.code, "sandbox_required_by_policy", kind);
    }
    const delegated = spawnAllowed({ kind: "adapter", tier: "unhardened", hardened: false, member: { id: "db", sandbox: "require" } });
    assert.equal(delegated.ok ? "ok" : delegated.code, "delegation_rejected");
    assert.deepEqual(spawnAllowed({ kind: "adapter", tier: "vm-docker", hardened: true, require: true, member: { id: "db", sandbox: "require" } }), { ok: true, record: { kind: "adapter", tier: "vm-docker", require: true, member: "db", verdict: "allowed" } });
    assert.equal(spawnAllowed({ kind: "adapter", tier: "unhardened", hardened: false }).ok, true, "without the policy the host tier stays an operator's choice");
  });
});

describe("M4 slice (q): argument expansion from declared constants", () => {
  const spec = (root: string, extra: Record<string, unknown> = {}) => ({
    command: "node",
    args: () => ["-c", "mcp_servers.legion.url=${LF_TOOLS_URL}"],
    cwd: (map: (p: string) => string) => map(root),
    mounts: [{ host: root, guest: "/work" }],
    // A value in env is never used for expansion: env may hold secrets.
    env: { LF_TOOLS_URL: "http://from-env-must-not-be-used/" },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    expandArgs: true,
    ...extra,
  });

  test("expandArgv fills only names it was given and reports the rest", () => {
    assert.deepEqual(expandArgv(["a=${X}", "${Y}"], { X: "1", Y: "2" }), { ok: true, args: ["a=1", "2"] });
    assert.deepEqual(expandArgv(["a=${X}", "${Z}"], { X: "1" }), { ok: false, missing: ["Z"] });
    assert.deepEqual(expandArgv(["plain"], {}), { ok: true, args: ["plain"] });
  });

  test("vm-docker: the tool gateway route fills LF_TOOLS_URL into the argument; with no route nothing runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-expand-"));
    const runDir = join(root, "egress");
    try {
      const cli = scripted({
        "rm -f": ok(""),
        "network rm": ok(""),
        "network create": ok("netid"),
        "network connect": ok(""),
        run: (args) => {
          if (args.includes("-d")) {
            void writeFile(join(runDir, "egress-ready"), "now\n");
            return ok("proxyid");
          }
          return ok("agent-done");
        },
      });
      const exec = dockerExec(cli, settings, "run_q", { routes: [{ alias: "legion-tools", host: "host.docker.internal", port: 4567, scheme: "http", secrets: [] }], runDirFor: () => runDir, egressDistDir: "D:\\egress\\dist" });
      await exec(spec(root) as never);
      const agentRun = cli.calls.find((c) => c[0] === "run" && !c.includes("-d"))!;
      assert.ok(agentRun.includes("mcp_servers.legion.url=http://lf-proxy-run_q:8080/legion-tools/mcp"), agentRun.join(" "));
      assert.ok(!agentRun.join(" ").includes("from-env-must-not-be-used"));

      const bare = scripted({ "rm -f": ok(""), run: ok("agent-done") });
      const refused = await dockerExec(bare, settings, "run_r")(spec(root) as never);
      assert.match(refused.spawnError ?? "", /\$\{LF_TOOLS_URL\}, which this tier did not set; nothing ran/);
      assert.equal(bare.calls.filter((c) => c[0] === "run").length, 0, "no container started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host: an unresolved name refuses before anything spawns; a declared constant is filled", async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-expand-host-"));
    try {
      const refused = await hostExec(spec(root) as never);
      assert.match(refused.spawnError ?? "", /did not set; nothing ran/);
      const filled = await hostExec(spec(root, { command: process.execPath, args: () => ["-e", "process.stdout.write(process.argv[1])", "${GREETING}"], constants: { GREETING: "hello-constant" } }) as never);
      assert.equal(filled.exitCode, 0, filled.stderrTail);
      assert.equal(filled.stdoutTail, "hello-constant");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
