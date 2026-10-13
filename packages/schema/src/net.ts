const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The one loopback rule: an http or https URL whose host is this machine.
 * Used for the eval judge and the span fan-out, neither of which may leave
 * the host without the egress consent machinery. Null means acceptable.
 */
export function loopbackUrlProblem(raw: string, field: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${field} '${raw}' is not a URL`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${field} must be http or https (got ${url.protocol})`;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return `${field} host '${url.hostname}' is not loopback (127.0.0.1, localhost, [::1])`;
  return null;
}
