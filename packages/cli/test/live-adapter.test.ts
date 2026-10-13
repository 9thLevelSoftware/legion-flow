/**
 * The live adapter test (M4 slice y): one task run of the real claude CLI inside the agent image on vm-docker,
 * against a real Anthropic-compatible provider configured through project.json adapter.http. It makes real model
 * requests (several per task run), so it runs only when asked:
 *
 *   LF_LIVE_ADAPTER_TESTS=1           opt in
 *   LF_LIVE_BASE_URL=https://...      the provider's Anthropic-compatible root (no host is written into this repo)
 *   LF_LIVE_KEY_ENV=MIMO_API_KEY      the variable holding the key (default MIMO_API_KEY); its value never enters a record
 *   LF_LIVE_MODEL=mimo-v2.6-pro       the model (default mimo-v2.6-pro)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultEnvelopeSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { dockerCheapChecks, realDockerCli, resolveDockerSettings } from "@9thlevelsoftware/legion-flow-sandbox";
import { agentImageTag } from "@9thlevelsoftware/legion-flow-adapters";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand } from "../dist/index.js";

const node = `"${process.execPath}"`;
const keyEnv = process.env.LF_LIVE_KEY_ENV ?? "MIMO_API_KEY";
const baseUrl = process.env.LF_LIVE_BASE_URL;
const model = process.env.LF_LIVE_MODEL ?? "mimo-v2.6-pro";
const EXPECTED = "hello from the live adapter";

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe("live adapter: claude through a provider on vm-docker (LF_LIVE_ADAPTER_TESTS=1 only)", async () => {
  let skip: string | undefined;
  if (process.env.LF_LIVE_ADAPTER_TESTS !== "1") skip = "set LF_LIVE_ADAPTER_TESTS=1 to make real model requests";
  else if (!baseUrl) skip = "set LF_LIVE_BASE_URL to the provider's Anthropic-compatible root";
  else if (!process.env[keyEnv]) skip = `${keyEnv} is not set`;
  else {
    const cheap = await dockerCheapChecks({ docker: realDockerCli, settings: resolveDockerSettings(undefined, process.platform, agentImageTag()) }).catch(() => null);
    if (!cheap?.checks.every((c) => c.status === "pass")) skip = `docker or the agent image is not usable: ${cheap?.checks.find((c) => c.status !== "pass")?.message ?? "client failed"}`;
  }

  test("one task run writes the asked file, the check passes, R0 applies, usage is parsed with cost unknown, the only egress host is the provider, and the key's value is in no record", { skip, timeout: 900_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-live-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: false, workspace: ws };
    try {
      // The check is a file the agent may not touch: it passes only when hello.txt holds the exact line.
      await writeFile(join(root, "check.js"), `const t = require("fs").readFileSync("hello.txt", "utf8").trim(); if (t !== ${JSON.stringify(EXPECTED)}) { console.error("got: " + JSON.stringify(t)); process.exit(1); }\n`);
      await initCommand(ctx, { adapter: "claude", name: "Live", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      cfg.adapter.http = { baseUrl, apiKeyEnv: keyEnv, model };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Live adapter" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: `hello.txt contains exactly the line "${EXPECTED}"`, kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
      await approveCommand(ctx, { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx, { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: `Create hello.txt containing exactly the line: ${EXPECTED}`, acceptanceIds: ["AC-01"], contract: { filesAllowed: ["hello.txt"], verificationCommands: [`${node} check.js`] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
      await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} check.js`] });

      const result = await executeCommand(ctx, { installSignalHandlers: false, adapterTimeoutMs: 600_000 });
      ResultEnvelopeSchema.parse(result);
      assert.equal(result.status, "ok", JSON.stringify(result.diagnostics, null, 2));
      assert.ok(result.diagnostics.some((d) => d.code === "execution_auto_applied"));
      assert.ok(result.diagnostics.some((d) => d.code === "adapter_provider"), "the provider is named on the envelope");
      assert.equal((await readFile(join(root, "hello.txt"), "utf8")).trim(), EXPECTED);

      const evidenceDir = join(ws.paths.runsDir, result.runId!, "evidence");
      const records = await Promise.all((await readdir(evidenceDir)).map(async (f) => JSON.parse(await readFile(join(evidenceDir, f), "utf8"))));
      const outcome = records.find((r) => r.kind === "adapter_outcome");
      assert.equal(outcome?.exitCode, 0);
      assert.equal(outcome?.usage?.known, true, JSON.stringify(outcome?.usage));
      assert.equal(outcome?.usage?.costUsd, null, "a provider's cost is unknown, not the CLI's vendor price");
      assert.ok((outcome?.usage?.outputTokens ?? 0) > 0);

      // Every egress line names the provider's host; nothing else left the container.
      const providerHost = new URL(baseUrl!).hostname;
      const egressLines = (await filesUnder(join(ws.paths.varDir, "egress"))).filter((f) => f.endsWith("egress.jsonl"));
      assert.ok(egressLines.length > 0, "the proxy logged");
      const lines = (await Promise.all(egressLines.map((f) => readFile(f, "utf8")))).join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.length > 0);
      for (const l of lines) assert.equal(l.host, providerHost, JSON.stringify(l));
      assert.ok(lines.some((l) => l.denied === false && l.status < 400), "at least one provider request succeeded");

      // The strongest check available: the key's value appears in no file the run left behind.
      const secret = process.env[keyEnv]!;
      for (const f of await filesUnder(join(root, ".legion-flow"))) {
        if ((await stat(f)).size > 20_000_000) continue;
        assert.equal((await readFile(f)).includes(secret), false, `the key's value is in ${f}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("live adapter with the web tool: claude calls web__scrape through the gateway (also needs LF_LIVE_FIRECRAWL_URL)", async () => {
  const firecrawl = process.env.LF_LIVE_FIRECRAWL_URL;
  let skip: string | undefined;
  if (process.env.LF_LIVE_ADAPTER_TESTS !== "1") skip = "set LF_LIVE_ADAPTER_TESTS=1 to make real model requests";
  else if (!baseUrl || !process.env[keyEnv]) skip = `set LF_LIVE_BASE_URL and ${keyEnv}`;
  else if (!firecrawl) skip = "set LF_LIVE_FIRECRAWL_URL to a running Firecrawl's loopback URL";

  test("the agent fetches an allowed page with the web tool and writes what it read; the fetch is evidence; the egress log names only the provider and the gateway", { skip, timeout: 900_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-live-web-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: false, workspace: ws };
    try {
      await writeFile(join(root, "check.js"), `const t = require("fs").readFileSync("heading.txt", "utf8").trim(); if (t !== "Example Domain") { console.error("got: " + JSON.stringify(t)); process.exit(1); }\n`);
      await initCommand(ctx, { adapter: "claude", name: "Live web", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      cfg.adapter.http = { baseUrl, apiKeyEnv: keyEnv, model };
      cfg.web = { firecrawlUrl: firecrawl };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Live web" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: "heading.txt holds the first heading of https://example.com", kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
      await approveCommand(ctx, { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx, { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: "Use the web__scrape tool (mcp__legion) to fetch https://example.com, then write only the page's first heading text, with nothing else, into heading.txt", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["heading.txt"], verificationCommands: [`${node} check.js`] }, tools: ["web"], web: { allowedDomains: ["example.com"] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
      await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} check.js`] });

      const result = await executeCommand(ctx, { installSignalHandlers: false, adapterTimeoutMs: 600_000 });
      assert.equal(result.status, "ok", JSON.stringify(result.diagnostics, null, 2));
      assert.equal((await readFile(join(root, "heading.txt"), "utf8")).trim(), "Example Domain");
      const evidenceDir = join(ws.paths.runsDir, result.runId!, "evidence");
      const records = await Promise.all((await readdir(evidenceDir)).map(async (f) => JSON.parse(await readFile(join(evidenceDir, f), "utf8"))));
      const fetches = records.filter((r) => r.kind === "web_fetch");
      assert.ok(fetches.some((f) => f.host === "example.com" && !f.refused), JSON.stringify(fetches));
      assert.ok(records.some((r) => r.kind === "tool_call" && r.verdict === "relayed"), "the call went through the gateway");
      const providerHost = new URL(baseUrl!).hostname;
      const lines = (await Promise.all((await filesUnder(join(ws.paths.varDir, "egress"))).filter((f) => f.endsWith("egress.jsonl")).map((f) => readFile(f, "utf8")))).join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      for (const l of lines) assert.ok(l.host === providerHost || l.host === "host.docker.internal", JSON.stringify(l));
      const secret = process.env[keyEnv]!;
      for (const f of await filesUnder(join(root, ".legion-flow"))) assert.equal((await readFile(f)).includes(secret), false, `the key's value is in ${f}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("live adapter: codex through an OpenAI-compatible provider on vm-docker (LF_LIVE_OPENAI_BASE_URL)", async () => {
  const openaiBase = process.env.LF_LIVE_OPENAI_BASE_URL;
  let skip: string | undefined;
  if (process.env.LF_LIVE_ADAPTER_TESTS !== "1") skip = "set LF_LIVE_ADAPTER_TESTS=1 to make real model requests";
  else if (!openaiBase) skip = "set LF_LIVE_OPENAI_BASE_URL to the provider's OpenAI-compatible (Responses API) root";
  else if (!process.env[keyEnv]) skip = `${keyEnv} is not set`;

  test("one codex task run writes the asked file, the check passes, R0 applies, usage is parsed, the only egress host is the provider, and the key's value is in no record", { skip, timeout: 900_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "legion-flow-live-codex-"));
    const ws = Workspace.at(root);
    const ctx = { cwd: root, isTTY: false, workspace: ws };
    try {
      await writeFile(join(root, "check.js"), `const t = require("fs").readFileSync("hello.txt", "utf8").trim(); if (t !== ${JSON.stringify(EXPECTED)}) { console.error("got: " + JSON.stringify(t)); process.exit(1); }\n`);
      await initCommand(ctx, { adapter: "codex", name: "Live codex", owner: "lead" });
      const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
      cfg.defaultRiskTier = "R0";
      cfg.adapter.http = { baseUrl: openaiBase, apiKeyEnv: keyEnv, model, contextWindow: Number(process.env.LF_LIVE_CONTEXT_WINDOW ?? 1048576) };
      await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2), "utf8");
      const created = await specCommand(ctx, { new: "Live codex" });
      const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
      const spec = JSON.parse(await readFile(specJson, "utf8"));
      spec.acceptanceCriteria = [{ id: "AC-01", statement: `hello.txt contains exactly the line "${EXPECTED}"`, kind: "behavior" }];
      await writeFile(specJson, JSON.stringify(spec, null, 2), "utf8");
      await approveCommand(ctx, { subject: "spec", approver: "lead" });
      const plan = await planCommand(ctx, { new: true });
      const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
      const p = JSON.parse(await readFile(planJson, "utf8"));
      p.tasks = [{ id: "T-01", title: `Create hello.txt containing exactly the line: ${EXPECTED}`, acceptanceIds: ["AC-01"], contract: { filesAllowed: ["hello.txt"], verificationCommands: [`${node} check.js`] } }];
      await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");
      await approveCommand(ctx, { subject: "plan", approver: "lead", check: [`${node} check.js`] });

      const result = await executeCommand(ctx, { installSignalHandlers: false, adapterTimeoutMs: 600_000 });
      assert.equal(result.status, "ok", JSON.stringify(result.diagnostics, null, 2));
      const evidenceDir = join(ws.paths.runsDir, result.runId!, "evidence");
      const records = await Promise.all((await readdir(evidenceDir)).map(async (f) => JSON.parse(await readFile(join(evidenceDir, f), "utf8"))));
      const outcome = records.find((r) => r.kind === "adapter_outcome");
      const written = await readFile(join(root, "hello.txt"), "utf8").catch(() => null);
      assert.equal(written?.trim(), EXPECTED, `hello.txt not as asked. diagnostics: ${JSON.stringify(result.diagnostics)} stdout: ${String(outcome?.stdoutTail).slice(-2500)} stderr: ${String(outcome?.stderrTail).slice(-1500)}`);
      assert.equal(outcome?.exitCode, 0);
      assert.equal(outcome?.usage?.known, true, JSON.stringify(outcome?.usage));
      assert.equal(outcome?.usage?.costUsd, null);
      const providerHost = new URL(openaiBase!).hostname;
      const lines = (await Promise.all((await filesUnder(join(ws.paths.varDir, "egress"))).filter((f) => f.endsWith("egress.jsonl")).map((f) => readFile(f, "utf8")))).join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.length > 0);
      for (const l of lines) assert.equal(l.host, providerHost, JSON.stringify(l));
      const secret = process.env[keyEnv]!;
      for (const f of await filesUnder(join(root, ".legion-flow"))) assert.equal((await readFile(f)).includes(secret), false, `the key's value is in ${f}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
