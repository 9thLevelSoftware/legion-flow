/**
 * HTTP route facts by syntax alone (M4 slice g). Four detectors, each a pattern a
 * reader can check by eye; nothing is executed or type-checked, so a call that only
 * looks like a route is recorded and a route built at run time is missed. A path that
 * is not a literal is recorded as unresolved with its source text, never guessed.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import type { MapRoute } from "@9thlevelsoftware/legion-flow-schema";

/** Receiver names an Express-style call must use: `app.get("/x", h)`, `router.post(...)`. */
export const ROUTE_RECEIVERS: readonly string[] = ["app", "router", "server", "api", "fastify"];
const CALL_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const NEXT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const UNRESOLVED_MAX = 200;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Method = MapRoute["method"];

function route(module: string, method: Method, detector: MapRoute["detector"], line: number, path: string | undefined, unresolved?: string): MapRoute {
  const key = path !== undefined ? `path\0${path}` : `expr\0${unresolved}`;
  return { id: sha(`route\0${module}\0${method}\0${key}`), module, method, ...(path !== undefined ? { path } : { unresolved }), detector, line };
}

/** A literal path, or the expression text when it is not one; null when it is a literal that is not a path. */
function pathOf(node: ts.Expression, sf: ts.SourceFile): { path: string } | { unresolved: string } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.startsWith("/") ? { path: node.text } : null;
  return { unresolved: node.getText(sf).slice(0, UNRESOLVED_MAX) };
}

const isHandler = (n: ts.Node | undefined) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

/** The URL path a Next.js file serves, from its place under `app/` or `pages/api/`; null when it is neither. */
export function nextRouteOf(module: string): { detector: "next_app" | "next_pages"; path: string } | null {
  const segs = module.split("/");
  const file = segs[segs.length - 1]!;
  const appAt = segs.lastIndexOf("app");
  if (appAt >= 0 && /^route\.(m|c)?(t|j)sx?$/.test(file)) {
    const parts = segs.slice(appAt + 1, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return { detector: "next_app", path: "/" + parts.join("/") };
  }
  const pagesAt = segs.lastIndexOf("pages");
  if (pagesAt >= 0 && segs[pagesAt + 1] === "api" && segs.length > pagesAt + 2) {
    const parts = segs.slice(pagesAt + 1);
    parts[parts.length - 1] = file.replace(/\.(m|c)?(t|j)sx?$/, "");
    if (parts[parts.length - 1] === "index") parts.pop();
    return { detector: "next_pages", path: "/" + parts.join("/") };
  }
  return null;
}

export function routesOf(sf: ts.SourceFile, module: string): MapRoute[] {
  const out: MapRoute[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const next = nextRouteOf(module);
  if (next) {
    for (const stmt of sf.statements) {
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : [];
      const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (next.detector === "next_pages") {
        if ((exported && isDefault) || ts.isExportAssignment(stmt)) out.push(route(module, "any", "next_pages", lineOf(stmt), next.path));
        continue;
      }
      if (!exported) continue;
      const names: string[] = [];
      if (ts.isFunctionDeclaration(stmt) && stmt.name) names.push(stmt.name.text);
      if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
      for (const n of names) if (NEXT_METHODS.has(n)) out.push(route(module, n.toLowerCase() as Method, "next_app", lineOf(stmt), next.path));
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ROUTE_RECEIVERS.includes(node.expression.expression.text)) {
      const name = node.expression.name.text;
      const args = node.arguments;
      if (CALL_METHODS.has(name) && args.length >= 2) {
        const p = pathOf(args[0]!, sf);
        // A non-literal path counts only when a handler function follows it, so `api.get(url, opts)` stays out.
        if (p && ("path" in p || isHandler(args[args.length - 1]))) out.push(route(module, name as Method, "express_call", lineOf(node), "path" in p ? p.path : undefined, "unresolved" in p ? p.unresolved : undefined));
      } else if (name === "route" && args.length === 1 && ts.isObjectLiteralExpression(args[0]!)) {
        const prop = (key: string) => (args[0] as ts.ObjectLiteralExpression).properties.find((pr): pr is ts.PropertyAssignment => ts.isPropertyAssignment(pr) && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) && pr.name.text === key)?.initializer;
        const url = prop("url") ?? prop("path");
        const m = prop("method");
        if (url) {
          const p = pathOf(url, sf);
          const literal = (e: ts.Expression) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text.toLowerCase() : null);
          const raw = !m ? [] : ts.isArrayLiteralExpression(m) ? m.elements.map((e) => literal(e)) : [literal(m)];
          const methods = raw.length > 0 && raw.every((x) => x !== null && CALL_METHODS.has(x)) ? (raw as Method[]) : ["any" as Method];
          if (p) for (const method of [...new Set(methods)]) out.push(route(module, method, "fastify_route", lineOf(node), "path" in p ? p.path : undefined, "unresolved" in p ? p.unresolved : undefined));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
