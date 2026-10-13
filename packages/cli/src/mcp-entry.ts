/**
 * The entry point of `mcp`, apart from commands.ts so that commands never
 * imports the server: mcp.ts imports the handlers, never the other way round.
 * Exactly one transport: --stdio, or --http on 127.0.0.1. Neither or both is a
 * usage error printed to stderr with exit 2 and no envelope (the protocol, not
 * the envelope, owns this verb's stdout).
 */
import type { CommandContext } from "./runner.js";

export async function mcpServe(ctx: CommandContext, opts: { stdio?: boolean; http?: boolean; port?: string; tokenFile?: string }): Promise<void> {
  if (Boolean(opts.stdio) === Boolean(opts.http)) {
    process.stderr.write("legion-flow mcp: choose exactly one transport: --stdio, or --http [--port <n>] [--token-file <path>].\n");
    process.exitCode = 2;
    return;
  }
  if (opts.stdio) {
    const { serveStdio } = await import("./mcp.js");
    await serveStdio(ctx);
    return;
  }
  const port = opts.port === undefined ? 0 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`legion-flow mcp: --port must be 0 to 65535 (got '${opts.port}').\n`);
    process.exitCode = 2;
    return;
  }
  const { serveHttp } = await import("./mcp.js");
  await serveHttp(ctx, { port, ...(opts.tokenFile ? { tokenFile: opts.tokenFile } : {}) });
}
