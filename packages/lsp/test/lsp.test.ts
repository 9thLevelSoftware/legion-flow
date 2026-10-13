import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MapModuleSchema, MapSymbolSchema, MapImportSchema, MapUsageSchema } from "@9thlevelsoftware/legion-flow-schema";
import { extractWithServer, fakeLspServerPath, uriMapper, type LspStreams } from "../dist/index.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function startFake(flags: string[] = []): LspStreams & { kill: () => void } {
  const child = spawn(process.execPath, [fakeLspServerPath(), ...flags], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (c) => (err += c));
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return { stdin: child.stdin!, stdout: child.stdout!, exited, stderrTail: () => err, kill: () => child.kill() };
}

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-lsp-"));
  const list: { path: string; sha256: string }[] = [];
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), body);
    list.push({ path: p, sha256: sha(body) });
  }
  return { root, list };
}

const FILES = {
  "lib/util.fl": "def helper\ndef unused\n",
  "lib/core.fl": "def run\nhelper\n",
  "app/main.fl": "run\nhelper\nrun\n",
};

describe("LSP client against the fake server", () => {
  test("symbols, usages, and reference edges; Windows drive-style URIs map back; progress is waited for; output validates", async () => {
    const { root, list } = await fixture(FILES);
    const server = startFake(["--progress", "--index-ms", "400", "--drive-style", "--version", "9.9.9"]);
    try {
      const t0 = Date.now();
      const r = await extractWithServer({ session: server, language: "fake", hostRoot: root, serverRoot: root, files: list, settleMs: 200, timeoutMs: 20_000 });
      assert.ok(Date.now() - t0 >= 400, "queries waited for indexing to end");
      assert.equal(r.partial, undefined);
      assert.deepEqual(r.server, { name: "fake-lsp", version: "9.9.9" });
      for (const m of r.modules) MapModuleSchema.parse(m);
      for (const s of r.symbols) MapSymbolSchema.parse(s);
      for (const i of r.imports) MapImportSchema.parse(i);
      for (const u of r.usages) MapUsageSchema.parse(u);
      assert.deepEqual(r.modules.map((m) => `${m.path}:${m.lspLanguage}`), ["app/main.fl:fake", "lib/core.fl:fake", "lib/util.fl:fake"]);
      assert.deepEqual(r.symbols.map((s) => `${s.module}#${s.name}`), ["lib/core.fl#run", "lib/util.fl#helper", "lib/util.fl#unused"]);
      assert.deepEqual(r.usages.map((u) => `${u.declaredIn}#${u.symbol}<-${u.usedBy}`), ["lib/core.fl#run<-app/main.fl", "lib/util.fl#helper<-app/main.fl", "lib/util.fl#helper<-lib/core.fl"]);
      assert.deepEqual(r.imports.map((i) => `${i.from}>${i.resolved}:${i.kind}:${i.resolution}`), ["app/main.fl>lib/core.fl:reference:lsp", "app/main.fl>lib/util.fl:reference:lsp", "lib/core.fl>lib/util.fl:reference:lsp"]);
    } finally {
      server.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("deterministic: twice, and with the file list reversed, the same facts", async () => {
    const { root, list } = await fixture(FILES);
    try {
      const once = async (files: typeof list) => {
        const s = startFake();
        try {
          const r = await extractWithServer({ session: s, language: "fake", hostRoot: root, serverRoot: root, files, settleMs: 100 });
          return JSON.stringify([r.modules, r.symbols, r.imports, r.usages]);
        } finally {
          s.kill();
        }
      };
      const a = await once(list);
      assert.equal(await once(list), a);
      assert.equal(await once([...list].reverse()), a);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("cut short is said: progress that never ends, a crash mid-query, and the reference cap", async () => {
    const { root, list } = await fixture(FILES);
    try {
      const hang = startFake(["--hang"]);
      const hung = await extractWithServer({ session: hang, language: "fake", hostRoot: root, serverRoot: root, files: list, settleMs: 100, timeoutMs: 1500 });
      hang.kill();
      assert.match(hung.partial ?? "", /did not settle within 1500 ms/);
      assert.equal(hung.modules.length, 3, "the files are still known modules");

      const crash = startFake(["--crash-on-references"]);
      const crashed = await extractWithServer({ session: crash, language: "fake", hostRoot: root, serverRoot: root, files: list, settleMs: 100, timeoutMs: 10_000 });
      assert.match(crashed.partial ?? "", /exited|stopped answering/);

      const capped = startFake();
      const c = await extractWithServer({ session: capped, language: "fake", hostRoot: root, serverRoot: root, files: list, settleMs: 100, referenceCap: 1 });
      capped.kill();
      assert.deepEqual(c.capped, ["lib/util.fl"], "util.fl has two symbols; only one was asked about");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test("URI mapping: a container root is encoded by hand; a host root accepts either drive spelling", () => {
    const guest = uriMapper("/work", ["src/a b.rs"]);
    assert.equal(guest.toUri("src/a b.rs"), "file:///work/src/a%20b.rs");
    assert.equal(guest.fromUri("file:///work/src/a%20b.rs"), "src/a b.rs");
    assert.equal(guest.fromUri("file:///elsewhere/x.rs"), null);
    if (process.platform === "win32") {
      const host = uriMapper("D:\\proj", ["src/Main.rs"]);
      assert.equal(host.fromUri("file:///d%3A/proj/src/main.rs"), "src/Main.rs");
      assert.equal(host.fromUri("file:///D:/proj/src/Main.rs"), "src/Main.rs");
    }
  });
});

describe("a real server, where one is installed", async () => {
  const run = promisify(execFile);
  const which = async (b: string) => run(process.platform === "win32" ? "where.exe" : "which", [b]).then((r) => r.stdout.split(/\r?\n/)[0]!.trim(), () => null);
  const ra = await which("rust-analyzer");
  const cargo = await which("cargo");
  test("rust-analyzer on a two-file crate: the function in util.rs is used by main.rs (host tier)", { skip: ra && cargo ? undefined : "rust-analyzer and cargo are not both on PATH" }, async () => {
    const { root, list } = await fixture({
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/main.rs": "mod util;\n\nfn main() {\n    util::helper();\n}\n",
      "src/util.rs": "pub fn helper() {}\n\npub fn unused() {}\n",
    });
    const files = list.filter((f) => f.path.endsWith(".rs"));
    const child = spawn(ra!, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let err = "";
    child.stderr!.on("data", (c) => (err += c));
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
    const t0 = Date.now();
    try {
      // Option names from memory of rust-analyzer's configuration (checkOnSave, cargo.buildScripts.enable, procMacro.enable), not checked against its manual here; the server accepted them without a configuration error.
      const r = await extractWithServer({
        session: { stdin: child.stdin!, stdout: child.stdout!, exited, stderrTail: () => err },
        language: "rust",
        hostRoot: root,
        serverRoot: root,
        files,
        initializationOptions: { checkOnSave: false, cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } },
        timeoutMs: 180_000,
        settleMs: 3000,
      });
      console.log(`# rust-analyzer ${r.server?.version ?? "?"}: ${r.symbols.length} symbols, ${r.usages.length} usages, partial=${r.partial ?? "no"}, ${Date.now() - t0} ms`);
      assert.ok(r.symbols.some((s) => s.module === "src/util.rs" && s.name === "helper"), JSON.stringify(r.symbols));
      assert.ok(r.usages.some((u) => u.declaredIn === "src/util.rs" && u.symbol === "helper" && u.usedBy === "src/main.rs"), JSON.stringify(r.usages));
      assert.ok(r.imports.some((i) => i.from === "src/main.rs" && i.resolved === "src/util.rs" && i.resolution === "lsp"));
    } finally {
      child.kill();
      // Windows keeps the directory busy until the server process is really gone.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
    void readFileSync;
  });
});

describe("M4 slice (g): the server-version handshake", () => {
  test("initialize alone reports the name and version, no document is opened, and the version follows the server, not its config", async () => {
    const { serverInfoOf } = await import("../dist/index.js");
    const dir = await mkdtemp(join(tmpdir(), "legion-flow-lsp-ver-"));
    const versionFile = join(dir, "version.txt");
    try {
      await writeFile(versionFile, "1\n");
      const first = startFake(["--version-file", versionFile]);
      try {
        assert.deepEqual(await serverInfoOf({ session: first, serverRoot: dir, timeoutMs: 10_000 }), { name: "fake-lsp", version: "1" });
      } finally {
        first.kill();
      }
      await writeFile(versionFile, "2\n");
      const second = startFake(["--version-file", versionFile]);
      try {
        assert.deepEqual(await serverInfoOf({ session: second, serverRoot: dir, timeoutMs: 10_000 }), { name: "fake-lsp", version: "2" }, "same argv, upgraded server");
      } finally {
        second.kill();
      }
      await writeFile(versionFile, "none\n");
      const silent = startFake(["--version-file", versionFile]);
      try {
        assert.deepEqual(await serverInfoOf({ session: silent, serverRoot: dir, timeoutMs: 10_000 }), { name: "fake-lsp" }, "a server that names no version");
      } finally {
        silent.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
