import { BROWSER_SERVER_NAME, BROWSER_TOOLS, WEB_SERVER_NAME, WEB_TOOLS, browserSessionProblem, type Plan, type Spec } from "@9thlevelsoftware/legion-flow-schema";

/**
 * Pure checks a plan must pass before a human may approve it. Errors refuse
 * approval; warnings are reported and left to the approver's judgment.
 */

export interface PlanFinding {
  code: string;
  message: string;
}

export interface PlanValidation {
  errors: PlanFinding[];
  warnings: PlanFinding[];
}

/**
 * Checks run without a shell, one argv per check. Anything that only a shell
 * would interpret is refused: chains, pipes, redirects, substitution. Globs and
 * `$VAR` are legal argv bytes and are passed literally, never expanded.
 */
const SHELL_OPERATORS = /&&|\|\||[;|<>`\n]|\$\(|\$\{/;

export function argvCheckProblem(check: string): string | null {
  if (check.trim().length === 0) return "empty check";
  if (SHELL_OPERATORS.test(check)) {
    return "contains a shell operator (&&, ||, ;, |, <, >, backtick, $( or ${); checks run without a shell, one argv each";
  }
  return null;
}

/** Task ids that form a dependency cycle, if any. */
function findCycle(plan: Plan): string[] | null {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // unknown deps are reported separately
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const task of plan.tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function validatePlanAgainstSpec(plan: Plan, spec: Spec, options: { members?: readonly string[]; mcpServers?: readonly string[] } = {}): PlanValidation {
  const errors: PlanFinding[] = [];
  const warnings: PlanFinding[] = [];
  // M4 slice j1: a task may name a coordinator member; an unknown one is refused, never routed by guess.
  const members = options.members ?? ["default"];
  for (const task of plan.tasks) {
    // M4 slice o1: the built-in browser server needs the task's frozen session, and a session needs the server named.
    const browsing = (task.tools ?? []).some((t) => t.split(".")[0] === BROWSER_SERVER_NAME);
    if (browsing && !task.browser) errors.push({ code: "plan_browser_session_missing", message: `Task ${task.id} names the browser tools but has no browser block (allowedDomains, and optionally startUrl, secrets, serve, allowRisk).` });
    if (task.browser && !browsing) errors.push({ code: "plan_browser_tools_missing", message: `Task ${task.id} has a browser block but its tools do not name 'browser'.` });
    if (task.browser) {
      const problem = browserSessionProblem(task.browser);
      if (problem) errors.push({ code: "plan_browser_session_unsafe", message: `Task ${task.id}'s browser session: ${problem}.` });
    }
    // M4 slice z: the built-in web server needs the task's frozen allowlist, and a web block needs the server named.
    const fetching = (task.tools ?? []).some((t) => t.split(".")[0] === WEB_SERVER_NAME);
    if (fetching && !task.web) errors.push({ code: "plan_web_session_missing", message: `Task ${task.id} names the web tools but has no web block (allowedDomains, and optionally allowRisk, deny, timeoutMs, maxBytes).` });
    if (task.web && !fetching) errors.push({ code: "plan_web_tools_missing", message: `Task ${task.id} has a web block but its tools do not name 'web'.` });
    for (const t of task.tools ?? []) {
      const server = t.split(".")[0]!;
      if (server === WEB_SERVER_NAME) {
        const tool = t.slice(server.length + 1);
        if (tool && !(tool in WEB_TOOLS)) errors.push({ code: "plan_tool_unknown", message: `Task ${task.id} names '${t}', and the web server has no tool '${tool}' (it has ${Object.keys(WEB_TOOLS).join(", ")}).` });
        continue;
      }
      if (server === BROWSER_SERVER_NAME) {
        const tool = t.slice(server.length + 1);
        if (tool && !(tool in BROWSER_TOOLS)) errors.push({ code: "plan_tool_unknown", message: `Task ${task.id} names '${t}', and the browser server has no tool '${tool}' (it has ${Object.keys(BROWSER_TOOLS).join(", ")}).` });
        continue;
      }
      if (!(options.mcpServers ?? []).includes(server)) errors.push({ code: "plan_tool_server_unknown", message: `Task ${task.id} names tool '${t}', but project.json mcpServers declares no server '${server}' (tool names are checked only when the gateway lists them).` });
    }
    // M4 slice m: a coordinate task names its members per step; the task-level member is not also set.
    if (task.coordinate) {
      if (task.member !== undefined) errors.push({ code: "plan_coordinate_with_member", message: `Task ${task.id} sets both member and coordinate; a coordinate task runs its steps' members.` });
      for (const [i, s] of task.coordinate.steps.entries()) if (!members.includes(s.member)) errors.push({ code: "plan_member_unknown", message: `Task ${task.id} step ${i + 1} names member '${s.member}', which project.json coordinator.members does not declare (known: ${members.join(", ")}).` });
    }
    if (task.member !== undefined && !members.includes(task.member)) errors.push({ code: "plan_member_unknown", message: `Task ${task.id} names member '${task.member}', which project.json coordinator.members does not declare (known: ${members.join(", ")}).` });
  }

  if (plan.tasks.length === 0) {
    errors.push({ code: "plan_has_no_tasks", message: "The plan has no tasks; nothing to approve." });
  }

  const specIds = new Set(spec.acceptanceCriteria.map((c) => c.id));
  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) {
      errors.push({ code: "plan_duplicate_task", message: `Task id ${task.id} appears more than once.` });
    }
    taskIds.add(task.id);
  }

  const covered = new Set<string>();
  for (const task of plan.tasks) {
    for (const ac of task.acceptanceIds) {
      if (!specIds.has(ac)) {
        errors.push({ code: "plan_unknown_criterion", message: `Task ${task.id} names ${ac}, which spec ${spec.id} does not define.` });
      } else {
        covered.add(ac);
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        errors.push({ code: "plan_unknown_dependency", message: `Task ${task.id} depends on ${dep}, which is not in the plan.` });
      }
    }
    if (task.contract.filesAllowed.length === 0) {
      errors.push({ code: "plan_task_without_files", message: `Task ${task.id} allows no files; a FileContract must name what the task may touch.` });
    }
    for (const check of task.contract.verificationCommands) {
      const problem = argvCheckProblem(check);
      if (problem) {
        errors.push({ code: "check_not_argv", message: `Task ${task.id} check "${check}" ${problem}.` });
      }
    }
  }

  const cycle = findCycle(plan);
  if (cycle) {
    errors.push({ code: "plan_dependency_cycle", message: `Tasks form a dependency cycle: ${cycle.join(" -> ")}.` });
  }

  const uncovered = spec.acceptanceCriteria.filter((c) => !covered.has(c.id));
  if (plan.tasks.length > 0 && uncovered.length > 0) {
    warnings.push({
      code: "plan_uncovered_criteria",
      message: `No task covers ${uncovered.map((c) => c.id).join(", ")}; the approver accepts that gap by approving.`,
    });
  }

  return { errors, warnings };
}
