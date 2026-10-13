import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Approval, type RiskTier } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, configFingerprint, newId } from "@9thlevelsoftware/legion-flow-persist";

/** Build a project through the persist stores directly; gates tests may not import cli. */
export async function projectWithApprovedPlan(root: string, options: { tier?: RiskTier; taskChecks?: string[]; receiptChecks?: string[]; coverAll?: boolean } = {}) {
  await mkdir(root, { recursive: true });
  const ws = Workspace.at(root);

  const spec = await ws.lock.withLock(async (held) => {
    await ws.project.create({ name: "G", adapterId: "fake", ownerId: "lead" }, held);
    const c = await ws.specs.create("Gated", held);
    await ws.project.setCurrent({ specId: c.spec.id }, held);
    return c;
  }, "fixture");

  if (options.tier && options.tier !== "R1") {
    const projectPath = ws.paths.projectConfig;
    const config = JSON.parse(await readFile(projectPath, "utf8"));
    config.defaultRiskTier = options.tier;
    await writeFile(projectPath, JSON.stringify(config, null, 2), "utf8");
  }

  const specJson = join(spec.dir, "spec.json");
  const s = JSON.parse(await readFile(specJson, "utf8"));
  s.acceptanceCriteria = [
    { id: "AC-01", statement: "one", kind: "behavior" },
    { id: "AC-02", statement: "two", kind: "test" },
  ];
  await writeFile(specJson, JSON.stringify(s, null, 2), "utf8");

  const approve = async (subject: "spec" | "plan", subjectId: string, fingerprints: Approval["fingerprints"], checks?: string[]) => {
    const receipt: Approval = {
      schema: SCHEMA_VERSIONS.APPROVAL,
      id: newId("apv"),
      subject,
      subjectId,
      fingerprints,
      ...(checks ? { checks } : {}),
      decidedBy: { id: "lead", displayName: "lead", kind: "human" },
      decidedAt: new Date().toISOString(),
      source: "tty",
      idempotencyKey: `${subjectId}:${subject}`,
    };
    await ws.lock.withLock((held) => ws.approvals.record(receipt, held), "fixture");
    return receipt;
  };

  const specNow = await ws.specs.current();
  const project0 = await ws.project.load();
  if (!specNow || specNow.kind !== "valid" || project0.kind !== "valid") throw new Error("fixture: spec");
  await approve("spec", specNow.id, { spec: specNow.fingerprint, config: configFingerprint(project0.config) });

  const plan = await ws.lock.withLock(async (held) => {
    const p = await ws.plans.create({ id: specNow.id, fingerprint: specNow.fingerprint }, held);
    await ws.project.setCurrent({ planId: p.plan.id }, held);
    return p;
  }, "fixture");
  const planJson = join(plan.dir, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [
    {
      id: "T-01",
      title: "one",
      acceptanceIds: options.coverAll === false ? ["AC-01"] : ["AC-01", "AC-02"],
      contract: { filesAllowed: ["src/a.ts"], verificationCommands: options.taskChecks ?? [] },
    },
  ];
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");

  const planNow = await ws.plans.current();
  const project1 = await ws.project.load();
  if (!planNow || planNow.kind !== "valid" || project1.kind !== "valid") throw new Error("fixture: plan");
  const receipt = await approve(
    "plan",
    planNow.id,
    { spec: specNow.fingerprint, plan: planNow.fingerprint, config: configFingerprint(project1.config) },
    options.receiptChecks ?? ['node -e "process.exit(0)"']
  );

  return { ws, spec: specNow, plan: planNow, planReceipt: receipt };
}
