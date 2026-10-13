import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Adapter, AdapterRunInput, AdapterOutcome, Mount } from "@9thlevelsoftware/legion-flow-engine";
import { buildAdapterEnv } from "./env.js";

/** Where the fake adapter looks for scripted edits: project-wide, read at spawn, never deleted. */
export const FAKE_ADAPTER_PLAN_RELATIVE = ".legion-flow/var/fake-adapter.json";

export interface FakeAdapterPlan {
  edits?: { path: string; content: string | null }[];
  exitCode?: number;
  sleepMs?: number;
}

/** Guest paths the fake adapter asks for; the host tier maps them to themselves. */
const GUEST = { tree: "/work", run: "/legion/run", adapters: "/legion/adapters", plan: "/legion/fake-adapter.json" };

/** The directory holding this package's compiled files, mounted read-only under Docker. */
export function adaptersDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * The adapter that needs no model and no key. It never spawns on its own: it
 * describes an argv in terms of the mounts it needs, and the tier's exec runs
 * it on the host or in a container. Without a plan file the agent appends a
 * marker to every existing allowed file and creates missing expected artifacts.
 */
export class FakeAdapter implements Adapter {
  readonly id = "fake";
  readonly profile = { supportsTools: false, supportsJsonOutput: false, reportsUsage: { turns: false, tokens: false, cost: false }, image: "node:22-alpine" };

  async run(input: AdapterRunInput): Promise<AdapterOutcome> {
    const dist = adaptersDistDir();
    const runDir = dirname(input.promptPath);
    const planPath = join(input.workspaceRoot, ...FAKE_ADAPTER_PLAN_RELATIVE.split("/"));
    let hasPlan = false;
    try {
      await access(planPath);
      hasPlan = true;
    } catch {
      // no scripted plan
    }
    const mounts: Mount[] = [
      { host: input.treeDir, guest: GUEST.tree },
      { host: runDir, guest: GUEST.run },
      { host: dist, guest: GUEST.adapters, readonly: true },
      ...(hasPlan ? [{ host: planPath, guest: GUEST.plan, readonly: true }] : []),
    ];
    const command = input.envMode === "container" ? "node" : process.execPath;
    return input.exec({
      command,
      args: (map) => [map(join(dist, "fake-agent.js")), map(input.promptPath), map(input.treeDir), hasPlan ? map(planPath) : "-"],
      cwd: (map) => map(input.treeDir),
      mounts,
      // The tool gateway (M4 slice k): on the host its URL and token travel by environment; under Docker the tier fills LF_TOOLS_URL and the proxy holds the token.
      env: { ...buildAdapterEnv(process.env, { mode: input.envMode }), ...(input.tools?.url ? { LF_TOOLS_URL: input.tools.url } : {}), ...(input.tools?.token ? { LF_TOOLS_TOKEN: input.tools.token } : {}) },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }
}
