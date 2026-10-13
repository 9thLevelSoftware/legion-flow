import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecSpec, SandboxExec } from "@9thlevelsoftware/legion-flow-engine";
import {
  adapterById,
  parseClaudeOutput,
  parseCodexOutput,
  agentDockerfile,
  agentImageTag,
  AGENT_CLI_VERSIONS,
  PLACEHOLDER_KEY,
  vendorPrefixMatches,
  CLAUDE_DEFINITION,
  CODEX_DEFINITION,
  withProvider,
  definitionOf,
} from "../dist/index.js";

/** An exec that records the spec, writes a scripted stdout file, and answers exit 0. */
function recordingExec(stdout: string): SandboxExec & { specs: ExecSpec[] } {
  const exec = (async (spec: ExecSpec) => {
    exec.specs.push(spec);
    if (spec.stdoutPath) await writeFile(spec.stdoutPath, stdout, "utf8");
    return { exitCode: 0, signal: null, timedOut: false, stdoutTail: stdout.slice(-100), stderrTail: "", stdoutPath: spec.stdoutPath, argv: [spec.command, ...spec.args((p) => p)] };
  }) as SandboxExec & { specs: ExecSpec[] };
  exec.specs = [];
  return exec;
}

const claudeResult = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 3, result: "Edited src/a.ts as asked.", session_id: "s", total_cost_usd: 0.0421, usage: { input_tokens: 1500, output_tokens: 420, cache_read_input_tokens: 0 } });
const codexEvents = [
  { type: "thread.started", thread_id: "t1" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Done: edited src/a.ts." } },
  { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 300 } },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 50 } },
].map((e) => JSON.stringify(e)).join("\n");

describe("vendor output parsers", () => {
  test("claude's JSON result yields turns, tokens, cost, and the result text; anything else is unknown", () => {
    const parsed = parseClaudeOutput("some preamble\n" + claudeResult + "\n");
    assert.deepEqual(parsed.usage, { known: true, turns: 3, inputTokens: 1500, outputTokens: 420, costUsd: 0.0421 });
    assert.equal(parsed.resultText, "Edited src/a.ts as asked.");
    assert.equal(parseClaudeOutput("not json").usage.known, false);
    assert.equal(parseClaudeOutput(JSON.stringify({ type: "other" })).usage.known, false);
  });

  test("codex's JSON lines yield summed tokens, a turn count, the agent message, and never a cost", () => {
    const parsed = parseCodexOutput(codexEvents);
    assert.deepEqual(parsed.usage, { known: true, turns: 2, inputTokens: 1100, outputTokens: 350, costUsd: null });
    assert.equal(parsed.resultText, "Done: edited src/a.ts.");
    assert.equal(parseCodexOutput("").usage.known, false);
  });

  test("vendor prefixes match the installed binaries' actual version lines", () => {
    assert.equal(vendorPrefixMatches(CLAUDE_DEFINITION.vendorPrefix, "2.1.295 (Claude Code)\n"), true);
    assert.equal(vendorPrefixMatches(CODEX_DEFINITION.vendorPrefix, "codex-cli 0.162.0"), true);
    assert.equal(vendorPrefixMatches(CODEX_DEFINITION.vendorPrefix, "something-else 1.0"), false);
  });

  test("the agent image is pinned to the CLI versions and built from a glibc base", () => {
    assert.equal(agentImageTag(), `legion-flow-agent:claude-${AGENT_CLI_VERSIONS.claude}-codex-${AGENT_CLI_VERSIONS.codex}`);
    const df = agentDockerfile();
    assert.match(df, /^FROM node:22-bookworm-slim$/m);
    assert.match(df, new RegExp(`@anthropic-ai/claude-code@${AGENT_CLI_VERSIONS.claude} @openai/codex@${AGENT_CLI_VERSIONS.codex}`));
    assert.match(df, /^USER 1000:1000$/m);
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-vendor-"));
  const tree = join(root, "tree");
  const runDir = join(root, "run");
  await mkdir(tree, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), "# p\n");
  return { root, tree, runDir, promptPath: join(runDir, "prompt.md") };
}

describe("claude and codex adapters against a recording exec", () => {

  test("claude, container: placeholder key as a constant, no host variable forwarded, base URL route declared, bypass mode, usage parsed, summary written", async () => {
    const { root, tree, runDir, promptPath } = await setup();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-real-key-for-test";
      const exec = recordingExec(claudeResult);
      const adapter = adapterById("claude")!;
      const outcome = await adapter.run({ runId: "run_c", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "container", model: "claude-sonnet-5-5", limits: { maxTurns: 5 } });
      const spec = exec.specs[0]!;
      assert.equal(spec.command, "claude");
      assert.equal(spec.constants?.ANTHROPIC_API_KEY, PLACEHOLDER_KEY, "the agent holds only a placeholder");
      assert.equal(spec.constants?.HOME, "/home/node");
      assert.equal(spec.env.ANTHROPIC_API_KEY, undefined, "the real key is never in the agent's environment inside a container");
      assert.equal(spec.env.PATH, undefined);
      assert.deepEqual(spec.baseUrl, { envName: "ANTHROPIC_BASE_URL", alias: "anthropic" });
      // The real mount mapper normalizes backslashes; this stand-in does the same.
      const map = (p: string) => p.replace(runDir, "/legion/run").replace(tree, "/work").replace(/\\/g, "/");
      const args = spec.args(map);
      assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
      assert.equal(args[args.indexOf("--add-dir") + 1], "/legion/run");
      assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
      assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5");
      assert.equal(args.includes("--max-turns"), false, "not a flag of this claude version; the limit is enforced after the run");
      assert.match(args.at(-1)!, /^Read and follow \/legion\/run\/prompt\.md/);
      assert.deepEqual(spec.mounts.map((m) => m.guest), ["/work", "/legion/run"]);
      assert.equal(spec.stdoutPath, join(runDir, "adapter-stdout.log"));
      assert.deepEqual(outcome.usage, { known: true, turns: 3, inputTokens: 1500, outputTokens: 420, costUsd: 0.0421 });
      assert.equal(await readFile(join(runDir, "summary.md"), "utf8"), "Edited src/a.ts as asked.\n");
      assert.deepEqual(adapter.credential, { env: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", routeAlias: "anthropic" });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude, host: the real key travels by name, guarded mode without Bash, no base URL override; codex: exec flags, -o summary, Bearer prefix on its route", async () => {
    const { root, tree, runDir, promptPath } = await setup();
    try {
      process.env.ANTHROPIC_API_KEY = "sk-real-key-for-test";
      const exec = recordingExec(claudeResult);
      await adapterById("claude")!.run({ runId: "run_h", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "host" });
      const spec = exec.specs[0]!;
      assert.equal(spec.env.ANTHROPIC_API_KEY, "sk-real-key-for-test", "on the host tier the vendor CLI holds the key, as the research says of the jail tiers");
      assert.equal(spec.constants?.ANTHROPIC_API_KEY, undefined);
      assert.equal(spec.constants?.HOME, undefined, "the host keeps its own home");
      const args = spec.args((p) => p);
      assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
      assert.equal(args[args.indexOf("--allowedTools") + 1].includes("Bash"), false);

      const cexec = recordingExec(codexEvents);
      const codex = adapterById("codex")!;
      const out = await codex.run({ runId: "run_x", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec: cexec, envMode: "container" });
      const cspec = cexec.specs[0]!;
      const cargs = cspec.args((p) => p.replace(runDir, "/legion/run").replace(tree, "/work").replace(/\\/g, "/"));
      assert.deepEqual(cargs.slice(0, 2), ["exec", "--json"]);
      assert.equal(cargs[cargs.indexOf("-C") + 1], "/work");
      assert.equal(cargs[cargs.indexOf("-o") + 1], "/legion/run/summary.md");
      assert.equal(cargs[cargs.indexOf("--sandbox") + 1], "danger-full-access");
      assert.equal(cspec.constants?.OPENAI_API_KEY, PLACEHOLDER_KEY);
      assert.equal(cspec.constants?.CODEX_HOME, "/home/node");
      assert.deepEqual(out.usage, { known: true, turns: 2, inputTokens: 1100, outputTokens: 350, costUsd: null });
      assert.equal(CODEX_DEFINITION.route.secrets[0]?.prefix, "Bearer ");
      assert.equal(codex.profile.reportsUsage.cost, false);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (q): codex and the tool gateway", () => {
  const values = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
  test("host: the gateway URL is literal, the token travels by variable name, approval is codex's no-prompt mode, nothing to expand", async () => {
    const { root, tree, promptPath } = await setup();
    try {
      const exec = recordingExec(codexEvents);
      await adapterById("codex")!.run({ runId: "run_t", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "host", tools: { url: "http://127.0.0.1:4567/mcp", token: "tok-secret" } });
      const spec = exec.specs[0]!;
      const args = spec.args((p) => p);
      assert.deepEqual(values(args), ["mcp_servers.legion.url=http://127.0.0.1:4567/mcp", "mcp_servers.legion.bearer_token_env_var=LF_TOOLS_TOKEN", "mcp_servers.legion.default_tools_approval_mode=approve"]);
      assert.ok(!args.join(" ").includes("tok-secret"), "the token never enters the argv");
      assert.equal(spec.env.LF_TOOLS_TOKEN, "tok-secret");
      assert.equal(spec.expandArgs, undefined);
      assert.ok(args.indexOf("-c") < args.length - 1 && !args.at(-1)!.startsWith("mcp_servers"), "the prompt stays last");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("container: the tier fills the proxy route into the URL, and there is no bearer variable; without tools codex gets no -c at all", async () => {
    const { root, tree, promptPath } = await setup();
    try {
      const exec = recordingExec(codexEvents);
      await adapterById("codex")!.run({ runId: "run_c", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "container", tools: {} });
      const spec = exec.specs[0]!;
      assert.deepEqual(values(spec.args((p) => p)), ["mcp_servers.legion.url=${LF_TOOLS_URL}", "mcp_servers.legion.default_tools_approval_mode=approve"]);
      assert.equal(spec.expandArgs, true);
      const plain = recordingExec(codexEvents);
      await adapterById("codex")!.run({ runId: "run_p", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec: plain, envMode: "container" });
      assert.ok(!plain.specs[0]!.args((p) => p).includes("-c"));
      assert.equal(plain.specs[0]!.expandArgs, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (y): claude with an Anthropic-compatible provider", () => {
  const provider = { baseUrl: "https://token-plan.example.com/anthropic", apiKeyEnv: "LF_TEST_PROVIDER_KEY", model: "provider-model-1" };

  test("the derived definition routes to the provider's host under its path with a bearer secret by name, and cost is not reportable; codex needs a model", () => {
    const def = withProvider(CLAUDE_DEFINITION, provider);
    assert.deepEqual(def.route, { alias: "anthropic", host: "token-plan.example.com", scheme: "https", basePath: "/anthropic", secrets: [{ header: "authorization", ref: "env:LF_TEST_PROVIDER_KEY", prefix: "Bearer " }] });
    assert.equal(def.credentialEnv, "LF_TEST_PROVIDER_KEY");
    assert.equal(def.profile.reportsUsage.cost, false);
    assert.equal(def.profile.reportsUsage.turns, true);
    assert.equal(CLAUDE_DEFINITION.route.host, "api.anthropic.com", "the base definition is untouched");
    assert.throws(() => withProvider(CODEX_DEFINITION, { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv }), /adapter_provider_model_required/, "codex's catalog is keyed by the model");
    const local = withProvider(CLAUDE_DEFINITION, { baseUrl: "http://127.0.0.1:8099/", apiKeyEnv: "K" });
    assert.deepEqual({ host: local.route.host, port: local.route.port, scheme: local.route.scheme, basePath: local.route.basePath }, { host: "127.0.0.1", port: 8099, scheme: "http", basePath: undefined });
  });

  test("container: the placeholder rides ANTHROPIC_AUTH_TOKEN only, the model variables are set, nothing from the host travels, and the parsed cost is dropped", async () => {
    const { root, tree, promptPath } = await setup();
    try {
      process.env.LF_TEST_PROVIDER_KEY = "tp-do-not-forward";
      process.env.ANTHROPIC_API_KEY = "sk-also-not";
      const exec = recordingExec(claudeResult);
      const adapter = adapterById("claude", { provider })!;
      const outcome = await adapter.run({ runId: "run_p", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "container", model: "provider-model-1" });
      const spec = exec.specs[0]!;
      assert.equal(spec.constants?.ANTHROPIC_AUTH_TOKEN, PLACEHOLDER_KEY);
      assert.equal(spec.constants?.ANTHROPIC_API_KEY, undefined, "one auth header leaves the agent, and it is the one the proxy overwrites");
      for (const v of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) assert.equal(spec.constants?.[v], "provider-model-1", v);
      assert.deepEqual(spec.env, Object.fromEntries(Object.entries(spec.env).filter(([k]) => !/KEY|TOKEN/.test(k))), "no key or token in the container's forwarded env");
      assert.deepEqual(spec.baseUrl, { envName: "ANTHROPIC_BASE_URL", alias: "anthropic" }, "the tier points the CLI at the proxy route");
      assert.deepEqual(adapter.credential, { env: "LF_TEST_PROVIDER_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", routeAlias: "anthropic" }, "presence checks and redaction use the provider's variable");
      assert.equal(definitionOf(adapter)?.route.host, "token-plan.example.com");
      assert.deepEqual(outcome.usage, { known: true, turns: 3, inputTokens: 1500, outputTokens: 420, costUsd: null });
    } finally {
      delete process.env.LF_TEST_PROVIDER_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host: the provider's value is handed over as ANTHROPIC_AUTH_TOKEN under no other name, and the CLI is pointed at the provider's root", async () => {
    const { root, tree, promptPath } = await setup();
    try {
      process.env.LF_TEST_PROVIDER_KEY = "tp-host-value";
      process.env.ANTHROPIC_API_KEY = "sk-must-not-travel";
      const exec = recordingExec(claudeResult);
      await adapterById("claude", { provider })!.run({ runId: "run_ph", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "host" });
      const spec = exec.specs[0]!;
      assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, "tp-host-value");
      assert.equal(spec.env.LF_TEST_PROVIDER_KEY, undefined);
      assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(spec.constants?.ANTHROPIC_BASE_URL, "https://token-plan.example.com/anthropic");
      assert.equal(spec.constants?.ANTHROPIC_MODEL, "provider-model-1");
      assert.ok(!JSON.stringify(spec.constants).includes("tp-host-value"), "constants are recorded; the value is not among them");
    } finally {
      delete process.env.LF_TEST_PROVIDER_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M4 slice (aa): codex with an OpenAI-compatible provider", () => {
  const provider = { baseUrl: "https://token-plan.example.com/v1", apiKeyEnv: "LF_TEST_PROVIDER_KEY", model: "provider-model-1", contextWindow: 1_048_576 };

  test("container: an explicit Responses provider by -c overrides, its root filled by the tier, the placeholder in OPENAI_API_KEY, Legion's catalog entry written to the run directory", async () => {
    const { root, tree, runDir, promptPath } = await setup();
    try {
      process.env.LF_TEST_PROVIDER_KEY = "tp-not-forwarded";
      const exec = recordingExec(codexEvents);
      const adapter = adapterById("codex", { provider })!;
      const outcome = await adapter.run({ runId: "run_cx", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "container", model: "provider-model-1" });
      const spec = exec.specs[0]!;
      assert.equal(spec.constants?.OPENAI_API_KEY, PLACEHOLDER_KEY);
      assert.equal(spec.expandArgs, true, "the tier fills the provider root from its constants");
      assert.deepEqual(spec.baseUrl, { envName: "OPENAI_BASE_URL", alias: "openai" });
      const map = (p: string) => p.replace(runDir, "/legion/run").replace(tree, "/work").replace(/\\/g, "/");
      const args = spec.args(map);
      const c = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
      for (const want of ["model_provider=legion_provider", "model_providers.legion_provider.base_url=${OPENAI_BASE_URL}", "model_providers.legion_provider.env_key=OPENAI_API_KEY", "model_providers.legion_provider.wire_api=responses", "model_catalog_json=/legion/run/codex-model-catalog.json", "web_search=disabled", "model_reasoning_summary=none"]) assert.ok(c.includes(want), want);
      assert.equal(args[args.indexOf("-m") + 1], "provider-model-1");
      const catalog = JSON.parse(await readFile(join(runDir, "codex-model-catalog.json"), "utf8"));
      const entry = catalog.models[0];
      assert.equal(entry.slug, "provider-model-1");
      assert.equal(entry.use_responses_lite, true);
      assert.equal(entry.apply_patch_tool_type, "freeform");
      assert.equal(entry.context_window, 1_048_576);
      assert.deepEqual(entry.experimental_supported_tools, []);
      assert.equal(entry.support_verbosity, false);
      assert.deepEqual(entry.supported_reasoning_levels.map((l: { effort: string }) => l.effort), ["low", "medium", "high"]);
      assert.equal(definitionOf(adapter)?.route.basePath, "/v1");
      assert.deepEqual(definitionOf(adapter)?.route.secrets, [{ header: "authorization", ref: "env:LF_TEST_PROVIDER_KEY", prefix: "Bearer " }]);
      assert.equal(outcome.usage.known && outcome.usage.costUsd, null);
    } finally {
      delete process.env.LF_TEST_PROVIDER_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host: the provider's value travels as OPENAI_API_KEY only, and OPENAI_BASE_URL is the provider's root; without a provider codex is unchanged", async () => {
    const { root, tree, promptPath } = await setup();
    try {
      process.env.LF_TEST_PROVIDER_KEY = "tp-host-codex";
      process.env.OPENAI_API_KEY = "sk-must-not-travel";
      const exec = recordingExec(codexEvents);
      await adapterById("codex", { provider })!.run({ runId: "run_cxh", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec, envMode: "host", model: "provider-model-1" });
      const spec = exec.specs[0]!;
      assert.equal(spec.env.OPENAI_API_KEY, "tp-host-codex");
      assert.equal(spec.env.LF_TEST_PROVIDER_KEY, undefined);
      assert.equal(spec.constants?.OPENAI_BASE_URL, "https://token-plan.example.com/v1");
      const plain = recordingExec(codexEvents);
      await adapterById("codex")!.run({ runId: "run_cxp", workspaceRoot: root, treeDir: tree, promptPath, signal: new AbortController().signal, timeoutMs: 1000, exec: plain, envMode: "host" });
      assert.ok(!plain.specs[0]!.args((p) => p).some((a) => a.startsWith("model_provider")), "no provider, no override");
    } finally {
      delete process.env.LF_TEST_PROVIDER_KEY;
      delete process.env.OPENAI_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});
