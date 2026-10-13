import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, cp, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { ResultEnvelopeSchema, BundleManifestSchema } from "@9thlevelsoftware/legion-flow-schema";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { initCommand, specCommand, planCommand, approveCommand, shipCommand } from "../dist/index.js";
import { loadSigningKey } from "../dist/bundle-command.js";

const node = `"${process.execPath}"`;

describe("M4 slice (h): ship --bundle, --sign, --verify", () => {
  let root: string;
  let out: string;
  let keys: string;
  let ws: Workspace;
  const ctx = (isTTY = false) => ({ cwd: root, isTTY, workspace: ws });
  const codes = (env: { diagnostics: { code: string }[] }) => env.diagnostics.map((d) => d.code);
  const verify = async (dir: string, pubkey?: string) => {
    const empty = await mkdtemp(join(tmpdir(), "legion-flow-verifier-"));
    try {
      // No .legion-flow here: verification reads only the bundle and the key.
      return ResultEnvelopeSchema.parse(await shipCommand({ cwd: empty, isTTY: false, workspace: Workspace.at(empty) }, { verify: dir, ...(pubkey ? { pubkey } : {}) }));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  };
  const pair = (name: string, passphrase?: string) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const priv = join(keys, `${name}.pem`);
    const pub = join(keys, `${name}.pub.pem`);
    return Promise.all([
      writeFile(priv, privateKey.export({ type: "pkcs8", format: "pem", ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}) }) as string),
      writeFile(pub, publicKey.export({ type: "spki", format: "pem" }) as string),
    ]).then(() => ({ priv, pub }));
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "legion-flow-bundle-ws-"));
    out = await mkdtemp(join(tmpdir(), "legion-flow-bundle-out-"));
    keys = await mkdtemp(join(tmpdir(), "legion-flow-bundle-keys-"));
    ws = Workspace.at(root);
    await writeFile(join(root, "check.cjs"), 'process.exit(require("fs").existsSync("ok.txt") ? 0 : 1);\n');
    await initCommand(ctx(), { adapter: "fake", name: "Bundle", owner: "lead" });
    const created = await specCommand(ctx(), { new: "Bundle" });
    const specJson = join(created.diagnostics.find((d) => d.code === "spec_created")!.path!, "spec.json");
    const spec = JSON.parse(await readFile(specJson, "utf8"));
    spec.acceptanceCriteria = [{ id: "AC-01", statement: "it works", kind: "behavior" }];
    await writeFile(specJson, JSON.stringify(spec, null, 2) + "\n");
    await approveCommand(ctx(), { subject: "spec", approver: "lead" });
    const plan = await planCommand(ctx(), { new: true });
    const planJson = join(plan.diagnostics.find((d) => d.code === "plan_created")!.path!, "plan.json");
    const p = JSON.parse(await readFile(planJson, "utf8"));
    p.tasks = [{ id: "T-01", title: "do it", acceptanceIds: ["AC-01"], contract: { filesAllowed: ["src/a.ts"], verificationCommands: [] } }];
    await writeFile(planJson, JSON.stringify(p, null, 2) + "\n");
    const approved = await approveCommand(ctx(), { subject: "plan", approver: "lead", check: [`${node} check.cjs`] });
    assert.equal(approved.status, "ok", JSON.stringify(approved.diagnostics));
  });

  after(async () => {
    for (const d of [root, out, keys]) await rm(d, { recursive: true, force: true });
  });

  test("a blocked evaluation still bundles and stays blocked; the bundle verifies anywhere, says not ready, and holds no record of its own writing", async () => {
    const blocked = ResultEnvelopeSchema.parse(await shipCommand(ctx(), { bundle: join(out, "blocked") }));
    assert.equal(blocked.status, "blocked");
    assert.ok(codes(blocked).includes("ship_bundle"), JSON.stringify(blocked.diagnostics));
    const v = await verify(join(out, "blocked"));
    assert.equal(v.status, "ok", JSON.stringify(v.diagnostics));
    assert.match(v.diagnostics.find((d) => d.code === "bundle_integrity")!.message, /Integrity valid: .* not ready/);
    assert.match(v.diagnostics.find((d) => d.code === "bundle_authenticity")!.message, /Not signed/);
    assert.equal(v.gates.length, blocked.gates.length, "the bundled verdicts come back in the gates slot");
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(out, "blocked", "manifest.json"), "utf8")));
    assert.ok(manifest.members.some((m) => m.path === "audit/events.jsonl"));
    assert.ok(manifest.members.some((m) => m.path === "project.json"));
    assert.ok(manifest.members.some((m) => /^specs\/[^/]+\/SPEC\.md$/.test(m.path)));
    assert.ok(manifest.members.some((m) => /^approvals\//.test(m.path)));
    const bundled = await readFile(join(out, "blocked", "audit", "events.jsonl"), "utf8");
    assert.ok(!bundled.includes("bundle_written"));
    assert.ok((await readFile(ws.paths.eventsJsonl, "utf8")).includes("bundle_written"));
  });

  test("tampering is invalid: an edited member, a dropped member, an extra file, a manifest out of canonical form", async () => {
    const src = join(out, "blocked");
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(src, "manifest.json"), "utf8")));
    const verdict = manifest.members.find((m) => m.path.includes("/verdicts/"))!.path;
    const cases: [string, (d: string) => Promise<void>, RegExp][] = [
      ["edited", (d) => writeFile(join(d, ...verdict.split("/")), "{}"), /does not match its hash|bytes, the manifest says/],
      ["dropped", (d) => unlink(join(d, "project.json")), /project\.json is missing/],
      ["extra", (d) => writeFile(join(d, "notes.txt"), "hi"), /notes\.txt is not listed/],
      ["spaced", async (d) => writeFile(join(d, "manifest.json"), JSON.stringify(manifest, null, 2)), /not in canonical form/],
    ];
    for (const [name, mutate, expect] of cases) {
      const d = join(out, `tamper-${name}`);
      await cp(src, d, { recursive: true });
      await mutate(d);
      const v = await verify(d);
      assert.equal(v.status, "blocked", name);
      assert.match(v.diagnostics.filter((x) => x.code === "bundle_problem").map((x) => x.message).join("\n"), expect, name);
    }
  });

  test("ready, committed, signed: verified with the signer's key, invalid with another, and a key on an unsigned bundle blocks", async () => {
    await writeFile(join(root, "ok.txt"), "ok\n");
    const signer = await pair("signer");
    const other = await pair("other");
    const shipped = ResultEnvelopeSchema.parse(await shipCommand(ctx(true), { commit: true, approver: "lead", bundle: join(out, "signed"), sign: true, key: signer.priv }));
    assert.equal(shipped.status, "ok", JSON.stringify(shipped.diagnostics));
    assert.ok(codes(shipped).includes("shipped"));
    assert.match(shipped.diagnostics.find((d) => d.code === "ship_bundle_signed")!.message, /Signed by lead with key [0-9a-f]{16}/);
    const good = await verify(join(out, "signed"), signer.pub);
    assert.equal(good.status, "ok", JSON.stringify(good.diagnostics));
    assert.match(good.diagnostics.find((d) => d.code === "bundle_authenticity")!.message, /Signature verified/);
    assert.match(good.diagnostics.find((d) => d.code === "bundle_integrity")!.message, /release rel_/);
    const bad = await verify(join(out, "signed"), other.pub);
    assert.equal(bad.status, "blocked");
    assert.match(bad.diagnostics.filter((d) => d.code === "bundle_problem").map((d) => d.message).join(), /not the key given/);
    assert.equal((await verify(join(out, "blocked"), signer.pub)).status, "blocked", "a key was given but nothing is signed");
    const unpinned = await verify(join(out, "signed"));
    assert.equal(unpinned.status, "ok");
    assert.match(unpinned.diagnostics.find((d) => d.code === "bundle_authenticity")!.message, /no --pubkey was given/);
    const events = await readFile(ws.paths.eventsJsonl, "utf8");
    assert.ok(events.includes("bundle_signed"));
    assert.ok(!events.includes(keys.replace(/\\/g, "\\\\")) && !events.includes(out.replace(/\\/g, "\\\\")), "no host path in the audit chain");

    // Re-export the release, then a source edit stops it.
    const release = shipped.diagnostics.find((d) => d.code === "shipped")!.message.match(/rel_[0-9a-z]+/)![0];
    const again = await shipCommand(ctx(), { bundle: join(out, "re-export"), release });
    assert.equal(again.status, "ok", JSON.stringify(again.diagnostics));
    assert.equal((await verify(join(out, "re-export"))).status, "ok");
    const current = await ws.specs.current();
    assert.equal(current?.kind, "valid");
    const specMd = join((current as { dir: string }).dir, "SPEC.md");
    const original = await readFile(specMd, "utf8");
    await writeFile(specMd, original + "\nedited after shipping\n");
    try {
      assert.equal((await shipCommand(ctx(), { bundle: join(out, "re-export-2"), release })).diagnostics.at(-1)?.code, "release_sources_changed");
    } finally {
      await writeFile(specMd, original);
    }
  });

  test("keys: inside the workspace, encrypted without a terminal, a wrong passphrase; an encrypted key with its passphrase signs", async () => {
    const inWs = join(root, "inside.pem");
    await writeFile(inWs, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    const refusedInside = await shipCommand(ctx(true), { bundle: join(out, "k1"), sign: true, key: inWs, approver: "lead" });
    assert.equal(refusedInside.diagnostics[0]?.code, "signing_key_inside_workspace");
    await unlink(inWs);
    const locked = await pair("locked", "correct horse");
    assert.equal((await shipCommand(ctx(false), { bundle: join(out, "k2"), sign: true, key: locked.priv, approver: "lead" })).diagnostics[0]?.code, "signing_requires_tty");
    const noTty = await loadSigningKey(ws, root, locked.priv, false, async () => Buffer.from("correct horse"));
    assert.equal(noTty.ok ? "ok" : noTty.refusal.code, "signing_key_passphrase_requires_tty");
    const wrong = await shipCommand(ctx(true), { bundle: join(out, "k3"), sign: true, key: locked.priv, approver: "lead", readPassphrase: async () => Buffer.from("wrong") });
    assert.equal(wrong.diagnostics[0]?.code, "signing_key_refused");
    const signed = await shipCommand(ctx(true), { bundle: join(out, "k4"), sign: true, key: locked.priv, approver: "lead", readPassphrase: async () => Buffer.from("correct horse") });
    assert.ok(codes(signed).includes("ship_bundle_signed"), JSON.stringify(signed.diagnostics));
    assert.equal((await verify(join(out, "k4"), locked.pub)).status, "ok");
  });

  test("destinations and flag grammar", async () => {
    await mkdir(join(out, "taken"));
    assert.equal((await shipCommand(ctx(), { bundle: join(out, "taken") })).diagnostics[0]?.code, "bundle_destination_exists");
    assert.equal((await shipCommand(ctx(), { bundle: join(ws.paths.varDir, "b") })).diagnostics[0]?.code, "bundle_destination_inside_state");
    assert.equal((await shipCommand(ctx(), { bundle: "release-bundle" })).diagnostics[0]?.code, "bundle_destination_in_tree");
    const usage = async (opts: Record<string, unknown>) => (await shipCommand(ctx(true), opts)).diagnostics[0]?.code;
    assert.equal(await usage({ release: "rel_x" }), "release_needs_bundle");
    assert.equal(await usage({ bundle: join(out, "u1"), sign: true, approver: "lead" }), "sign_needs_bundle_and_key");
    assert.equal(await usage({ bundle: join(out, "u2"), key: "k.pem" }), "key_needs_sign");
    assert.equal(await usage({ pubkey: "p.pem" }), "pubkey_needs_verify");
    assert.equal(await usage({ verify: join(out, "blocked"), bundle: join(out, "u3") }), "verify_alone");
    assert.equal(await usage({ bundle: join(out, "u4"), sign: true, key: "k.pem" }), "approver_required");
    assert.equal(await usage({ bundle: join(out, "u5"), release: "rel_x", commit: true, approver: "lead" }), "release_alone");
  });
});
