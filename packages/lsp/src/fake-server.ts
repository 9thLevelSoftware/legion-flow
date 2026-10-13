/**
 * A deterministic fake language server for tests. Built-ins only: under the
 * vm-docker tier this file is mounted alone into a plain node image, so any
 * import of a package would crash it before initialize.
 *
 * Language: `def NAME` on a line declares a top-level function; any other
 * whole-word occurrence of NAME in another open document is a reference.
 * Flags: --progress (index behind workDoneProgress), --index-ms N, --hang
 * (progress never ends), --crash-on-references, --version V, --drive-style
 * (answer Windows URIs as file:///d%3A/..., the way rust-analyzer does),
 * --version-file F (read the version from F at initialize; a missing file or
 * `none` omits it, so a test can upgrade the server without changing its config).
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const indexMs = Number(value("--index-ms", "0"));
const versionFile = value("--version-file", "");
const versionNow = (): string | undefined => {
  if (!versionFile) return value("--version", "1.0.0");
  try {
    const v = readFileSync(versionFile, "utf8").trim();
    return v && v !== "none" ? v : undefined;
  } catch {
    return undefined;
  }
};

const docs = new Map<string, string>();
let nextId = 1000;
let buffer = Buffer.alloc(0);

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

/** The URI as rust-analyzer would spell it on Windows, so the client's normalization is exercised. */
function spell(uri: string): string {
  if (!flag("--drive-style")) return uri;
  return uri.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d: string) => `file:///${d.toLowerCase()}%3A`);
}

function declarations(text: string): { name: string; line: number; character: number }[] {
  const out: { name: string; line: number; character: number }[] = [];
  text.split("\n").forEach((l, line) => {
    const m = /^def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(l);
    if (m) out.push({ name: m[1]!, line, character: l.indexOf(m[1]!) });
  });
  return out;
}

function nameAt(uri: string, line: number, character: number): string | null {
  const text = docs.get(uri);
  if (!text) return null;
  const l = text.split("\n")[line] ?? "";
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(l))) if (character >= m.index && character <= m.index + m[0].length) return m[0];
  return null;
}

function handle(msg: { id?: number; method?: string; params?: any; result?: unknown }): void {
  if (msg.method === undefined) return; // a response to one of our requests
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      reply({ capabilities: { documentSymbolProvider: true, referencesProvider: true, textDocumentSync: 1 }, serverInfo: { name: "fake-lsp", ...(versionNow() ? { version: versionNow() } : {}) } });
      return;
    case "initialized": {
      // Ask the client for configuration, as real servers do; the client must answer.
      send({ jsonrpc: "2.0", id: nextId++, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
      if (flag("--progress") || flag("--hang")) {
        const token = "index";
        send({ jsonrpc: "2.0", id: nextId++, method: "window/workDoneProgress/create", params: { token } });
        send({ jsonrpc: "2.0", method: "$/progress", params: { token, value: { kind: "begin", title: "Indexing" } } });
        if (!flag("--hang")) setTimeout(() => send({ jsonrpc: "2.0", method: "$/progress", params: { token, value: { kind: "end" } } }), indexMs);
      }
      return;
    }
    case "textDocument/didOpen":
      docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
      return;
    case "textDocument/documentSymbol": {
      const text = docs.get(msg.params.textDocument.uri) ?? "";
      reply(declarations(text).map((d) => {
        const range = { start: { line: d.line, character: 0 }, end: { line: d.line, character: d.character + d.name.length } };
        return { name: d.name, kind: 12, range, selectionRange: { start: { line: d.line, character: d.character }, end: { line: d.line, character: d.character + d.name.length } } };
      }));
      return;
    }
    case "textDocument/references": {
      if (flag("--crash-on-references")) process.exit(3);
      const name = nameAt(msg.params.textDocument.uri, msg.params.position.line, msg.params.position.character);
      const out: unknown[] = [];
      if (name) {
        for (const [uri, text] of [...docs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (uri === msg.params.textDocument.uri) continue;
          text.split("\n").forEach((l, line) => {
            if (/^def\s/.test(l)) return;
            const re = new RegExp(`\\b${name}\\b`, "g");
            let m: RegExpExecArray | null;
            while ((m = re.exec(l))) out.push({ uri: spell(uri), range: { start: { line, character: m.index }, end: { line, character: m.index + name.length } } });
          });
        }
      }
      reply(out);
      return;
    }
    case "shutdown":
      reply(null);
      return;
    case "exit":
      process.exit(0);
      return;
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1] ?? "0");
    if (buffer.length < end + 4 + len) return;
    const body = buffer.subarray(end + 4, end + 4 + len).toString("utf8");
    buffer = buffer.subarray(end + 4 + len);
    handle(JSON.parse(body));
  }
});
process.stdin.on("end", () => process.exit(0));
void fileURLToPath;
