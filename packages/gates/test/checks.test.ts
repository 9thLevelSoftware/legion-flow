import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { tokenizeArgv, runCheck } from "../dist/index.js";

describe("check runner (shell-free)", () => {
  test("tokenizer: quotes group, no escaping, no expansion", () => {
    assert.deepEqual(tokenizeArgv('node -e "process.exit(0)"'), ["node", "-e", "process.exit(0)"]);
    assert.deepEqual(tokenizeArgv("a 'b c' d"), ["a", "b c", "d"]);
    assert.deepEqual(tokenizeArgv("  pnpm   run build  "), ["pnpm", "run", "build"]);
    assert.deepEqual(tokenizeArgv("echo $HOME *.ts"), ["echo", "$HOME", "*.ts"]);
    assert.deepEqual(tokenizeArgv(""), []);
  });

  const cwd = tmpdir();
  const node = process.execPath;

  test("exit 0 is satisfied, non-zero is unsatisfied, with output captured", async () => {
    const ok = await runCheck(`"${node}" -e "process.stdout.write('hi'); process.exit(0)"`, { cwd, source: "receipt", timeoutMs: 30_000 });
    assert.equal(ok.status, "satisfied");
    assert.equal(ok.evidence.exitCode, 0);
    assert.equal(ok.evidence.stdout, "hi");
    assert.equal(ok.evidence.viaCmdShim, false);

    const bad = await runCheck(`"${node}" -e "process.stderr.write('no'); process.exit(3)"`, { cwd, source: "task", taskId: "T-01", timeoutMs: 30_000 });
    assert.equal(bad.status, "unsatisfied");
    assert.equal(bad.evidence.exitCode, 3);
    assert.equal(bad.evidence.stderr, "no");
    assert.equal(bad.evidence.taskId, "T-01");
  });

  test("a missing binary and a timeout are unevaluable, never failed", async () => {
    const missing = await runCheck("definitely-not-a-binary-xyz --version", { cwd, source: "receipt", timeoutMs: 30_000 });
    assert.equal(missing.status, "unevaluable");
    assert.match(missing.reason, /not found|could not run/);

    const slow = await runCheck(`"${node}" -e "setTimeout(() => {}, 60000)"`, { cwd, source: "receipt", timeoutMs: 500 });
    assert.equal(slow.status, "unevaluable");
    assert.equal(slow.evidence.timedOut, true);
    assert.match(slow.reason, /timed out/);
  });

  test("Windows shim path (simulated): a .cmd target runs through cmd.exe and refuses cmd-expanded characters", async () => {
    const resolveToCmd = async () => "C:\\fake\\npm.cmd";
    const refused = await runCheck("npm run %THING%", { cwd, source: "receipt", timeoutMs: 30_000, resolveWindowsCommand: resolveToCmd });
    assert.equal(refused.status, "unevaluable");
    assert.equal(refused.evidence.viaCmdShim, true);
    assert.match(refused.reason, /cmd\.exe would expand/);

    const unresolved = await runCheck("ghost --version", { cwd, source: "receipt", timeoutMs: 30_000, resolveWindowsCommand: async () => null });
    assert.equal(unresolved.status, "unevaluable");
    assert.match(unresolved.reason, /not found on PATH/);

    if (process.platform === "win32") {
      const real = await runCheck("npm --version", { cwd, source: "receipt", timeoutMs: 60_000 });
      assert.equal(real.status, "satisfied");
      assert.equal(real.evidence.viaCmdShim, true);
      assert.match(real.evidence.stdout, /^\d+\.\d+/);
    }
  });
});
