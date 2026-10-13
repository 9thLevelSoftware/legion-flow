import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSIONS, ApprovalSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { findBrowsers } from "@9thlevelsoftware/legion-flow-browser";
import { initCommand, specCommand, planCommand, approveCommand, executeCommand, shipCommand, browseCommand } from "../dist/index.js";

const SERVER = `const http = require("http");
const fs = require("fs");
http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<h1>" + fs.readFileSync("src/title.txt", "utf8").trim() + "</h1>"); }).listen(Number(process.env.PORT), "127.0.0.1");
`;
const goodScript = { schema: SCHEMA_VERSIONS.BROWSER_SCRIPT, allowedDomains: ["127.0.0.1"], serve: { command: ["node", "server.js"], url: "http://127.0.0.1:{port}/" }, steps: [{ action: "goto", url: "/" }, { action: "expect_text", text: "Hello" }], stepTimeoutMs: 3000 };

async function project(check: string, files: Record<string, string>, tasks: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-bc-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "checks"), { recursive: true });
  for (const [p, body] of Object.entries(files)) await writeFile(join(root, ...p.split("/")), body);
  const ws = Workspace.at(root);
  const ctx = { cwd: root, isTTY: true, workspace: ws };
  await initCommand(ctx, { adapter: "fake", name: "BC", owner: "lead" });
  const cfg = JSON.parse(await readFile(ws.paths.projectConfig, "utf8"));
  cfg.defaultRiskTier = "R0";
  await writeFile(ws.paths.projectConfig, JSON.stringify(cfg, null, 2));
  const created = await specCommand(ctx, { new: "BC" });
  const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
  const spec = JSON.parse(await readFile(specJson, "utf8"));
  spec.acceptanceCriteria = [{ id: "AC-01", statement: "the page greets", kind: "behavior", surface: "real_interface" }];
  await writeFile(specJson, JSON.stringify(spec, null, 2));
  await approveCommand(ctx, { subject: "spec", approver: "lead" });
  const plan = await planCommand(ctx, { new: true });
  const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = tasks;
  await writeFile(planJson, JSON.stringify(p, null, 2));
  const approved = await approveCommand(ctx, { subject: "plan", approver: "lead", check: [check] });
  return { root, ws, ctx, approved };
}

describe("M4 slice (e): browser checks in the plan", () => {
  test("approval refuses a script that types a secret without exact hosts (the exit item), and an invalid one", async () => {
    const unsafe = { schema: SCHEMA_VERSIONS.BROWSER_SCRIPT, allowedDomains: [], steps: [{ action: "fill_secret", selector: "#pw", secretRef: "env:PW" }] };
    const { root, approved } = await project("browser:checks/login.json", { "checks/login.json": JSON.stringify(unsafe) }, [{ id: "T-01", title: "t", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/title.txt"], verificationCommands: [] } }]);
    try {
      assert.equal(approved.status, "refused");
      assert.match(approved.diagnostics.map((d) => d.message).join(" "), /allowedDomains/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const missing = await project("browser:checks/nope.json", {}, [{ id: "T-01", title: "t", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/title.txt"], verificationCommands: [] } }]);
    try {
      assert.equal(missing.approved.diagnostics[0]?.code, "browser_script_invalid");
    } finally {
      await rm(missing.root, { recursive: true, force: true });
    }
  });

  const browsers = findBrowsers();
  test("end to end: the hash is frozen at approval; a task cannot edit the script; execute and ship verify in a real browser; an edited script is never a pass", { skip: browsers.length ? undefined : "no Chrome, Edge, or cached Chromium on this machine" }, async () => {
    const { root, ws, ctx, approved } = await project(
      "browser:checks/home.json",
      { "checks/home.json": JSON.stringify(goodScript), "server.js": SERVER, "src/title.txt": "Hi\n" },
      [{ id: "T-01", title: "greet", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/title.txt", "checks/"], verificationCommands: [] } }]
    );
    try {
      assert.equal(approved.status, "ok", JSON.stringify(approved.diagnostics));
      const receipt = ApprovalSchema.parse(JSON.parse(await readFile(approved.diagnostics.find((d) => d.code === "plan_approved")!.path!, "utf8")));
      assert.deepEqual(Object.keys(receipt.browserScripts ?? {}), ["checks/home.json"]);

      // The agent fixes the title and also tries to weaken the check; the script edit is reverted.
      await writeFile(join(ws.paths.varDir, "fake-adapter.json"), JSON.stringify({ edits: [{ path: "src/title.txt", content: "Hello\n" }, { path: "checks/home.json", content: JSON.stringify({ ...goodScript, steps: [{ action: "goto", url: "/" }] }) }] }));
      const run = await executeCommand(ctx, { sandbox: "unhardened", allowNoSandbox: true, installSignalHandlers: false, adapterTimeoutMs: 60_000 });
      assert.equal(run.status, "ok", JSON.stringify(run.diagnostics));
      assert.equal(JSON.parse(await readFile(join(root, "checks", "home.json"), "utf8")).steps.length, 2, "the approved script was not changed by the run");
      assert.equal(await readFile(join(root, "src", "title.txt"), "utf8"), "Hello\n");

      const shipped = await shipCommand(ctx, {});
      const gate = shipped.gates.find((g) => g.gateId === "deterministic_verification")!;
      assert.equal(gate.status, "satisfied", gate.reason);
      const evidence = await Promise.all(gate.evidence.map(async (e) => JSON.parse(await readFile(join(ws.paths.project, ...e.path.split("/")), "utf8")) as { argv: string[]; browser?: { steps: unknown[] } }));
      assert.ok(evidence.some((e) => e.argv[0] === "browser" && e.browser && e.browser.steps.length === 2), "the browser record is in the check evidence");

      // Someone edits the approved script outside any run: the gate can no longer pass on it.
      await writeFile(join(root, "checks", "home.json"), JSON.stringify({ ...goodScript, steps: [{ action: "goto", url: "/" }] }));
      const after = (await shipCommand(ctx, {})).gates.find((g) => g.gateId === "deterministic_verification")!;
      assert.notEqual(after.status, "satisfied");
      // Either guard may catch it first: the same-tree rule (the checkout drifted) or the script hash.
      assert.match(after.reason, /changed since the plan was approved|not the tree the last applied proposal produced/);

      // Recovery: a human approves the edited script; the newer receipt is the one in force.
      const reapproved = await approveCommand(ctx, { subject: "plan", approver: "lead", check: ["browser:checks/home.json"] });
      assert.equal(reapproved.status, "ok", JSON.stringify(reapproved.diagnostics));
      assert.ok(reapproved.diagnostics.some((d) => d.code === "plan_approved"), "a changed script hash is a new approval, not 'unchanged'");
      const { createHash } = await import("node:crypto");
      const editedHash = createHash("sha256").update(await readFile(join(root, "checks", "home.json"))).digest("hex");
      const planId = receipt.subjectId;
      const inForce = (await ws.approvals.forSubject("plan", planId))[0]!;
      assert.equal(inForce.browserScripts?.["checks/home.json"], editedHash, "the newest receipt, with the edited script hash, is the one every lookup takes first");
      const dry = await browseCommand(ctx, { script: "checks/home.json" });
      assert.equal(dry.status, "ok", JSON.stringify(dry.diagnostics));
      assert.ok(dry.diagnostics.some((d) => d.code === "browse_dry_run"));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
});
