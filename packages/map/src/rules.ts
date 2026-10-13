/**
 * Architecture rules over map facts: layers and allowed directions, forbidden
 * edges, outside-package allow and deny lists, and import cycles. Pure and
 * deterministic; a violation's id never includes how its edge was resolved,
 * so the same edge is the same violation in the checkout and in a sandbox copy.
 */
import { createHash } from "node:crypto";
import { matchesAnyPathPattern, matchesPathPattern, type MapFacts, type MapImport, type MapRules, type MapViolation } from "@9thlevelsoftware/legion-flow-schema";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RESOLVED: readonly MapImport["resolution"][] = ["compiler", "workspace", "heuristic_src", "lsp"];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function rulesSha256(rules: MapRules): string {
  return sha(canonical(rules));
}

export function layerOf(rules: MapRules, path: string): string | undefined {
  return rules.layers.find((l) => matchesAnyPathPattern(path, l.paths))?.name;
}

/** The module-to-module edges the rules judge: resolved, not self, type-only dropped when the rules say so. */
export function judgedEdges(facts: MapFacts, rules: Pick<MapRules, "ignoreTypeOnly"> = {}): MapImport[] {
  return facts.imports.filter((i) => i.resolved && RESOLVED.includes(i.resolution) && i.resolved !== i.from && !(rules.ignoreTypeOnly && i.kind === "type"));
}

/** Strongly connected components with more than one module (Tarjan), each sorted, the list sorted. */
export function importCycles(nodes: readonly string[], edges: readonly { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
  }
  for (const list of adj.values()) list.sort();
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  // Iterative Tarjan so a deep import chain cannot overflow the call stack.
  for (const start of [...adj.keys()].sort()) {
    if (idx.has(start)) continue;
    const work: { node: string; i: number }[] = [{ node: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = adj.get(frame.node)!;
      if (frame.i < succ.length) {
        const w = succ[frame.i++]!;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === idx.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.node);
        if (comp.length > 1) out.push(comp.sort());
      }
    }
  }
  return out.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

export function evaluateRules(facts: MapFacts, rules: MapRules): MapViolation[] {
  const found = new Map<string, MapViolation>();
  const add = (v: Omit<MapViolation, "id">, key: string) => {
    const id = sha(`${v.rule}\0${v.from}\0${key}`);
    if (!found.has(id)) found.set(id, { id, ...v });
  };
  const layer = new Map<string, string | undefined>();
  for (const m of facts.modules) layer.set(m.path, layerOf(rules, m.path));

  if (rules.unlayered === "violation") {
    for (const m of facts.modules) if (!layer.get(m.path)) add({ rule: "unlayered", from: m.path, detail: `${m.path} is in no layer` }, "");
  }

  const edges = judgedEdges(facts, rules);
  for (const e of edges) {
    const to = e.resolved!;
    const fl = layer.get(e.from);
    const tl = layer.get(to) ?? layerOf(rules, to);
    if (fl && tl && fl !== tl) {
      const allowed = rules.allow?.[fl] ?? [];
      if (!allowed.includes("*") && !allowed.includes(tl)) {
        add({ rule: "layer", from: e.from, to, fromLayer: fl, toLayer: tl, resolution: e.resolution, detail: `layer ${fl} may not import layer ${tl}` }, to);
      }
    }
    for (const f of rules.forbid ?? []) {
      if (matchesPathPattern(e.from, f.from) && matchesPathPattern(to, f.to)) {
        add({ rule: "forbid", from: e.from, to, resolution: e.resolution, ...(fl ? { fromLayer: fl } : {}), ...(tl ? { toLayer: tl } : {}), detail: f.reason ?? `${f.from} may not import ${f.to}` }, to);
      }
    }
  }

  for (const i of facts.imports) {
    if (i.resolution !== "external" || !i.package) continue;
    if (rules.ignoreTypeOnly && i.kind === "type") continue;
    const banned = (rules.externalForbid ?? []).find((p) => matchesPathPattern(i.package!, p));
    if (banned) add({ rule: "external_forbid", from: i.from, specifier: i.package, detail: `${i.package} is forbidden (${banned})` }, i.package);
    const fl = layer.get(i.from);
    const allowList = fl ? rules.externalAllow?.[fl] : undefined;
    if (allowList && !allowList.some((p) => matchesPathPattern(i.package!, p))) {
      add({ rule: "external_allow", from: i.from, specifier: i.package, fromLayer: fl, detail: `layer ${fl} may import only ${allowList.join(", ")}` }, i.package);
    }
  }

  if (rules.noCycles) {
    for (const members of importCycles(facts.modules.map((m) => m.path), edges.map((e) => ({ from: e.from, to: e.resolved! })))) {
      add({ rule: "cycle", from: members[0]!, members, detail: `import cycle through ${members.length} modules` }, members.join("\0"));
    }
  }
  return [...found.values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.id < b.id ? -1 : 1));
}

/** Violations in `after` that are not in `before`, those that went away, and the count unchanged; compared by id. */
export function compareViolations(before: readonly MapViolation[], after: readonly MapViolation[]): { introduced: MapViolation[]; resolved: MapViolation[]; unchanged: number } {
  const b = new Set(before.map((v) => v.id));
  const a = new Set(after.map((v) => v.id));
  return { introduced: after.filter((v) => !b.has(v.id)), resolved: before.filter((v) => !a.has(v.id)), unchanged: after.filter((v) => b.has(v.id)).length };
}
