/**
 * The proxy container's entrypoint. Reads `egress-routes.json` from the run
 * directory (default /legion/run), resolves every secret ref from its own
 * environment, appends `egress.jsonl` beside the routes, writes `egress-ready`
 * when listening, and serves on port 8080. Dependency-free beyond this package.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRoutes, secretRefs } from "./policy.js";
import { createProxyServer } from "./proxy.js";

const runDir = process.env.LF_RUN_DIR ?? "/legion/run";
const port = Number.parseInt(process.env.LF_EGRESS_PORT ?? "8080", 10);

const routes = validateRoutes(JSON.parse(readFileSync(join(runDir, "egress-routes.json"), "utf8")) as unknown[]);
const secrets: Record<string, string> = {};
const missing: string[] = [];
for (const name of secretRefs(routes)) {
  const value = process.env[name];
  if (value === undefined) missing.push(name);
  else secrets[name] = value;
}
if (missing.length > 0) {
  console.error(`egress proxy: secret variables not set: ${missing.join(", ")}`);
  process.exit(78);
}
const logPath = join(runDir, "egress.jsonl");
// Forward mode (M4 slice o2): a sibling file lists the exact hosts a browser may reach through this proxy.
const forwardPath = join(runDir, "egress-forward.json");
const forwardHosts = existsSync(forwardPath) ? (JSON.parse(readFileSync(forwardPath, "utf8")) as unknown[]).filter((h): h is string => typeof h === "string" && /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(h)) : undefined;
const server = createProxyServer({ routes, secrets, log: (line) => appendFileSync(logPath, JSON.stringify(line) + "\n"), ...(forwardHosts ? { forwardHosts } : {}) });
server.listen(port, "0.0.0.0", () => {
  writeFileSync(join(runDir, "egress-ready"), `${new Date().toISOString()} ${port}\n`);
  console.log(`egress proxy listening on ${port} with ${routes.length} route(s): ${routes.map((r) => `${r.alias}->${r.host}`).join(", ")}`);
});
const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
