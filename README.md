# Legion Flow

Legion Flow is a command-line workflow engine that lets AI coding agents (Claude Code, Codex) do real work on your repository while a human keeps authority over every decision that matters. You describe a change in a sentence; the agent drafts a spec and a plan for you to review and approve; then Legion runs each task inside a hardened Docker sandbox, verifies the result in the same tree the agent edited, and only then applies it to your checkout. Every step leaves hashed evidence and an audit trail, and nothing ships until the required gates pass and a named person says so.

> **Status: pre-release (version 0.0.0).** Every planned feature is built and covered by tests, but the tool has been exercised on Windows 11 with Docker Desktop only, has no CI yet, and is not published to npm. Install it from source (below). Expect rough edges.

```text
spec ──approve──▶ plan ──approve──▶ execute ──(decide)──▶ review / eval ──▶ ship ──commit──▶ shipped
        human               human      agent in sandbox      human           gates     human
```

---

## Contents

1. [What it does](#what-it-does)
2. [Requirements](#requirements)
3. [Install](#install)
4. [Key ideas in five minutes](#key-ideas-in-five-minutes)
5. [Quick start: an agent drafts, you approve](#quick-start-an-agent-drafts-you-approve)
6. [Let Claude Code or Codex drive](#let-claude-code-or-codex-drive)
7. [Setting up your coding agent](#setting-up-your-coding-agent)
8. [Risk tiers and gates](#risk-tiers-and-gates)
9. [Sandboxes](#sandboxes)
10. [More capabilities](#more-capabilities)
11. [Configuration reference (`project.json`)](#configuration-reference-projectjson)
12. [Output, exit codes, and automation](#output-exit-codes-and-automation)
13. [Where state lives](#where-state-lives)
14. [Troubleshooting](#troubleshooting)
15. [Command reference](#command-reference)
16. [Developing Legion Flow](#developing-legion-flow)
17. [Further reading](#further-reading)
18. [Appendix: writing specs and plans by hand (no model needed)](#appendix-writing-specs-and-plans-by-hand-no-model-needed)

---

## What it does

- **Human authority gates.** Specs, plans, risky changes, and releases are approved by a named decision owner. Agents can never run `approve`, `decide`, or `ship --commit`.
- **Sandboxed execution.** By default each task runs in a hardened Docker container (`--network none`, read-only root, all capabilities dropped, non-root user, pinned image). When the agent needs its model provider, an egress proxy container holds the real API key and the agent only ever sees a placeholder.
- **Verify before apply.** The agent edits a copy of your tree. Legion restores anything outside the task's file contract, runs your checks in that exact tree, and applies only the files that passed.
- **Tri-state gates.** Every gate is `satisfied`, `unsatisfied`, or `unevaluable`. Missing or tampered evidence is never a pass.
- **Evidence and audit.** Runs, proposals, checks, tool calls, and decisions are content-addressed files. A hash-chained audit log detects any edit or removal.
- **Built for host agents too.** Every command speaks `--json`, and a read-only MCP server lets other agents read status, plans, and memory without being able to approve anything.

Legion Flow is the third sibling of `legion-cli` and `legion-ascended`. Its command is always `legion-flow` (there is no `legion` alias), and its state lives in `.legion-flow/`.

---

## Requirements

| Need | Version | Why |
|---|---|---|
| Node.js | 22.13.0 or later (tested on 24) | runtime |
| pnpm | 9.15.9 (pinned; `corepack enable` provides it) | building from source |
| git | any recent | cloning; optional `--materialize worktree` |
| Docker Desktop (or Docker Engine) | a recent version (tested with 29.x on Docker Desktop for Windows) | the default `vm-docker` sandbox |
| Claude Code and/or Codex CLI | optional | real agents; the built-in `fake` adapter needs neither |

Docker is strongly recommended. Without it you can only run on the `unhardened` tier, which is not a sandbox and must be confirmed on an interactive terminal.

---

## Install

From a clone of this repository:

```bash
git clone https://github.com/9thLevelSoftware/legion-flow.git
cd legion-flow
corepack enable              # makes the pinned pnpm available
pnpm install
pnpm run build
npm install -g ./packages/cli   # puts `legion-flow` on your PATH (a link to this checkout)
```

Check it works and that your machine is ready:

```bash
legion-flow doctor
```

`doctor` checks Node, PATH collisions (a bare `legion` belongs to a sibling tool), Docker, the agent CLIs, images, the SQLite driver, browsers, and your project's config. Every warning or failure prints a `FIX:` line telling you exactly what to do.

> If you prefer not to install globally, run `node /path/to/legion-flow/packages/cli/dist/bin.js` wherever this README says `legion-flow`.

To update later: `git pull && pnpm install && pnpm run build`. The global link follows the checkout.

---

## Key ideas in five minutes

**Phases.** A project moves through `uninitialized → initialized → spec_draft → spec_frozen → planning → plan_ready → executing → (awaiting_decision) → reviewing → ready_to_ship → shipped`. The phase is always *derived* from the files on disk, never stored, so `legion-flow status` is always truthful.

**The one next command.** Run `legion-flow status` (or just `legion-flow`) at any time. It prints the current phase and exactly one next command. `legion-flow next` prints only that command.

**Spec.** A `spec.json` (typed acceptance criteria) plus a `SPEC.md` (prose). The agent drafts both from your one-sentence request (`spec --draft`), or you write them. Approving it freezes it: editing either file afterwards invalidates the approval.

**Plan.** Tasks against the frozen spec, drafted by the agent (`plan --draft`) or written by you. Each task has a **file contract**: the files it may touch (`filesAllowed`) and the checks that prove it (`verificationCommands`). Approving the plan freezes it together with at least one check.

**Decision owners.** People listed in `project.json` under `decisionOwners`. Only they can approve, decide, waive, or ship, and only by passing `--approver <id>`.

**Risk tiers.** `R0` to `R3`. The tier decides which gates `ship` requires and whether a task's changes apply automatically (`R0`) or wait for a human decision (`R1` and up). New projects default to `R1`.

**Interrupts.** When Legion needs a human (for example, to apply a proposed change at `R1`), it stops with `awaiting_decision` and exit code 3, and tells you the exact `decide` command. Nothing proceeds until a decision owner answers.

---

## Quick start: an agent drafts, you approve

You never have to write JSON by hand. You describe what you want in a sentence; the project's coding agent drafts the spec and the plan inside the sandbox; you read them and approve; the agent does the work; you ship. Below is a real run (through Claude Code pointed at Xiaomi MiMo), lightly trimmed. In your terminal, text the agent wrote appears inside `<untrusted-content source="drafter">` markers, so you can always tell its words from Legion's.

Before you start: Docker is running, your agent is configured (see [Setting up your coding agent](#setting-up-your-coding-agent)), and your key is in the environment.

### 1. Create a project in your repository

```bash
cd my-repo
legion-flow init --adapter claude --name "My project" --owner alice
```

`--adapter` is `claude` or `codex`. `--owner alice` makes `alice` the decision owner: the only person who can approve and ship. To use a compatible provider such as MiMo instead of the vendor's own API, add `adapter.http` to `.legion-flow/project/project.json` now ([how](#an-anthropic--or-openai-compatible-provider-for-example-xiaomi-mimo)).

### 2. Describe the change; the agent drafts the spec

```bash
legion-flow spec --draft "Make the greeting in src/greet.ts say hello instead of hi. check.mjs already exits 0 once it does."
```

```text
spec: ok
Phase: spec_draft
[✔] spec_drafted: Created draft spec spc_... from the drafting agent's answer (claude mimo-v2.6-pro, run run_...); agent-written and unverified until you approve it.
[✔] spec_title: Title: Greet with hello in src/greet.ts
[✔] spec_criterion: AC-01 (behavior, unit, P0): src/greet.ts exports the binding `greeting` with the exact string value "hello"
[✔] spec_criterion: AC-02 (test, integration, P0): Running `node check.mjs` from the repository root exits with status 0
[✔] spec_criterion: AC-03 (behavior, unit, P1): src/greet.ts remains a valid TypeScript module that exports `greeting`
[⚠] draft_review: Read SPEC.md and spec.json before approving; edit them freely, or run spec --draft again with a sharper request.
Next: legion-flow approve spec --approver <id>
```

The agent read your code in a disposable copy and answered with a structured draft; Legion validated it and wrote `SPEC.md` (prose: intent, criteria, out of scope) and `spec.json` (the typed criteria) under `.legion-flow/project/specs/<id>/`. Not happy? Run `spec --draft` again with a sharper request (it rewrites the same draft), or edit the files.

Optional: `legion-flow spec --challenge --agent` asks for the questions a careful reviewer would raise before you approve.

### 3. Review and approve the spec (you)

```bash
legion-flow approve spec --approver alice
```

Approving freezes the spec: editing it afterwards invalidates the approval. Only a decision owner can approve, and agents never run this.

### 4. The agent drafts the plan

```bash
legion-flow plan --draft
```

```text
plan: ok
Phase: planning
[✔] plan_drafted: Created draft plan pln_... against spec spc_...; agent-written and unverified until you approve it.
[✔] plan_task: T-01 covers AC-01, AC-02, AC-03: In src/greet.ts, change the value of `greeting` from "hi" to "hello" ...; may change src/greet.ts
[⚠] draft_checks: The draft proposes these checks; once you approve the plan they run on this machine (without a shell): T-01: node check.mjs
[✔] draft_suggested_checks: The drafter suggests freezing these at approval (your choice; nothing is applied): node check.mjs
[⚠] draft_review: Read plan.json before approving: each task's filesAllowed and checks are what you authorize.
Next: legion-flow approve plan --approver <id> --check "<argv>"
```

Each task has a **file contract**: the only files it may change (`filesAllowed`) and the checks that prove it (`verificationCommands`). Add guidance if you like: `legion-flow plan --draft "split it into one task per file"`. A drafted plan never grants tools, browser or web access, or extra agents; you add those by hand if you want them. Legion flags anything risky: a contract that opens the whole tree, a check it would refuse, or a criterion no task covers.

### 5. Review and approve the plan, freezing its checks (you)

```bash
legion-flow approve plan --approver alice --check "node check.mjs"
```

`--check` freezes the command(s) that must pass for the work to count (repeat it for more). **You** choose them; the drafter's suggestion is only a suggestion. Checks run without a shell, so call programs directly.

### 6. Execute

```bash
legion-flow execute
```

```text
execute: ok
[✔] sandbox_tier: Tier vm-docker (copy tree, fs listing): ...
[✔] adapter_provider: The claude adapter calls https://<provider>/anthropic with MIMO_API_KEY as a bearer token; ...
[✔] task: Task T-01 via adapter claude at risk tier R0.
[✔] execution_auto_applied: Proposal applied automatically at R0 (run run_...).
```

The agent worked on a copy of your repository inside a hardened container. Legion threw away anything outside the contract, ran your checks in that exact tree, and applied the result. At the default risk tier (`R1`) it would instead stop with a `decide` command for you to approve the change first (see the next section). With several tasks, run `execute` again until `status` says to ship.

### 7. Decide, when asked (you)

At `R1` and above, `execute` ends with something like:

```text
execute: awaiting_decision
Decision required (approve_action): legion-flow decide int_... --approve --approver <id>
```

Look at the proposal (its path is printed), then:

```bash
legion-flow decide int_... --approve --approver alice     # or --reject
legion-flow execute --resume
```

### 8. Evaluate the gates, then ship (you)

```bash
legion-flow ship                              # evaluates every required gate; changes nothing
legion-flow ship --commit --approver alice    # records the release
```

```text
ship: ready
[✔] gate approved_spec: satisfied, receipt apv_... by alice matches
[✔] gate approved_plan: satisfied, receipt apv_... by alice matches, 1 receipt checks
[✔] gate deterministic_verification: satisfied, 2 check(s) exited 0
Next: legion-flow ship --commit --approver <id>
```

That is the whole loop. At any point, `legion-flow status` (or just `legion-flow`) tells you where you are and the one next command.

---

## Let Claude Code or Codex drive

If you already work inside Claude Code (or Codex, Cursor, or Gemini CLI), you can talk to it instead of typing commands. This repository ships an Agent Skill that teaches a host agent the loop: it runs `status`, drafts specs and plans, runs approved tasks, and **stops at every human decision** to tell you exactly what to approve.

Install it in Claude Code:

```bash
claude plugin marketplace add 9thLevelSoftware/legion-flow
claude plugin install legion-flow@legion-flow
```

The plugin manifests pass `claude plugin validate`; the install itself has not yet been tried from a clean machine.

Then, in a repository with `legion-flow` on your PATH, just ask: *"Use legion-flow to make the greeting say hello."* The agent drafts, shows you what it wrote, and hands you the `approve`, `decide`, and `ship --commit` commands to run yourself. It can never run those for you.

Other hosts: point them at `skills/legion-flow/SKILL.md` (or `skills/AGENTS.md` for hosts that read an AGENTS file). For read-only access over MCP, register `legion-flow mcp --stdio`.

---

## Setting up your coding agent

### Claude Code or Codex against their own APIs

```bash
legion-flow init --adapter claude --name "My project" --owner alice   # or --adapter codex
export ANTHROPIC_API_KEY=...   # for claude;  OPENAI_API_KEY for codex
legion-flow doctor
```

On the default `vm-docker` tier the agents run inside a locally built image that contains both CLIs. The first command that needs it writes its Dockerfile under `.legion-flow/var/images/agent/` and prints the exact build command as a `FIX:` line, for example:

```bash
docker build -t legion-flow-agent:claude-2.1.295-codex-0.162.0 ".legion-flow/var/images/agent"
```

Legion never builds or pulls images on its own. If the key is not set, the command stops with a `credential_required` next action naming the variable. Inside the container the agent only gets a placeholder key; a proxy container injects the real one.

> Live runs in this repository have so far gone through an Anthropic-compatible and an OpenAI-compatible third-party provider (below), not through Anthropic's or OpenAI's own APIs.

### An Anthropic- or OpenAI-compatible provider (for example Xiaomi MiMo)

Point the project's **default** adapter at any compatible API with `adapter.http` in `.legion-flow/project/project.json`. The key is referenced by environment-variable name, never stored:

```json
"adapter": {
  "default": "claude",
  "http": {
    "baseUrl": "https://<provider-host>/anthropic",
    "apiKeyEnv": "MIMO_API_KEY",
    "model": "mimo-v2.6-pro"
  }
}
```

- With `"default": "claude"`, `baseUrl` is an **Anthropic-compatible** root.
- With `"default": "codex"`, `baseUrl` is an **OpenAI-compatible Responses API** root (for MiMo, the `/v1` URL), `model` is required, and you may set `"contextWindow"` (tokens; 128,000 when unset).
- The proxy sends the key as a bearer token; cost is reported as unknown, because the CLIs price usage at their own vendor's rates.
- Changing `project.json` changes its fingerprint, so any existing approvals need to be given again.

### Usage limits

```json
"adapter": { "default": "claude", "limits": { "maxTurns": 30, "costLimitUsd": 2 } }
```

A limit on something the adapter cannot report (for example cost through a third-party provider) is refused rather than run unbounded.

---

## Risk tiers and gates

Set the project's tier with `"defaultRiskTier"` in `project.json` (`R0` to `R3`).

| Tier | Changes apply | Gates `ship` requires |
|---|---|---|
| R0 | automatically, if checks pass and no architecture rule is broken | `approved_spec`, `approved_plan`, `deterministic_verification` |
| R1 | after a human `decide` | R0 + `acceptance_coverage`, `audit_chain_intact` |
| R2 | after a human `decide` | R1 + `independent_review` |
| R3 | after a human `decide` | R2 + `eval_goldens` |

With architecture rules configured (`map.rules`), every tier also requires `architecture_conformance`.

- **`independent_review`** (R2+): `legion-flow review` runs a *different* adapter or model (`project.json` `review: { adapter, model }`) against a disposable copy; its last line must be `Verdict: PASS`. A decision owner then records acceptance with `legion-flow review --accept --approver alice`.
- **`eval_goldens`** (R3): `legion-flow eval --new <id>` scaffolds a golden dataset; `legion-flow eval --dataset <id>` runs it. An LLM judge must be on loopback (`project.json` `judge`) and must differ from the executor.
- **Waivers.** A required gate can never be bypassed, only waived by a named human with a reason of at least 24 characters, for example `legion-flow ship --waive "independent_review: reviewed in person on the team call" --commit --approver alice`. A waiver never changes a verdict; it is recorded beside it.

---

## Sandboxes

| Tier | What it is | How to use |
|---|---|---|
| `vm-docker` (default) | Hardened container: no network unless an egress route exists, read-only root, all capabilities dropped, no new privileges, non-root user, pid/memory/CPU limits, image pinned to the local image Id and never pulled. Provider traffic goes through a per-run proxy container that holds the secrets. | nothing; it is the default |
| `unhardened` | The agent runs on your host. **Not a sandbox.** | `--sandbox unhardened --allow-no-sandbox`, accepted only on an interactive terminal |

Docker Desktop is itself a Linux VM; Legion's guarantees on Windows are those of the Docker engine, not of the Windows host. `project.json` `sandbox.require: true` refuses the host tier for every agent and third-party process.

Other options: `--materialize worktree` uses a git worktree instead of a copy; `sandbox.docker` in `project.json` overrides the image, memory, CPUs, pids limit, and user.

---

## More capabilities

| What | How |
|---|---|
| **Run tasks in parallel** | `legion-flow execute --jobs 3` runs up to 3 tasks with non-overlapping file contracts; applies go one at a time with a rebase. |
| **Retry a failed run** | `legion-flow execute --retry 2` retries after an adapter failure, timeout, or contract violation. |
| **Resume after a crash or decision** | `legion-flow execute --resume` settles every incomplete task run. |
| **Several agents ("members")** | Declare `coordinator.members` in `project.json`; a task can name a `member`, or a `coordinate` block of member steps repeated until checks pass. |
| **Ask several agents, pick one** | `legion-flow execute T-01 --broadcast` runs the task once per member, then a human picks with `decide`. |
| **Code map** | `legion-flow map` builds a deterministic map of modules, symbols, imports, and routes; `--deps`, `--impact`, `--who-uses`, `--routes`, `--diagram` answer questions; `--check` judges `map.rules`. |
| **Memory** | `legion-flow learn <subject> <predicate> --text "..."` records a fact; `legion-flow recall "query"` answers in authority order (map, deterministic, human, model facts, agent summaries); `observe` finds repeated statements. |
| **MCP tools for agents** | Declare servers in `project.json` `mcpServers`; `legion-flow tools` probes them; a task with `"tools": ["<server>"]` gets a per-run tool gateway that exposes only what the approved plan names. |
| **Browser** | A check named `browser:<script>.json` runs a scripted browser check; `legion-flow browse <script>` dry-runs it; a task with `"tools": ["browser"]` and a `browser` block lets the agent drive a browser within an allowlist. |
| **Web fetching** | Run a self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) and set `project.json` `web.firecrawlUrl` (loopback only); a task with `"tools": ["web"]` and `"web": { "allowedDomains": [...] }` can fetch pages as markdown. |
| **Optional outside services** | `project.json` `hooks` declares event, OTLP, or memory-export hooks; nothing is sent until a decision owner runs `legion-flow hooks --enable <name> --approver alice`. |
| **Release bundles** | `legion-flow ship --bundle <dir>` writes a portable evidence bundle; `--sign --key <pem>` signs it; `legion-flow ship --verify <dir>` checks one anywhere. |
| **Host agent integration** | `legion-flow mcp --stdio` (or `--http`) serves read-only tools: status, next, doctor, runs, show, map, recall. The Agent Skill in `skills/legion-flow/` teaches host agents to drive the CLI by `--json`. |
| **Metrics** | `legion-flow doctor --metrics` reports runs, applies, interrupts, releases, usage, and egress. |

---

## Configuration reference (`project.json`)

`init` writes a minimal `.legion-flow/project/project.json`. Everything else is optional and has no schema defaults, so upgrading Legion never silently changes your config.

| Key | Purpose |
|---|---|
| `decisionOwners` | `[{ "id", "displayName", "kind": "human" }]`; who may approve, decide, waive, and ship |
| `defaultRiskTier` | `R0`..`R3` (default `R1`) |
| `controlMode` | `guarded` (default) or `advisory` |
| `adapter` | `{ "default": "fake" \| "claude" \| "codex", "http"?: {...}, "limits"?: {...} }` |
| `review` | `{ "adapter", "model"? }` for the independent reviewer |
| `judge` | `{ "baseUrl" (loopback), "model", "apiKeyEnv"? }` for evals |
| `sandbox` | `{ "docker"?: { image, memory, cpus, pidsLimit, user, browserImage }, "materialize"?, "require"? }` |
| `egress.routes` | extra allowlisted hosts for the agent: `{ alias, host, port?, scheme, basePath?, secrets: [{ header, ref: "env:NAME", prefix? }] }` |
| `mcpServers` | `[{ name, command, args?, envKeys?, image?, timeoutMs?, allowRisk?, deny? }]` |
| `toolPolicy` | `{ "maxSteps" }` tool calls per run (default 20) |
| `coordinator` | `{ members: [{ id, adapter, model?, sandbox? }], route?: [...] }` |
| `map` | `{ rules?: { layers, allow?, forbid? }, languageServers?: [...] }` |
| `memory` | memory settings such as single-valued predicates |
| `hooks` | Optional CALL hooks, enabled only by consent |
| `evidence.otlpEndpoint` | a loopback OTLP/HTTP collector that receives a copy of each span record |
| `web` | `{ "firecrawlUrl" }` (loopback) for the `web` tool |
| `spec.challenge` | `"required"` makes `approve spec` wait for a complete challenge round |

Secrets are always referenced by environment-variable name (`apiKeyEnv`, `env:NAME`), never written into config.

---

## Output, exit codes, and automation

Add `--json` to any command to get one machine-readable result envelope (`legion-flow-result/v1`) with `status`, `phase`, `diagnostics`, `gates`, and `nextAction`.

| Exit code | Meaning |
|---|---|
| 0 | `ok` or `ready` |
| 1 | unexpected error |
| 2 | `refused` or usage error (also: a sibling tool's verb, or a malformed command line) |
| 3 | `blocked` or `awaiting_decision` (a human or a fix is needed) |

`blocked` is a result, not a failure to work around: it means a gate or a precondition held. Three documented exceptions print no envelope: `mcp` (stdout is the protocol), `help-all` (text only), and a malformed command line (error on stderr).

Agents may run any command except the human-only ones: `approve`, `decide`, `ship` (except `--verify`), `review --accept`, `learn --approver`, `spec --challenge --resolve`, `hooks --enable/--disable`, and `doctor --rebaseline-audit`.

---

## Where state lives

```text
.legion-flow/
  project/          durable; commit this to git
    project.json    configuration
    specs/          specs (spec.json + SPEC.md)
    plans/          plans
    approvals/      approval receipts (content-bound, single-use)
    runs/           workflow runs: snapshots, evidence, interrupts, decisions
    releases/       shipped releases
    reviews/        review acceptance receipts
    episodes/       memory and code-map episodes
    audit/          hash-chained events.jsonl + chain.json
  var/              ephemeral, rebuildable, gitignored
    sandbox/        materialized trees
    cache/          prompts, briefs, map and recall output
    egress/         per-run proxy logs
    images/         Dockerfiles Legion writes for you to build
    index.sqlite    the memory and code-map index
```

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| Anything is unclear | `legion-flow status` prints the one next command; `legion-flow doctor` prints `FIX:` lines. |
| `sandbox_preflight_docker_daemon` | Start Docker Desktop. |
| `sandbox_preflight_docker_image` | Run the `docker pull` or `docker build` command in the `FIX:` line. Legion never pulls or builds by itself. |
| `credential_required` | Set the environment variable it names, then rerun. The value only ever reaches the proxy container. |
| `sandbox_not_hardened` / `sandbox_confirmation_requires_tty` | You asked for the host tier; add `--allow-no-sandbox` on an interactive terminal, or use Docker. |
| `plan_not_approved` after editing config | Editing `project.json`, the spec, or the plan invalidates approvals by design; approve again. |
| A check fails only under Legion | Checks run without a shell; call the program directly (`node check.mjs`, not `npm test && ...`). |
| `execution_no_changes` | The agent changed nothing inside `filesAllowed`. Make the task title and acceptance criteria more explicit. |
| `draft_invalid` | The drafting agent's answer could not be used, and nothing was written. Its raw answer is kept in the run's evidence; run `--draft` again with a more specific request. |
| `draft_phase` | You can draft only a spec or plan that is not yet approved. Drafting an approved spec would invalidate the approval. |
| A command named `legion` runs | That is `legion-cli` or `legion-ascended`. This tool is always `legion-flow`. |
| The audit chain reports a problem | `legion-flow doctor` explains it; the only repair is `doctor --rebaseline-audit --reason "..." --approver <id>`, run by a human. |

---

## Command reference

Run `legion-flow help-all` for the full catalog with usage lines.

| Command | What it does |
|---|---|
| `init --adapter <id> [--name] [--owner]` | create `.legion-flow/` |
| `status`, `next` | current phase and the one next command |
| `doctor [--metrics]` | machine and project readiness |
| `spec --draft "<request>"` | the agent drafts (or redrafts) the unapproved spec; you review |
| `spec [--new <title>] [--challenge [--agent]]` | create an empty spec by hand, inspect, or challenge it |
| `approve spec\|plan --approver <id> [--check "<argv>"]` | freeze the spec or plan (human) |
| `plan --draft ["<guidance>"]` | the agent drafts (or redrafts) the unapproved plan; you review |
| `plan [--new]` | create an empty plan by hand, or inspect it |
| `execute [<taskId>] [--resume] [--jobs n] [--retry n] [--broadcast]` | run approved tasks |
| `decide <interruptId> --approve\|--reject\|--edit <json> --approver <id>` | answer a pending decision (human) |
| `review [--accept --approver <id>]` | independent review (acceptance is human) |
| `eval --new <id> \| --dataset <id>` | golden datasets |
| `ship [--commit --approver <id>] [--waive ...] [--bundle <dir>] \| --verify <dir>` | evaluate gates, release (human), bundles |
| `map`, `learn`, `recall`, `observe`, `retro` | code map and memory |
| `tools`, `browse`, `hooks` | MCP servers, browser scripts, optional hooks |
| `mcp --stdio \| --http` | read-only MCP server for host agents |
| `help-all` | full catalog |

---

## Developing Legion Flow

```bash
pnpm install
pnpm run validate:m0     # build, typecheck, all tests, skills check: the full gate
pnpm --filter @9thlevelsoftware/legion-flow test     # one package
```

Tests import compiled output, so build before running a test file directly. Tests that need Docker, codex, or a browser skip themselves when those are absent.

Live tests make real model requests and run only when asked:

```bash
LF_LIVE_ADAPTER_TESTS=1 LF_LIVE_BASE_URL=<anthropic-compatible root> MIMO_API_KEY=... \
  node --test packages/cli/test/live-adapter.test.ts
# codex:  LF_LIVE_OPENAI_BASE_URL=<openai-compatible root>
# web:    LF_LIVE_FIRECRAWL_URL=http://127.0.0.1:3002
```

`CLAUDE.md` is the contributor guide (architecture, package boundaries, invariants). Fourteen ESM TypeScript packages live under `packages/` with a strict dependency direction that a test enforces.

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the engineer-facing design document, with diagrams, the state model, and the roadmap.
- [`docs/adr/`](docs/adr/): architecture decision records.
- [`CONTEXT.md`](CONTEXT.md): the glossary of domain terms.
- [`skills/legion-flow/SKILL.md`](skills/legion-flow/SKILL.md): how host agents should drive Legion Flow.

---

## Appendix: writing specs and plans by hand (no model needed)

Drafting needs a model. To learn the loop without one, or to write a spec and plan yourself, this walkthrough uses the built-in `fake` adapter, which applies scripted edits instead of calling a model. Every step here was run for real. A project on the `fake` adapter cannot use `--draft` (there is no model to answer; it is refused as `draft_invalid`). Docker should be running; the default sandbox uses `node:22-alpine` (pull it once with `docker pull node:22-alpine`).

### 1. Create a project

```bash
mkdir demo && cd demo
mkdir src && echo 'export const greeting = "hi";' > src/greet.ts
legion-flow init --adapter fake --name "Demo" --owner alice
```

```text
init: ok
Phase: initialized
[✔] project_initialized: Initialized Legion Flow project: Demo (prj_...)
[✔] adapter: Default adapter: fake
[✔] decision_owner: Decision owner: alice (kind: human)
Next: legion-flow spec --new <title>
```

`--owner alice` makes `alice` the first decision owner. `init` creates `.legion-flow/` (with its own `.gitignore` for the ephemeral `var/` part).

### 2. Draft a spec

```bash
legion-flow spec --new "Friendlier greeting"
```

This creates `.legion-flow/project/specs/<specId>/SPEC.md` and `spec.json`. Describe the change in `SPEC.md`, and add acceptance criteria to `spec.json`:

```json
"acceptanceCriteria": [
  {
    "id": "AC-01",
    "statement": "greet.ts exports a greeting that says hello",
    "kind": "behavior",
    "surface": "unit",
    "priority": "P0"
  }
]
```

`kind` is `behavior`, `test`, or `rubric`; `surface` is `unit`, `integration`, `real_interface`, or `end_to_end`; `priority` is `P0` to `P2`.

Optional: `legion-flow spec --challenge` runs five deterministic lint checks against the draft (and with `--agent`, asks an agent for up to three more concerns). Concerns are answered with `spec --challenge --resolve`.

### 3. Approve the spec (human)

```bash
legion-flow approve spec --approver alice
```

```text
approve: ok
Phase: spec_frozen
[✔] spec_approved: Approved spec spc_... as alice (piped); receipt apv_...
Next: legion-flow plan --new
```

The approval is a receipt bound to the spec's fingerprint. It also records whether it came from a terminal (`tty`) or a pipe.

### 4. Draft a plan

```bash
legion-flow plan --new
```

Edit `.legion-flow/project/plans/<planId>/plan.json` and add tasks:

```json
"tasks": [
  {
    "id": "T-01",
    "title": "Make the greeting say hello",
    "acceptanceIds": ["AC-01"],
    "dependsOn": [],
    "contract": {
      "filesAllowed": ["src/greet.ts"],
      "verificationCommands": ["node check.mjs"]
    }
  }
]
```

Write the check itself. Checks are plain programs that exit 0 on success. **They run without a shell**, so pipes, `&&`, globs, and `$VARS` are not interpreted (plan approval refuses a check containing a shell operator).

```js
// check.mjs
import { readFileSync } from "node:fs";
if (!/hello/.test(readFileSync("src/greet.ts", "utf8"))) process.exit(1);
```

### 5. Approve the plan with its checks (human)

```bash
legion-flow approve plan --approver alice --check "node check.mjs"
```

```text
approve: ok
Phase: plan_ready
[✔] plan_approved: Approved plan pln_... as alice (piped); receipt apv_...; 1 check(s) frozen.
Next: legion-flow execute
```

`--check` freezes one or more verification commands into the approval receipt (repeat the flag for more). Plan approval refuses zero tasks, unknown criteria or dependencies, cycles, a task with no `filesAllowed`, a plan written against a different spec version, and shell operators in checks.

### 6. Tell the fake adapter what to do

Only for this tutorial: the `fake` adapter reads its scripted edits from `.legion-flow/var/fake-adapter.json`.

```bash
echo '{"edits":[{"path":"src/greet.ts","content":"export const greeting = \"hello\";\n"}]}' > .legion-flow/var/fake-adapter.json
```

### 7. Execute

```bash
legion-flow execute
```

```text
execute: awaiting_decision
Phase: awaiting_decision
[✔] sandbox_tier: Tier vm-docker (copy tree, fs listing): ...
[✔] task: Task T-01 via adapter fake at risk tier R1.
[⚠] proposal_pending: Run run_... proposed changes (edit); a decision owner must approve before anything reaches the checkout.
Decision required (approve_action): legion-flow decide int_... --approve --approver <id>
```

What happened: Legion ran a Docker preflight, copied your tree, ran the agent in a hardened container, diffed the result, restored anything outside `filesAllowed`, ran your checks in that corrected tree, and stored the proposal as evidence. Because the project is at `R1`, it now waits for a human. Your checkout is unchanged (exit code 3).

### 8. Decide (human)

Copy the command Legion printed:

```bash
legion-flow decide int_... --approve --approver alice
legion-flow execute --resume
```

```text
execute: ok
Phase: plan_ready
[✔] execution_applied: Proposal applied after a human decision (run run_...).
Next: legion-flow ship
```

`--reject` abandons the proposal instead. `src/greet.ts` now says `hello`.

### 9. Evaluate the gates

```bash
legion-flow ship
```

```text
ship: ready
Phase: ready_to_ship
[✔] gate approved_spec: satisfied, receipt apv_... by alice matches
[✔] gate approved_plan: satisfied, receipt apv_... by alice matches, 1 receipt checks
[✔] gate deterministic_verification: satisfied, 2 check(s) exited 0
[✔] gate acceptance_coverage: satisfied, all 1 criteria covered
[✔] gate audit_chain_intact: satisfied, 12 events intact
Next: legion-flow ship --commit --approver <id>
```

Bare `ship` only evaluates: it writes a run of evidence with one verdict per required gate and changes nothing else.

### 10. Ship (human)

```bash
legion-flow ship --commit --approver alice
```

```text
ship: ok
Phase: shipped
[✔] shipped: Shipped as rel_... by alice (piped), evaluation run_...
```

The release is recorded in `.legion-flow/project/releases/`. The project's `project/` folder is meant to be committed to git; `var/` is ephemeral.

---

## License

MIT. See [LICENSE](LICENSE).
