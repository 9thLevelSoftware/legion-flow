/**
 * The browser image (M4 slice o2): built locally from a Dockerfile Legion writes,
 * never pulled. Chromium's headless shell is installed by the same playwright-core
 * version this package depends on, so the driver and the browser always match; a
 * test holds the constant to package.json.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const BROWSER_PLAYWRIGHT_VERSION = "1.64.0";
/** Where the image keeps its global playwright-core; the container entry loads it by this path (ESM ignores NODE_PATH). */
export const BROWSER_IMAGE_PLAYWRIGHT_PATH = "/usr/local/lib/node_modules/playwright-core";
/** Where this package's dist is mounted, read-only, inside the browser container. */
export const BROWSER_GUEST_DIR = "/legion/browser";
export const BROWSER_MAIN = "browser-mcp-main.js";

export function browserImageTag(version = BROWSER_PLAYWRIGHT_VERSION): string {
  return `legion-flow-browser:playwright-${version}`;
}

export function browserDockerfile(version = BROWSER_PLAYWRIGHT_VERSION): string {
  return [
    `# legion-flow browser image (M4 slice o2): Chromium headless shell matching playwright-core ${version}.`,
    "FROM node:22-bookworm-slim",
    "ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    `RUN npm install -g playwright-core@${version} \\`,
    " && playwright-core install --with-deps --only-shell chromium \\",
    " && chmod -R a+rX /ms-playwright \\",
    " && rm -rf /var/lib/apt/lists/* /root/.npm",
    "USER node",
    "",
  ].join("\n");
}

/** This package's compiled files; mounted read-only into the browser container. */
export function browserDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
