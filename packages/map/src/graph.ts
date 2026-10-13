/** Graph questions over map facts held in memory: the proposal's blast radius and a task's context slice. */
import type { BriefMapContext, MapFacts, ProposalImpact } from "@9thlevelsoftware/legion-flow-schema";
import { judgedEdges } from "./rules.js";

export const IMPACT_CAP = 200;

/** Changed modules, what depends on them transitively (capped), and their exported symbols used elsewhere. */
export function impactOf(facts: MapFacts, changedPaths: readonly string[], cap = IMPACT_CAP): ProposalImpact {
  const modules = new Set(facts.modules.map((m) => m.path));
  const changed = [...new Set(changedPaths)].filter((p) => modules.has(p)).sort();
  const reverse = new Map<string, string[]>();
  for (const e of judgedEdges(facts)) (reverse.get(e.resolved!) ?? reverse.set(e.resolved!, []).get(e.resolved!)!).push(e.from);
  const seen = new Map<string, number>(changed.map((p) => [p, 0]));
  let frontier = changed;
  let capped = false;
  for (let depth = 1; frontier.length > 0 && !capped; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const from of (reverse.get(p) ?? []).sort()) {
        if (seen.has(from)) continue;
        if (seen.size - changed.length >= cap) {
          capped = true;
          break;
        }
        seen.set(from, depth);
        next.push(from);
      }
      if (capped) break;
    }
    frontier = next;
  }
  const dependents = [...seen.entries()].filter(([, d]) => d > 0).map(([path, depth]) => ({ path, depth })).sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1));
  const changedSet = new Set(changed);
  const counts = new Map<string, number>();
  for (const u of facts.usages) if (changedSet.has(u.declaredIn) && !changedSet.has(u.usedBy)) counts.set(`${u.declaredIn}\0${u.symbol}`, (counts.get(`${u.declaredIn}\0${u.symbol}`) ?? 0) + 1);
  const usedSymbols = [...counts.entries()].map(([k, usedBy]) => ({ module: k.split("\0")[0]!, name: k.split("\0")[1]!, usedBy })).sort((a, b) => b.usedBy - a.usedBy || (a.module < b.module ? -1 : a.module > b.module ? 1 : a.name < b.name ? -1 : 1));
  return { changedModules: changed, dependents, dependentsCapped: capped, usedSymbols };
}

export const CONTEXT_FILE_CAP = 20;

/** One level each way for every module a task may touch, plus what each exports. */
export function contextFor(facts: MapFacts, matches: (path: string) => boolean, freshness: BriefMapContext["freshness"], snapshotId?: string): BriefMapContext {
  const all = facts.modules.map((m) => m.path).filter(matches).sort();
  const files = all.slice(0, CONTEXT_FILE_CAP).map((path) => {
    const edges = judgedEdges(facts);
    return {
      path,
      imports: [...new Set(edges.filter((e) => e.from === path).map((e) => e.resolved!))].sort(),
      importedBy: [...new Set(edges.filter((e) => e.resolved === path).map((e) => e.from))].sort(),
      exports: facts.symbols.filter((s) => s.module === path).map((s) => s.name).sort(),
    };
  });
  return { freshness, ...(snapshotId ? { snapshotId } : {}), files, truncated: all.length > CONTEXT_FILE_CAP };
}
