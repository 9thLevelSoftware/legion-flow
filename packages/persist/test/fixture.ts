import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSIONS, type Approval } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace, configFingerprint, newId } from "../dist/index.js";

/** A project at plan_ready, built through the stores only. */
export async function projectAtPlanReady(root: string) {
  await mkdir(root, { recursive: true });
  const ws = Workspace.at(root);

  const spec = await ws.lock.withLock(async (held) => {
    await ws.project.create({ name: "F", adapterId: "fake", ownerId: "lead" }, held);
    const c = await ws.specs.create("Fixture", held);
    await ws.project.setCurrent({ specId: c.spec.id }, held);
    return c;
  }, "fixture");
  const specJson = join(spec.dir, "spec.json");
  const s = JSON.parse(await readFile(specJson, "utf8"));
  s.acceptanceCriteria = [{ id: "AC-01", statement: "one", kind: "behavior" }];
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
  };

  const specNow = await ws.specs.current();
  const p0 = await ws.project.load();
  if (!specNow || specNow.kind !== "valid" || p0.kind !== "valid") throw new Error("fixture: spec");
  await approve("spec", specNow.id, { spec: specNow.fingerprint, config: configFingerprint(p0.config) });

  const plan = await ws.lock.withLock(async (held) => {
    const p = await ws.plans.create({ id: specNow.id, fingerprint: specNow.fingerprint }, held);
    await ws.project.setCurrent({ planId: p.plan.id }, held);
    return p;
  }, "fixture");
  const planJson = join(plan.dir, "plan.json");
  const p = JSON.parse(await readFile(planJson, "utf8"));
  p.tasks = [{ id: "T-01", title: "one", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
  await writeFile(planJson, JSON.stringify(p, null, 2), "utf8");

  const planNow = await ws.plans.current();
  const p1 = await ws.project.load();
  if (!planNow || planNow.kind !== "valid" || p1.kind !== "valid") throw new Error("fixture: plan");
  await approve("plan", planNow.id, { spec: specNow.fingerprint, plan: planNow.fingerprint, config: configFingerprint(p1.config) }, ["node -e 0"]);

  return ws;
}
