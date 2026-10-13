/** Helpers shared by browser checks and the gateway's browser server (M4 slice o1). */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PipedProcess } from "@9thlevelsoftware/legion-flow-engine";

export const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
/** Screenshots are stored inline in evidence; a larger one is hashed but not stored. */
export const SCREENSHOT_MAX_BYTES = 1_000_000;
export const keepShot = (png: Buffer) => ({ sha256: sha(png), pngBase64: png.length <= SCREENSHOT_MAX_BYTES ? png.toString("base64") : "" });

export interface BrowserCandidate {
  kind: "chrome" | "msedge" | "chromium";
  executablePath: string;
}

/** Installed Chrome, then Edge, then Playwright's cached Chromium; whatever exists, in that order. Never downloads. */
export function findBrowsers(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): BrowserCandidate[] {
  const out: BrowserCandidate[] = [];
  const add = (kind: BrowserCandidate["kind"], paths: (string | undefined)[]) => {
    for (const p of paths) if (p && existsSync(p)) {
      out.push({ kind, executablePath: p });
      return;
    }
  };
  if (platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = env["LOCALAPPDATA"];
    add("chrome", [join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"), local && join(local, "Google", "Chrome", "Application", "chrome.exe")]);
    add("msedge", [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe")]);
  } else if (platform === "darwin") {
    add("chrome", ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
    add("msedge", ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]);
  } else {
    add("chrome", ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]);
    add("msedge", ["/usr/bin/microsoft-edge", "/opt/microsoft/msedge/msedge"]);
  }
  const cache = env["PLAYWRIGHT_BROWSERS_PATH"] ?? (platform === "win32" ? env["LOCALAPPDATA"] && join(env["LOCALAPPDATA"], "ms-playwright") : platform === "darwin" ? env["HOME"] && join(env["HOME"], "Library", "Caches", "ms-playwright") : env["HOME"] && join(env["HOME"], ".cache", "ms-playwright"));
  if (cache && existsSync(cache)) {
    const revisions = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const r of revisions) {
      const sub = platform === "win32" ? [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]] : platform === "darwin" ? [["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]] : [["chrome-linux", "chrome"], ["chrome-linux64", "chrome"]];
      const hit = sub.map((s) => join(cache, r, ...s)).find((p) => existsSync(p));
      if (hit) {
        out.push({ kind: "chromium", executablePath: hit });
        break;
      }
    }
  }
  return out;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export const SERVE_ENV = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];

/** Stop the served process and everything it started (npm, then node): child.kill leaves grandchildren on Windows. */
export async function killTree(p: PipedProcess): Promise<void> {
  if (process.platform === "win32" && p.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
  }
  await p.kill();
}

export const stripQuery = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "data:" ? "data:" : `${x.origin}${x.pathname}`;
  } catch {
    return u.split("?")[0]!;
  }
};
export const hostOf = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === "::1" ? "[::1]" : h;
  } catch {
    return "";
  }
};

