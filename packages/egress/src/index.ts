export { evaluatePolicy, validateRoutes, secretRefs, upstreamOrigin } from "./policy.js";
export type { PolicyDecision } from "./policy.js";
export { createProxyServer, summarizeEgress, parseEgressLog } from "./proxy.js";
export type { ProxyOptions, EgressLogLine, EgressSummary } from "./proxy.js";
export const EGRESS_PORT = 8080;
export const EGRESS_ROUTES_FILE = "egress-routes.json";
export const EGRESS_LOG_FILE = "egress.jsonl";
export const EGRESS_READY_FILE = "egress-ready";
export const EGRESS_FORWARD_FILE = "egress-forward.json";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
/** The directory holding this package's compiled files; mounted read-only into the proxy container. */
export function egressDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
