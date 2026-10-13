/**
 * Mermaid diagrams from map facts. Package level groups modules (the caller
 * says how: by workspace package, or by top directory); module level draws the
 * modules under one directory and collapses everything else into its group.
 * Cycles are red, rule violations red and dashed, layers are boxes. Over the
 * node cap the diagram keeps the most connected nodes and says what it left out.
 */
import type { MapFacts, MapRules, MapViolation } from "@9thlevelsoftware/legion-flow-schema";
import { importCycles, judgedEdges, layerOf } from "./rules.js";

export interface DiagramOptions {
  /** The group a module belongs to at package level (and for collapsed nodes at module level). */
  groupOf: (path: string) => string;
  /** Module level: draw the modules under this directory. */
  scope?: string;
  rules?: MapRules;
  violations?: readonly MapViolation[];
  maxNodes?: number;
}

export interface Diagram {
  mermaid: string;
  level: "package" | "module";
  nodes: number;
  edges: number;
  omitted: string[];
  cycles: string[][];
}

const label = (s: string) => s.replace(/"/g, "#quot;");

export function renderMapDiagram(facts: MapFacts, options: DiagramOptions): Diagram {
  const maxNodes = options.maxNodes ?? 60;
  const scope = options.scope?.replace(/\/+$/, "");
  const inScope = (p: string) => scope !== undefined && (p === scope || p.startsWith(scope + "/"));
  const nodeOf = (p: string) => (scope !== undefined && inScope(p) ? p : options.groupOf(p));
  const level: Diagram["level"] = scope !== undefined ? "module" : "package";

  const weights = new Map<string, number>();
  const violating = new Set<string>();
  for (const v of options.violations ?? []) if (v.to && (v.rule === "layer" || v.rule === "forbid")) violating.add(`${nodeOf(v.from)}\0${nodeOf(v.to)}`);
  const nodes = new Set<string>();
  for (const m of facts.modules) if (scope === undefined || inScope(m.path)) nodes.add(nodeOf(m.path));
  for (const e of judgedEdges(facts, options.rules ?? {})) {
    if (scope !== undefined && !inScope(e.from) && !inScope(e.resolved!)) continue;
    const a = nodeOf(e.from);
    const b = nodeOf(e.resolved!);
    if (a === b) continue;
    nodes.add(a);
    nodes.add(b);
    weights.set(`${a}\0${b}`, (weights.get(`${a}\0${b}`) ?? 0) + 1);
  }

  // Keep the most connected nodes under the cap; ties break by name so the output is stable.
  const degree = new Map<string, number>([...nodes].map((n) => [n, 0]));
  for (const [k, w] of weights) {
    const [a, b] = k.split("\0") as [string, string];
    degree.set(a, degree.get(a)! + w);
    degree.set(b, degree.get(b)! + w);
  }
  const ranked = [...nodes].sort((a, b) => degree.get(b)! - degree.get(a)! || (a < b ? -1 : 1));
  const kept = new Set(ranked.slice(0, maxNodes));
  const omitted = ranked.slice(maxNodes).sort();
  const edges = [...weights.entries()].filter(([k]) => kept.has(k.split("\0")[0]!) && kept.has(k.split("\0")[1]!)).sort(([a], [b]) => (a < b ? -1 : 1));
  const cycles = importCycles([...kept], edges.map(([k]) => ({ from: k.split("\0")[0]!, to: k.split("\0")[1]! })));
  const inCycle = new Map<string, number>();
  cycles.forEach((c, i) => c.forEach((n) => inCycle.set(n, i)));

  const ids = new Map<string, string>([...kept].sort().map((n, i) => [n, `n${i}`]));
  const lines = ["flowchart LR"];
  if (omitted.length) lines.push(`  %% ${omitted.length} node(s) omitted over the cap of ${maxNodes}`);
  const layered = new Map<string, string[]>();
  const loose: string[] = [];
  // A node sits in the layer most of its modules belong to; a node split evenly, or in none, is drawn outside every layer box.
  const votes = new Map<string, Map<string, number>>();
  if (options.rules) for (const m of facts.modules) {
    const l = layerOf(options.rules, m.path);
    if (!l) continue;
    const n = nodeOf(m.path);
    const v = votes.get(n) ?? votes.set(n, new Map()).get(n)!;
    v.set(l, (v.get(l) ?? 0) + 1);
  }
  const layerOfNode = (n: string): string | undefined => {
    const v = [...(votes.get(n) ?? new Map<string, number>()).entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    return v.length === 0 || (v.length > 1 && v[0]![1] === v[1]![1]) ? undefined : v[0]![0];
  };
  for (const n of [...kept].sort()) {
    const layer = layerOfNode(n);
    if (layer) (layered.get(layer) ?? layered.set(layer, []).get(layer)!).push(n);
    else loose.push(n);
  }
  const nodeLine = (n: string) => `    ${ids.get(n)}["${label(n)}"]`;
  for (const [layer, members] of [...layered.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  subgraph L_${layer.replace(/[^a-zA-Z0-9_]/g, "_")}["layer ${label(layer)}"]`);
    for (const n of members) lines.push(nodeLine(n));
    lines.push("  end");
  }
  for (const n of loose) lines.push(nodeLine(n).slice(2));
  const styles: string[] = [];
  edges.forEach(([k, w], i) => {
    const [a, b] = k.split("\0") as [string, string];
    lines.push(`  ${ids.get(a)} -->|${w}| ${ids.get(b)}`);
    const cyc = inCycle.has(a) && inCycle.get(a) === inCycle.get(b);
    if (violating.has(k)) styles.push(`  linkStyle ${i} stroke:#c0392b,stroke-width:2px,stroke-dasharray:6 4`);
    else if (cyc) styles.push(`  linkStyle ${i} stroke:#c0392b,stroke-width:2px`);
  });
  lines.push(...styles);
  return { mermaid: lines.join("\n") + "\n", level, nodes: kept.size, edges: edges.length, omitted, cycles };
}
