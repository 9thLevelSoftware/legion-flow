/**
 * JSON-RPC 2.0 over the LSP base protocol (Content-Length framing), written
 * here rather than imported (no vscode-jsonrpc). Requests time out; a closed
 * stream rejects everything pending; server-to-client requests go to a handler
 * that must answer, because a server waiting on an unanswered request stalls.
 */
import type { Readable, Writable } from "node:stream";

export class RpcError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "RpcError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
export type RequestHandler = (method: string, params: unknown) => unknown | { error: { code: number; message: string } };
export type NotificationHandler = (method: string, params: unknown) => void;

export class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closedReason: string | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: RequestHandler,
    private readonly onNotification: NotificationHandler
  ) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.on("end", () => this.close("the server closed its output"));
    input.on("error", (err: Error) => this.close(`the server's output failed: ${err.message}`));
    output.on("error", (err: Error) => this.close(`writing to the server failed: ${err.message}`));
  }

  get closed(): string | null {
    return this.closedReason;
  }

  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(reason));
      this.pending.delete(id);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closedReason) return Promise.reject(new RpcError(this.closedReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedReason) this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.close("the server sent a frame without Content-Length");
        return;
      }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }): void {
    if (message.method && message.id !== undefined) {
      let answer: unknown;
      try {
        answer = this.onRequest(message.method, message.params);
      } catch (err) {
        answer = { error: { code: -32603, message: (err as Error).message } };
      }
      if (answer && typeof answer === "object" && "error" in (answer as object)) this.send({ jsonrpc: "2.0", id: message.id, error: (answer as { error: unknown }).error });
      else this.send({ jsonrpc: "2.0", id: message.id, result: answer ?? null });
      return;
    }
    if (message.method) {
      this.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error) p.reject(new RpcError(message.error.message, message.error.code));
      else p.resolve(message.result);
    }
  }
}
