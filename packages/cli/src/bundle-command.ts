/**
 * `ship --bundle`, `--sign`, and `--verify` (M4 slice h). The writer and verifier
 * live in `evidence`; this module owns what touches the operator's machine: the
 * destination rule, the signing key, and the passphrase prompt.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "@9thlevelsoftware/legion-flow-schema";
import { detectTreeMode, type HeldLock, type Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { BundleError, verifyBundle, writeBundle, type BundleSigner, type BundleVerification } from "@9thlevelsoftware/legion-flow-evidence";

const KEY_MAX_BYTES = 64 * 1024;
const PASSPHRASE_MAX_BYTES = 4096;

export type Refusal = { code: string; message: string; hint?: string };

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The realpath of a path that may not exist yet: its nearest existing ancestor, resolved, plus the rest. */
async function realpathLoose(p: string): Promise<string> {
  const rest: string[] = [];
  let at = resolve(p);
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(p);
      rest.push(at.slice(parent.length).replace(/^[\\/]+/, ""));
      at = parent;
    }
  }
}

/**
 * Where a bundle may go: never inside `.legion-flow/`, and inside the workspace only
 * where git ignores it, because a bundle in the tree would enter the next
 * materialized copy and move the source fingerprint.
 */
export async function bundleDestinationProblem(ws: Workspace, cwd: string, dest: string): Promise<Refusal | null> {
  const target = await realpathLoose(resolve(cwd, dest));
  const root = await realpathLoose(ws.root);
  const state = await realpathLoose(ws.paths.root);
  if (inside(target, state)) return { code: "bundle_destination_inside_state", message: "A bundle is never written inside .legion-flow/.", hint: "Choose a directory outside the workspace, or one git ignores." };
  if (await lstat(target).then(() => true, () => false)) return { code: "bundle_destination_exists", message: `${dest} already exists; a bundle is never written over anything.` };
  if (inside(target, root)) {
    const ignored = (await detectTreeMode(ws.root)) === "git" && (await promisify(execFile)("git", ["-C", ws.root, "check-ignore", "-q", "--", relative(root, target).split(sep).join("/")]).then(() => true, () => false));
    if (!ignored) return { code: "bundle_destination_in_tree", message: `${dest} is inside the workspace tree; the bundle would enter the next run's copy and change the source fingerprint.`, hint: "Choose a directory outside the workspace, or one git ignores." };
  }
  return null;
}

/** Read a hidden line from the terminal into a Buffer, prompting on stderr; never stdout. */
export async function readPassphraseFromTty(prompt = "Passphrase for the signing key: "): Promise<Buffer> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("no terminal");
  process.stderr.write(prompt);
  const buf = Buffer.alloc(PASSPHRASE_MAX_BYTES);
  let n = 0;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<Buffer>((done, fail) => {
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) return finish(new Error("cancelled"));
          if (byte === 13 || byte === 10) return finish(null);
          if (byte === 127 || byte === 8) n = Math.max(0, n - 1);
          else if (n < PASSPHRASE_MAX_BYTES) buf[n++] = byte;
          else return finish(new Error("too long"));
        }
      };
      const finish = (err: Error | null) => {
        stdin.off("data", onData);
        process.stderr.write("\n");
        if (err) {
          buf.fill(0);
          fail(err);
        } else {
          const out = Buffer.from(buf.subarray(0, n));
          buf.fill(0);
          done(out);
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/**
 * The signing key: a PKCS8 PEM Ed25519 private key outside the workspace, a regular
 * file with one link, at most 64 KiB. Checked before and after reading. An encrypted
 * key needs a terminal for its passphrase. Any parse failure is one generic refusal.
 */
export async function loadSigningKey(ws: Workspace, cwd: string, keyPath: string, isTTY: boolean, readPassphrase: () => Promise<Buffer>): Promise<{ ok: true; key: KeyObject; publicKey: KeyObject } | { ok: false; refusal: Refusal }> {
  const generic: Refusal = { code: "signing_key_refused", message: "The signing key could not be used.", hint: "It must be a PKCS8 PEM Ed25519 private key, for example from: openssl genpkey -algorithm ed25519 -out <path outside the workspace>" };
  const abs = resolve(cwd, keyPath);
  const root = await realpathLoose(ws.root);
  const check = async (): Promise<Refusal | null> => {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      return { code: "signing_key_missing", message: "The signing key file does not exist." };
    }
    if (!samePath(real, abs)) return { code: "signing_key_unsafe", message: "The signing key path goes through a link; give the file's real path." };
    if (inside(real, root)) return { code: "signing_key_inside_workspace", message: "The signing key is inside the workspace; keep it outside, where no run copy or commit can reach it." };
    const st = await lstat(real);
    if (!st.isFile() || st.nlink !== 1 || st.size > KEY_MAX_BYTES) return { code: "signing_key_unsafe", message: "The signing key must be a regular file with one link, at most 64 KiB." };
    return null;
  };
  const before = await check();
  if (before) return { ok: false, refusal: before };
  const bytes = await readFile(abs);
  let passphrase: Buffer | null = null;
  try {
    const after = await check();
    if (after) return { ok: false, refusal: after };
    let key: KeyObject;
    if (bytes.includes("ENCRYPTED PRIVATE KEY")) {
      if (!isTTY || (readPassphrase === readPassphraseFromTty && !process.stdin.isTTY)) return { ok: false, refusal: { code: "signing_key_passphrase_requires_tty", message: "The signing key is encrypted; its passphrase is read only from a terminal, never from a flag or the environment." } };
      try {
        passphrase = await readPassphrase();
        key = createPrivateKey({ key: bytes, format: "pem", passphrase });
      } catch {
        return { ok: false, refusal: generic };
      }
    } else {
      try {
        key = createPrivateKey({ key: bytes, format: "pem" });
      } catch {
        return { ok: false, refusal: generic };
      }
    }
    if (key.asymmetricKeyType !== "ed25519") return { ok: false, refusal: generic };
    return { ok: true, key, publicKey: createPublicKey(key) };
  } finally {
    bytes.fill(0);
    passphrase?.fill(0);
  }
}

/** Write the bundle and audit it; returns diagnostics, or a refusal for a typed writer failure. */
export async function writeBundleFor(ws: Workspace, held: HeldLock, input: { runId: string; releaseId?: string; dest: string; signer?: BundleSigner }): Promise<{ ok: true; diagnostics: Diagnostic[] } | { ok: false; refusal: Refusal }> {
  try {
    const written = await writeBundle(ws, input);
    await ws.audit.append({ type: "bundle_written", runId: input.runId, releaseId: input.releaseId ?? null, manifestSha256: written.manifestSha256, members: written.manifest.members.length, ready: written.manifest.ready }, held);
    const diagnostics: Diagnostic[] = [{ code: "ship_bundle", severity: "info", message: `Bundle of ${input.runId}${input.releaseId ? ` (release ${input.releaseId})` : ""} written: ${written.manifest.members.length} member(s), manifest sha256 ${written.manifestSha256.slice(0, 16)}, ${written.manifest.ready ? "ready" : "not ready"}. Its audit copy ends before this bundle was recorded.`, path: input.dest }];
    if (input.signer && written.keyId) {
      await ws.audit.append({ type: "bundle_signed", runId: input.runId, releaseId: input.releaseId ?? null, manifestSha256: written.manifestSha256, keyId: written.keyId, signer: input.signer.signerId }, held);
      diagnostics.push({ code: "ship_bundle_signed", severity: "info", message: `Signed by ${input.signer.signerId} with key ${written.keyId.slice(0, 16)} (Ed25519, DSSE over an in-toto statement). A signature authenticates these bytes, not their truth.`, path: join(input.dest, "signature.dsse.json") });
    }
    return { ok: true, diagnostics };
  } catch (err: unknown) {
    if (err instanceof BundleError) return { ok: false, refusal: { code: err.code, message: err.message.slice(err.code.length + 2) } };
    throw err;
  }
}

/** `ship --verify`: reads only the bundle and, when given, a public key. */
export async function verifyBundleAt(cwd: string, dir: string, pubkeyPath?: string): Promise<{ ok: true; result: BundleVerification } | { ok: false; refusal: Refusal }> {
  let publicKey: KeyObject | undefined;
  if (pubkeyPath !== undefined) {
    try {
      const abs = resolve(cwd, pubkeyPath);
      const st = await lstat(abs);
      if (!st.isFile() || st.size > KEY_MAX_BYTES) throw new Error("not a small regular file");
      publicKey = createPublicKey({ key: await readFile(abs), format: "pem" });
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    } catch {
      return { ok: false, refusal: { code: "pubkey_unreadable", message: "The public key could not be read; it must be an SPKI PEM Ed25519 public key.", hint: "openssl pkey -in <private.pem> -pubout -out <public.pem>" } };
    }
  }
  return { ok: true, result: await verifyBundle(resolve(cwd, dir), publicKey ? { publicKey } : {}) };
}
