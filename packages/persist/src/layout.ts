import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { atomicWriteFile } from "./atomic-write.js";

export interface LegionFlowPaths {
  root: string;
  project: string;
  projectConfig: string;
  specsDir: string;
  plansDir: string;
  runsDir: string;
  approvalsDir: string;
  releasesDir: string;
  /** Review receipts: a decision owner's acceptance of a PASS review. */
  reviewsDir: string;
  /** Hook consent receipts (M4 slice l). */
  consentsDir: string;
  /** Golden datasets: evals/<id>/v<N>.json. */
  evalsDir: string;
  /** Episodes: the durable inputs to memory (map snapshots first). */
  episodesDir: string;
  auditDir: string;
  eventsJsonl: string;
  chainJson: string;
  varDir: string;
  engineLock: string;
  indexSqlite: string;
  sandboxDir: string;
  /** Per-run pointer-prompt targets: prompt.md, brief.json, summary.md. */
  cacheRunsDir: string;
  /** Map query documents and diagrams: derived, rebuildable. */
  cacheMapDir: string;
}

export function getLegionFlowPaths(workspaceRoot: string): LegionFlowPaths {
  const root = join(workspaceRoot, ".legion-flow");
  return pathsFor(root, join(root, "project"), join(root, "var"));
}

/**
 * Paths for a directory laid out like `project/` but standing alone: a ship bundle
 * (M4 slice h). The var paths point inside it too and are never written by a reader.
 */
export function projectDirPaths(projectDir: string): LegionFlowPaths {
  return pathsFor(projectDir, projectDir, join(projectDir, ".var"));
}

function pathsFor(root: string, project: string, varDir: string): LegionFlowPaths {
  const auditDir = join(project, "audit");

  return {
    root,
    project,
    projectConfig: join(project, "project.json"),
    specsDir: join(project, "specs"),
    plansDir: join(project, "plans"),
    runsDir: join(project, "runs"),
    approvalsDir: join(project, "approvals"),
    releasesDir: join(project, "releases"),
    reviewsDir: join(project, "reviews"),
    consentsDir: join(project, "consents"),
    evalsDir: join(project, "evals"),
    episodesDir: join(project, "episodes"),
    auditDir,
    eventsJsonl: join(auditDir, "events.jsonl"),
    chainJson: join(auditDir, "chain.json"),
    varDir,
    engineLock: join(varDir, "engine.lock"),
    indexSqlite: join(varDir, "index.sqlite"),
    sandboxDir: join(varDir, "sandbox"),
    cacheRunsDir: join(varDir, "cache", "runs"),
    cacheMapDir: join(varDir, "cache", "map"),
  };
}

export async function ensureLegionFlowLayout(workspaceRoot: string): Promise<LegionFlowPaths> {
  const paths = getLegionFlowPaths(workspaceRoot);

  await mkdir(paths.project, { recursive: true });
  await mkdir(paths.specsDir, { recursive: true });
  await mkdir(paths.plansDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(paths.approvalsDir, { recursive: true });
  await mkdir(paths.releasesDir, { recursive: true });
  await mkdir(paths.reviewsDir, { recursive: true });
  await mkdir(paths.auditDir, { recursive: true });

  await mkdir(paths.varDir, { recursive: true });
  await mkdir(paths.sandboxDir, { recursive: true });

  // Write .gitignore inside .legion-flow/ so var/ is never committed
  const gitignorePath = join(paths.root, ".gitignore");
  const gitignoreContent = "# Legion Flow runtime state (derived / ephemeral)\nvar/\n";
  await atomicWriteFile(gitignorePath, gitignoreContent);

  return paths;
}
