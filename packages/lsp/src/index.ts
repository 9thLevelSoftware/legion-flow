/**
 * Turn a running language server into map facts: modules for the files it
 * covers, their top-level symbols, and, from references, symbol usages and
 * module-to-module edges (resolution `lsp`, kind `reference`). Deterministic
 * for one server version and one tree: files and symbols are visited in sorted
 * order and every result is sorted and deduplicated. Anything cut short (a
 * timeout, a reference cap, a crash) is said, never silently dropped.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { MapImport, MapModule, MapSymbol, MapUsage } from "@9thlevelsoftware/legion-flow-schema";
import { Connection, RpcError } from "./jsonrpc.js";

export { Connection, RpcError } from "./jsonrpc.js";

export interface LspStreams {
  stdin: Writable;
  stdout: Readable;
  /** Resolves when the server process ends. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail?: () => string;
}

export interface LspExtractOptions {
  session: LspStreams;
  language: string;
  languageId?: string;
  /** Where the files are read on this machine. */
  hostRoot: string;
  /** The root as the server sees it: the same host path, or a guest path such as /work under Docker. */
  serverRoot: string;
  files: readonly { path: string; sha256: string }[];
  initializationOptions?: Record<string, unknown>;
  timeoutMs?: number;
  referenceCap?: number;
  /** Quiet period with no open progress before querying. */
  settleMs?: number;
}

export interface LspExtraction {
  modules: MapModule[];
  symbols: MapSymbol[];
  imports: MapImport[];
  usages: MapUsage[];
  /** Files whose references were cut at the cap. */
  capped: string[];
  partial?: string;
  server?: { name: string; version?: string };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** LSP SymbolKind to the map's symbol kinds; values that are not declarations are left out. */
const KIND: Record<number, MapSymbol["kind"]> = { 2: "namespace", 3: "namespace", 4: "namespace", 5: "class", 6: "function", 9: "function", 10: "enum", 11: "interface", 12: "function", 13: "var", 14: "const", 23: "class", 26: "type", 7: "var", 8: "var" };

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
interface DocumentSymbol { name: string; kind: number; range: Range; selectionRange: Range }
interface SymbolInformation { name: string; kind: number; location: { uri: string; range: Range }; containerName?: string }
interface Location { uri: string; range: Range }

/** URIs both ways. A posix server root (a container) is encoded by hand; a host root goes through the URL helpers, so `file:///d%3A/...` and `file:///D:/...` compare equal. */
export function uriMapper(serverRoot: string, knownPaths: readonly string[]) {
  const posixRoot = serverRoot.startsWith("/");
  const byLower = new Map(knownPaths.map((p) => [p.toLowerCase(), p]));
  const toUri = (rel: string): string =>
    posixRoot ? "file://" + posix.join(serverRoot, rel).split("/").map((s) => encodeURIComponent(s)).join("/") : pathToFileURL(join(serverRoot, ...rel.split("/"))).href;
  const fromUri = (uri: string): string | null => {
    let rel: string;
    try {
      if (posixRoot) {
        const p = decodeURIComponent(new URL(uri).pathname);
        if (!p.startsWith(serverRoot.replace(/\/+$/, "") + "/")) return null;
        rel = p.slice(serverRoot.replace(/\/+$/, "").length + 1);
      } else {
        const abs = resolve(fileURLToPath(uri));
        rel = relative(resolve(serverRoot), abs).split(sep).join("/");
        if (rel.startsWith("..") || /^[a-zA-Z]:/.test(rel)) return null;
      }
    } catch {
      return null;
    }
    // Case on Windows is not identity: map back to the spelling the tree listing used.
    return byLower.get(rel.toLowerCase()) ?? null;
  };
  return { toUri, fromUri };
}

export async function extractWithServer(o: LspExtractOptions): Promise<LspExtraction> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const referenceCap = o.referenceCap ?? 200;
  const settleMs = o.settleMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const files = [...o.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const paths = files.map((f) => f.path);
  const { toUri, fromUri } = uriMapper(o.serverRoot, paths);
  const out: LspExtraction = {
    modules: files.map((f) => ({ id: sha(`module\0${f.path}`), path: f.path, sha256: f.sha256, language: "lsp", lspLanguage: o.language })),
    symbols: [],
    imports: [],
    usages: [],
    capped: [],
  };

  const openTokens = new Set<string | number>();
  let lastActivity = Date.now();
  const conn = new Connection(
    o.session.stdout,
    o.session.stdin,
    (method, params) => {
      lastActivity = Date.now();
      switch (method) {
        case "window/workDoneProgress/create":
        case "client/registerCapability":
        case "client/unregisterCapability":
        case "window/showMessageRequest":
        case "window/showDocument":
          return null;
        case "workspace/configuration":
          return ((params as { items?: unknown[] })?.items ?? []).map(() => null);
        case "workspace/workspaceFolders":
          return [{ uri: toUri(""), name: "workspace" }];
        default:
          return { error: { code: -32601, message: `method not found: ${method}` } };
      }
    },
    (method, params) => {
      lastActivity = Date.now();
      if (method !== "$/progress") return;
      const p = params as { token: string | number; value?: { kind?: string } };
      if (p.value?.kind === "begin") openTokens.add(p.token);
      if (p.value?.kind === "end") openTokens.delete(p.token);
    }
  );
  let exitedEarly: string | null = null;
  void o.session.exited.then((e) => {
    exitedEarly = `the server exited (code ${e.code}${e.signal ? `, signal ${e.signal}` : ""})${o.session.stderrTail ? `: ${o.session.stderrTail().slice(-300)}` : ""}`;
    conn.close(exitedEarly);
  });

  const init = (await conn.request(
    "initialize",
    {
      processId: null,
      clientInfo: { name: "legion-flow", version: "1" },
      rootUri: toUri(""),
      workspaceFolders: [{ uri: toUri(""), name: "workspace" }],
      capabilities: {
        window: { workDoneProgress: true },
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, references: {}, synchronization: {} },
      },
      ...(o.initializationOptions ? { initializationOptions: o.initializationOptions } : {}),
    },
    remaining()
  )) as { serverInfo?: { name: string; version?: string } } | null;
  if (init?.serverInfo?.name) out.server = { name: init.serverInfo.name, ...(init.serverInfo.version ? { version: init.serverInfo.version } : {}) };
  conn.notify("initialized", {});

  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(o.hostRoot, ...f.path.split("/")), "utf8");
    } catch {
      continue;
    }
    conn.notify("textDocument/didOpen", { textDocument: { uri: toUri(f.path), languageId: o.languageId ?? o.language, version: 1, text } });
  }

  // Indexing is asynchronous: wait until no progress is open and the server has been quiet for settleMs.
  while (!conn.closed) {
    if (openTokens.size === 0 && Date.now() - lastActivity >= settleMs) break;
    if (Date.now() >= deadline) {
      out.partial = `indexing did not settle within ${timeoutMs} ms (${openTokens.size} progress token(s) open)`;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const symbolIds = new Set<string>();
  const imports = new Map<string, MapImport>();
  const usages = new Map<string, MapUsage>();
  try {
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi]!;
      if (Date.now() >= deadline) {
        out.partial ??= `the time budget of ${timeoutMs} ms ran out after ${fi} of ${files.length} file(s)`;
        break;
      }
      const raw = (await conn.request("textDocument/documentSymbol", { textDocument: { uri: toUri(f.path) } }, remaining())) as (DocumentSymbol | SymbolInformation)[] | null;
      const top = (raw ?? [])
        .filter((s) => ("location" in s ? !s.containerName : true))
        .map((s) => ({ name: s.name, kind: KIND[s.kind], at: "selectionRange" in s ? s.selectionRange.start : s.location.range.start }))
        .filter((s): s is { name: string; kind: MapSymbol["kind"]; at: Position } => Boolean(s.kind) && s.name.length > 0)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.at.line - b.at.line || a.at.character - b.at.character));
      const seenNames = new Set<string>();
      let asked = 0;
      for (const s of top) {
        const id = sha(`symbol\0${f.path}\0${s.name}`);
        if (!symbolIds.has(id)) {
          symbolIds.add(id);
          out.symbols.push({ id, module: f.path, name: s.name, kind: s.kind });
        }
        if (seenNames.has(s.name)) continue;
        seenNames.add(s.name);
        if (asked >= referenceCap) {
          if (!out.capped.includes(f.path)) out.capped.push(f.path);
          continue;
        }
        asked++;
        const refs = (await conn.request("textDocument/references", { textDocument: { uri: toUri(f.path) }, position: s.at, context: { includeDeclaration: false } }, Math.min(remaining(), 30_000))) as Location[] | null;
        for (const loc of refs ?? []) {
          const usedBy = fromUri(loc.uri);
          if (!usedBy || usedBy === f.path) continue;
          const uid = sha(`usage\0${f.path}\0${s.name}\0${usedBy}`);
          if (!usages.has(uid)) usages.set(uid, { id: uid, symbol: s.name, declaredIn: f.path, usedBy, via: "lsp" });
          const iid = sha(`import\0${usedBy}\0${f.path}\0reference`);
          if (!imports.has(iid)) imports.set(iid, { id: iid, from: usedBy, specifier: f.path, kind: "reference", resolution: "lsp", resolved: f.path });
        }
      }
    }
  } catch (err: unknown) {
    out.partial = exitedEarly ?? `the server stopped answering: ${(err as Error).message}`;
  }

  try {
    if (!conn.closed) {
      await conn.request("shutdown", null, 3000);
      conn.notify("exit", null);
    }
  } catch {
    // a server that will not shut down is killed by the caller
  }
  out.symbols.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : a.name < b.name ? -1 : 1));
  out.imports = [...imports.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.specifier < b.specifier ? -1 : 1));
  out.usages = [...usages.values()].sort((a, b) => (a.declaredIn < b.declaredIn ? -1 : a.declaredIn > b.declaredIn ? 1 : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.usedBy < b.usedBy ? -1 : 1));
  out.capped.sort();
  return out;
}

/**
 * The version handshake (M4 slice g): initialize, read `serverInfo`, shut down. No
 * document is opened. Null when the server answers without a name; a timeout or a
 * crash throws, and the caller treats both as "version unavailable".
 */
export async function serverInfoOf(o: { session: LspStreams; serverRoot: string; timeoutMs?: number }): Promise<{ name: string; version?: string } | null> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const { toUri } = uriMapper(o.serverRoot, []);
  const conn = new Connection(
    o.session.stdout,
    o.session.stdin,
    (method) => (method === "workspace/configuration" ? [] : method === "workspace/workspaceFolders" ? [{ uri: toUri(""), name: "workspace" }] : null),
    () => {}
  );
  void o.session.exited.then((e) => conn.close(`the server exited (code ${e.code})`));
  const init = (await conn.request("initialize", { processId: null, clientInfo: { name: "legion-flow", version: "1" }, rootUri: toUri(""), workspaceFolders: [{ uri: toUri(""), name: "workspace" }], capabilities: {} }, timeoutMs)) as { serverInfo?: { name: string; version?: string } } | null;
  try {
    if (!conn.closed) {
      conn.notify("initialized", {});
      await conn.request("shutdown", null, 3000);
      conn.notify("exit", null);
    }
  } catch {
    // a server that will not shut down is killed by the caller
  }
  return init?.serverInfo?.name ? { name: init.serverInfo.name, ...(init.serverInfo.version ? { version: init.serverInfo.version } : {}) } : null;
}

/** The fake server's entry file, for tests and for mounting into a container. */
export function fakeLspServerPath(): string {
  return fileURLToPath(new URL("./fake-server.js", import.meta.url));
}

export type { RpcError as LspRpcError };
