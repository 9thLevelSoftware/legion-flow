/**
 * The fake agent process. Argv: <promptPath> <treeDir> <planPath|->.
 * Reads brief.json beside the prompt and, when a plan path is given, that
 * scripted plan; edits the tree; writes summary.md beside the prompt.
 * Deliberately dependency-free: it is the thing the adapter spawns.
 */
import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface Brief {
  kind?: "task" | "review" | "challenge" | "naming";
  outputFile?: string;
  filesAllowed?: string[];
  expectedArtifacts?: string[];
  previousAttempts?: unknown[];
  member?: { id: string };
  /** A coordinate step (M4 slice m). */
  coordinate?: { round: number };
}

interface Plan {
  edits?: { path: string; content: string | null }[];
  exitCode?: number;
  sleepMs?: number;
  /** For a review brief: the notes and the verdict line to write (default: a short note and PASS; "none" omits the line). */
  review?: { notes?: string; verdict?: "PASS" | "FAIL" | "none" };
  /** Requests sent through the egress proxy at LF_EGRESS_URL; a failed expectation exits non-zero. */
  http?: { path: string; expectStatus?: number }[];
  /** A line appended to summary.md (to test what recall and evidence do with agent text). */
  summary?: string;
  /** For a challenge brief (M4 slice j3): the JSON written as challenge.json, or `challengeRaw` written verbatim. */
  challenge?: unknown;
  challengeRaw?: string;
  /** For a naming brief (M4 slice p): the JSON written as naming.json, or `namingRaw` written verbatim. */
  naming?: unknown;
  namingRaw?: string;
  /** Calls through the run's tool gateway (M4 slice k), after listing its tools; results go into summary.md. */
  toolCalls?: { name: string; arguments?: Record<string, unknown> }[];
  /** Per attempt (M4 slice g): overrides chosen by how many previous attempts the brief lists; the last entry repeats. */
  byAttempt?: Omit<Plan, "byAttempt">[];
  /** Per coordinator member (M4 slice j2): overrides chosen by the brief's member id, applied after byAttempt. */
  byMember?: Record<string, Omit<Plan, "byAttempt" | "byMember">>;
  /** Per coordinate round (M4 slice m): chosen by the brief's round, applied after byAttempt and before byMember; the last entry repeats. */
  byRound?: Omit<Plan, "byAttempt" | "byRound">[];
  /** Exit 1 unless these tree paths exist when the agent starts: proves a step sees what earlier steps wrote. */
  requireFiles?: string[];
}

async function fetchStatus(url: string): Promise<{ status: number; firstLine: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  return { status: res.status, firstLine: text.split("\n")[0] ?? "" };
}

/** One JSON-RPC call to the tool gateway over Streamable HTTP; the answer may come as JSON or as one SSE event. */
async function toolsRpc(method: string, params: unknown, id: number): Promise<{ result?: any; error?: { message: string }; status: number }> {
  const url = process.env.LF_TOOLS_URL;
  if (!url) return { status: 0, error: { message: "no LF_TOOLS_URL" } };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(process.env.LF_TOOLS_TOKEN ? { authorization: `Bearer ${process.env.LF_TOOLS_TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, error: { message: `HTTP ${res.status}` } };
  const json = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "{}" : text;
  const parsed = JSON.parse(json) as { result?: unknown; error?: { message: string } };
  return { status: 200, ...parsed };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const [promptPath, treeDir, planArg] = process.argv.slice(2);
  if (!promptPath || !treeDir) {
    console.error("fake-agent: usage <promptPath> <treeDir> [<planPath>|-]");
    return 64;
  }
  const brief = JSON.parse(await readFile(join(dirname(promptPath), "brief.json"), "utf8")) as Brief;
  const scripted: Plan = planArg && planArg !== "-" && (await exists(planArg)) ? (JSON.parse(await readFile(planArg, "utf8")) as Plan) : {};
  const attempt = brief.previousAttempts?.length ?? 0;
  const attempted: Plan = scripted.byAttempt?.length ? { ...scripted, ...scripted.byAttempt[Math.min(attempt, scripted.byAttempt.length - 1)] } : scripted;
  const rounded: Plan = brief.coordinate && attempted.byRound?.length ? { ...attempted, ...attempted.byRound[Math.min(brief.coordinate.round - 1, attempted.byRound.length - 1)] } : attempted;
  const plan: Plan = brief.member && rounded.byMember?.[brief.member.id] ? { ...rounded, ...rounded.byMember[brief.member.id] } : rounded;
  for (const p of plan.requireFiles ?? []) {
    if (!existsSync(join(treeDir, ...p.split("/")))) {
      console.error(`fake-agent: required file ${p} is not in the tree`);
      return 1;
    }
  }

  if (plan.sleepMs) await new Promise((r) => setTimeout(r, plan.sleepMs));
  const outputFile = brief.outputFile ?? "summary.md";

  if (brief.kind === "challenge") {
    const body = plan.challengeRaw ?? JSON.stringify(plan.challenge ?? { concerns: [] }, null, 2);
    await writeFile(join(dirname(promptPath), outputFile), body, "utf8");
    console.log("fake-agent: challenge written");
    return plan.exitCode ?? 0;
  }

  if (brief.kind === "naming") {
    const body = plan.namingRaw ?? JSON.stringify(plan.naming ?? { name: "fake-agent observation", summary: "Named by the legion-flow fake adapter." }, null, 2);
    await writeFile(join(dirname(promptPath), outputFile), body, "utf8");
    console.log("fake-agent: naming written");
    return plan.exitCode ?? 0;
  }

  if (brief.kind === "review") {
    const notes = plan.review?.notes ?? "Reviewed by the legion-flow fake adapter: the applied files were read against the acceptance criteria.";
    const verdict = plan.review?.verdict ?? "PASS";
    await writeFile(join(dirname(promptPath), outputFile), notes + "\n" + (verdict === "none" ? "" : "\nVerdict: " + verdict + "\n"), "utf8");
    console.log("fake-agent: review written (" + verdict + ")");
    return plan.exitCode ?? 0;
  }

  const touched: string[] = [];
  if (plan.edits) {
    for (const edit of plan.edits) {
      const target = join(treeDir, ...edit.path.split("/"));
      if (edit.content === null) {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, edit.content, "utf8");
      }
      touched.push(edit.path);
    }
  } else {
    for (const allowed of brief.filesAllowed ?? []) {
      if (allowed.endsWith("/")) continue;
      const target = join(treeDir, ...allowed.split("/"));
      if (await exists(target)) {
        const current = await readFile(target, "utf8");
        await writeFile(target, current + "\n// legion-flow fake adapter touched this file\n", "utf8");
        touched.push(allowed);
      }
    }
    for (const artifact of brief.expectedArtifacts ?? []) {
      const target = join(treeDir, ...artifact.split("/"));
      if (!(await exists(target))) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "// created by the legion-flow fake adapter\n", "utf8");
        touched.push(artifact);
      }
    }
  }

  const toolLines: string[] = [];
  if (plan.toolCalls) {
    const listed = await toolsRpc("tools/list", {}, 1).catch((e: Error) => ({ status: 0, error: { message: e.message } }) as { status: number; error: { message: string }; result?: any });
    toolLines.push(`- listed: ${listed.error ? `error ${listed.error.message}` : (listed.result?.tools ?? []).map((t: { name: string }) => t.name).join(", ") || "(none)"}`);
    let id = 2;
    let lastText = "";
    for (const c of plan.toolCalls) {
      // A test seam: the string ${LF_TOOLS_TOKEN} in an argument becomes the token, to prove evidence redacts it.
      // Another (M4 slice o1): "${ref:<text>}" becomes the ref on the first line containing <text> in the latest result that carried refs.
      const raw = JSON.stringify(c.arguments ?? {}).split("${LF_TOOLS_TOKEN}").join(process.env.LF_TOOLS_TOKEN ?? "");
      const args = JSON.parse(raw.replace(/\$\{ref:([^}]*)\}/g, (_m, want: string) => {
        const line = lastText.split("\n").find((l) => l.includes(JSON.parse(`"${want}"`)) && /\[ref=/.test(l));
        return line?.match(/\[ref=([a-z0-9]+)\]/)?.[1] ?? "e-missing";
      }));
      const r = await toolsRpc("tools/call", { name: c.name, arguments: args }, id++).catch((e: Error) => ({ status: 0, error: { message: e.message } }) as { status: number; error: { message: string }; result?: any });
      const first = r.result?.content?.[0]?.text ?? r.error?.message ?? "";
      const text = (r.result?.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
      if (text.includes("[ref=")) lastText = text;
      toolLines.push(`- ${c.name}: ${r.error ? "rpc-error" : r.result?.isError ? "error" : "ok"} ${String(first).slice(0, 160)}`);
    }
  }
  const httpLines: string[] = [];
  let httpFailed = false;
  if (plan.http && plan.http.length > 0) {
    const base = process.env.LF_EGRESS_URL;
    for (const h of plan.http) {
      if (!base) {
        httpLines.push(`- ${h.path}: no LF_EGRESS_URL (no egress route in this run)`);
        httpFailed = true;
        continue;
      }
      try {
        const r = await fetchStatus(base + h.path);
        const okStatus = h.expectStatus === undefined ? r.status < 400 : r.status === h.expectStatus;
        if (!okStatus) httpFailed = true;
        httpLines.push(`- ${h.path}: ${r.status} ${r.firstLine.slice(0, 120)}${okStatus ? "" : " (unexpected)"}`);
      } catch (err) {
        httpFailed = true;
        httpLines.push(`- ${h.path}: error ${(err as Error).message}`);
      }
    }
  }
  await writeFile(
    join(dirname(promptPath), outputFile),
    `# fake adapter\n\nTouched ${touched.length} path(s):\n${touched.map((t) => `- ${t}`).join("\n")}\n${httpLines.length ? `\nHTTP through the egress proxy:\n${httpLines.join("\n")}\n` : ""}${toolLines.length ? `\nTools through the gateway:\n${toolLines.join("\n")}\n` : ""}${plan.summary ? `\n${plan.summary}\n` : ""}`,
    "utf8"
  );
  console.log(`fake-agent: touched ${touched.length} path(s)${httpLines.length ? `, ${httpLines.length} request(s)` : ""}`);
  if (httpFailed) return plan.exitCode ?? 3;
  return plan.exitCode ?? 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`fake-agent: ${(err as Error).message}`);
    process.exitCode = 70;
  }
);
