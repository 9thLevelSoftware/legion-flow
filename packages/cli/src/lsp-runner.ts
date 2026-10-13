/**
 * The language-server runner: the lsp client over a sandbox session. On the
 * host the server gets the adapter base allowlist plus its own envKeys by name;
 * under vm-docker it runs in its own image with no network and the tree
 * read-only, and only the envKeys names travel (values stay in the client env).
 */
import { randomBytes } from "node:crypto";
import type { LanguageServerConfig } from "@9thlevelsoftware/legion-flow-schema";
import type { LanguageServerRunner } from "@9thlevelsoftware/legion-flow-memory";
import { extractWithServer, serverInfoOf } from "@9thlevelsoftware/legion-flow-lsp";
import { buildAdapterEnv } from "@9thlevelsoftware/legion-flow-adapters";
import { dockerSession, hostSession, realDockerCli, type DockerCli, type DockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";

export type LspTier = "vm-docker" | "unhardened";

export function languageServerRunner(options: { tier: LspTier; dockerSettings: DockerSettings; docker?: DockerCli; refuse?: string }): LanguageServerRunner {
  const open = async (server: LanguageServerConfig, root: string) => {
      // A run that prepared no tier (M4 slice t: a resume that only applies decided choices) starts no server at all.
      if (options.refuse) throw new Error(options.refuse);
      let session;
      if (options.tier === "unhardened") {
        const env = buildAdapterEnv(process.env, { mode: "host", extraAllowlist: server.envKeys ?? [] });
        session = await hostSession({ command: server.command, args: server.args ?? [], root, env });
      } else {
        if (!server.image) throw new Error(`language server '${server.language}' has no image for the vm-docker tier; set map.languageServers[].image, or run legion-flow map --sandbox unhardened --allow-no-sandbox on a terminal`);
        const env: Record<string, string> = {};
        for (const name of server.envKeys ?? []) if (process.env[name] !== undefined) env[name] = process.env[name]!;
        const name = `lf-lsp-${server.language}-${randomBytes(3).toString("hex")}`;
        session = await dockerSession(options.docker ?? realDockerCli, { ...options.dockerSettings, image: server.image }, name)({ command: server.command, args: server.args ?? [], root, env });
      }
      return session;
  };
  return {
    async version(server: LanguageServerConfig, input) {
      const session = await open(server, input.root);
      try {
        return await serverInfoOf({ session, serverRoot: session.serverRoot, timeoutMs: Math.min(server.timeoutMs ?? 30_000, 30_000) });
      } finally {
        await session.kill();
      }
    },
    async run(server: LanguageServerConfig, input) {
      const timeoutMs = server.timeoutMs ?? 120_000;
      const session = await open(server, input.root);
      try {
        return await extractWithServer({
          session,
          language: server.language,
          ...(server.languageId ? { languageId: server.languageId } : {}),
          hostRoot: input.root,
          serverRoot: session.serverRoot,
          files: input.files,
          ...(server.initializationOptions ? { initializationOptions: server.initializationOptions } : {}),
          timeoutMs,
          ...(server.referenceCap ? { referenceCap: server.referenceCap } : {}),
        });
      } finally {
        await session.kill();
      }
    },
  };
}
