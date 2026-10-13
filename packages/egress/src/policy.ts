import type { EgressRoute } from "@9thlevelsoftware/legion-flow-schema";

export type PolicyDecision =
  | { kind: "allow"; route: EgressRoute; upstreamPath: string }
  | { kind: "deny"; reason: string; status: number };

const PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ALIAS = /^[a-z][a-z0-9_-]*$/;
const HOST = /^(?!.*[*/:@\s])[A-Za-z0-9.-]+$/;
const HEADER = /^[A-Za-z0-9-]+$/;
const REF = /^env:[A-Z_][A-Z0-9_]*$/;
const BASE_PATH = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/;

/**
 * Validate a route list structurally and refuse duplicate aliases. This runs
 * inside the proxy container too, so it is dependency-free: the same rules as
 * `EgressRouteSchema`, restated without zod. The CLI validates with the schema
 * first; this is the proxy's own refusal to start on a malformed list.
 */
export function validateRoutes(routes: readonly unknown[]): EgressRoute[] {
  if (!Array.isArray(routes)) throw new Error("egress_routes_invalid: routes must be an array");
  const out: EgressRoute[] = [];
  const seen = new Map<string, EgressRoute>();
  routes.forEach((raw, i) => {
    const r = raw as Record<string, unknown>;
    const where = `route[${i}]`;
    if (typeof r !== "object" || r === null) throw new Error(`egress_routes_invalid: ${where} is not an object`);
    if (typeof r.alias !== "string" || !ALIAS.test(r.alias)) throw new Error(`egress_routes_invalid: ${where}.alias must match ${ALIAS}`);
    if (typeof r.host !== "string" || !HOST.test(r.host)) throw new Error(`egress_routes_invalid: ${where}.host must be a bare hostname or IP (no scheme, path, or wildcard)`);
    if (r.port !== undefined && (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535)) throw new Error(`egress_routes_invalid: ${where}.port out of range`);
    const scheme = r.scheme === undefined ? "https" : r.scheme;
    if (scheme !== "https" && scheme !== "http") throw new Error(`egress_routes_invalid: ${where}.scheme must be https or http`);
    const secrets = r.secrets === undefined ? [] : r.secrets;
    if (!Array.isArray(secrets)) throw new Error(`egress_routes_invalid: ${where}.secrets must be an array`);
    const parsedSecrets = secrets.map((s, j) => {
      const x = s as Record<string, unknown>;
      if (typeof x.header !== "string" || !HEADER.test(x.header)) throw new Error(`egress_routes_invalid: ${where}.secrets[${j}].header is not a header name`);
      if (typeof x.ref !== "string" || !REF.test(x.ref)) throw new Error(`egress_routes_invalid: ${where}.secrets[${j}].ref must be env:NAME, never a value`);
      if (x.prefix !== undefined && typeof x.prefix !== "string") throw new Error(`egress_routes_invalid: ${where}.secrets[${j}].prefix must be a string`);
      return { header: x.header, ref: x.ref, ...(x.prefix !== undefined ? { prefix: x.prefix } : {}) };
    });
    if (r.basePath !== undefined && (typeof r.basePath !== "string" || !BASE_PATH.test(r.basePath))) throw new Error(`egress_routes_invalid: ${where}.basePath must look like /seg or /seg/seg (no trailing slash, no dot segments)`);
    const known = new Set(["alias", "host", "port", "scheme", "basePath", "secrets"]);
    for (const key of Object.keys(r)) if (!known.has(key)) throw new Error(`egress_routes_invalid: ${where}.${key} is not a route field`);
    const route: EgressRoute = { alias: r.alias, host: r.host, ...(r.port !== undefined ? { port: r.port as number } : {}), scheme, ...(r.basePath !== undefined ? { basePath: r.basePath as string } : {}), secrets: parsedSecrets };
    const prior = seen.get(route.alias);
    if (prior) throw new Error(`egress_route_conflict: alias '${route.alias}' is declared twice (${prior.host} and ${route.host})`);
    seen.set(route.alias, route);
    out.push(route);
  });
  return out;
}

/**
 * Deny-all by construction: a request is forwarded only when its first path
 * segment names a route. Everything else, including CONNECT (raw TLS cannot
 * have a header set outside the agent), is refused with a reason.
 */
export function evaluatePolicy(routes: readonly EgressRoute[], method: string, url: string): PolicyDecision {
  const m = method.toUpperCase();
  if (m === "CONNECT") return { kind: "deny", reason: "CONNECT tunnels are not supported: raw TLS cannot carry a secret set outside the agent", status: 405 };
  if (!PROXY_METHODS.has(m)) return { kind: "deny", reason: `method ${m} is not proxied`, status: 405 };
  const q = url.indexOf("?");
  const path = q >= 0 ? url.slice(0, q) : url;
  if (path === "/healthz") return { kind: "deny", reason: "health endpoint", status: 200 };
  const match = /^\/([a-z][a-z0-9_-]*)(\/.*)?$/.exec(path);
  if (!match) return { kind: "deny", reason: "no route alias in the path; routes are addressed as /<alias>/...", status: 403 };
  const route = routes.find((r) => r.alias === match[1]);
  if (!route) return { kind: "deny", reason: `alias '${match[1]}' is not an allowlisted route`, status: 403 };
  const rest = match[2] && match[2].length > 0 ? match[2] : "/";
  // basePath is a prefix (M4 slice y): /<alias>/v1/messages goes to <basePath>/v1/messages, and a bare /<alias> to <basePath>/.
  return { kind: "allow", route, upstreamPath: route.basePath ? route.basePath + rest : rest };
}

/** The variable names a route list needs, in order, deduplicated. */
export function secretRefs(routes: readonly EgressRoute[]): string[] {
  const names: string[] = [];
  for (const r of routes) for (const s of r.secrets) {
    const name = s.ref.slice("env:".length);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function upstreamOrigin(route: EgressRoute): string {
  const port = route.port ?? (route.scheme === "https" ? 443 : 80);
  const defaultPort = route.scheme === "https" ? 443 : 80;
  return `${route.scheme}://${route.host}${port === defaultPort ? "" : `:${port}`}`;
}
