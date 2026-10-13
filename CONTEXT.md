# Legion Flow

The command-line workflow engine that runs coding agents behind human-authority gates. This glossary covers the result contract (what every command reports back to a human or a host agent), the lifecycle artifacts, state and audit, and the memory, map, sandbox, and coordination vocabulary. Other areas are added when a change touches them.

## Language

### Result contract

**Result envelope**:
The single document a command reports when it finishes: its status, the project phase, any diagnostics, gate verdicts, and the next action. Every lifecycle command emits exactly one.
_Avoid_: response, output, report

**Status**:
The outcome class of a command, one of six: ok, ready, awaiting decision, blocked, refused, usage error. The status alone decides the exit code.
_Avoid_: result code, state, outcome

**Phase**:
Where the project stands in its lifecycle, from uninitialized through shipped or abandoned. Reported in every envelope.
_Avoid_: stage, step, state

**Diagnostic**:
One finding attached to an envelope: a stable code, a severity (info, warning, error), a message, and optionally a fix hint. Facts a human needs to read, such as the project name, also travel as info diagnostics.
_Avoid_: log line, check result, issue, finding

**Next action**:
The one thing to do next, named in every envelope: a command to run, a human decision to make, a credential the operator must set (named by variable, never by value), a time to wait until, or nothing.
_Avoid_: next step, suggestion, recommendation

**Human decision**:
A next action that only a named decision owner may take. It is deliberately not executable by an agent.
_Avoid_: approval prompt, confirmation, sign-off

**Interrupt**:
A typed pause a workflow writes as ordinary step output when an action needs a human: what the action is, its risk class, the evidence behind it, when it expires, and what happens on timeout. The pausing step is never re-run; the decision is input to the next one.
_Avoid_: prompt, question, hold, exception

**Host tool**:
A read-only question a host agent may ask the engine over MCP: where the project stands, what to do next, whether the machine is ready, which runs exist, what one run recorded, what the code map knows, and what memory recalls. A host tool never changes anything and never stands in for a human decision.
_Avoid_: MCP command, endpoint, action

**Code map**:
The deterministic record of a codebase's structure: its modules, what each exports, what each imports, which modules use which exported symbols, the HTTP routes it declares by syntax, and what a configured language server reports. It is always derived from the source by fixed rules, never by a model, and it is evidence of structure, not of behavior.
_Avoid_: index, knowledge graph, semantic map

**Architecture rule**:
A declared constraint on how the codebase may depend on itself and on outside packages: which layers may import which, which edges are forbidden, which packages are banned, and whether import cycles are allowed. Rules are project configuration, so changing them is a change a decision owner approves.
_Avoid_: lint rule, policy, constraint

**Blast radius**:
What a proposed change can reach: the modules it changes, everything that depends on them, and the exported symbols other modules use.
_Avoid_: impact analysis, ripple, footprint

**Fact**:
A single statement memory holds about the project: what it is about, what is said, and what it relates to, with when it became true and when it was recorded. A fact is never deleted; a newer one may replace it, and the old one stays on record as no longer true from that time.
_Avoid_: note, memory item, knowledge

**Supersession**:
The replacement of a fact by a newer, conflicting one. It is only ever proposed by recording the new fact; a decision owner decides whether it takes effect.
_Avoid_: update, overwrite, correction

**Browser check**:
A verification step that opens the application in a real browser and follows a fixed script: go to a page, fill a field, expect some text. It reaches only the hosts it names, types secrets without recording them, and is frozen when the plan is approved so a run cannot weaken it.
_Avoid_: UI test, end-to-end test, browser automation

**Tool provider**:
An outside program that offers tools over the Model Context Protocol. Legion can start one in a sandbox and ask what tools it has and how risky each claims to be; an agent may call them only through the tool gateway, and only the tools the approved plan names for its task.
_Avoid_: plugin, integration, MCP server (when the role is meant)

**Route**:
An HTTP path and method a module declares, as the code map reads it from the source text alone. A path the source builds at run time is recorded as unresolved, never guessed.
_Avoid_: endpoint (when the map's fact is meant), API

**Previous attempt**:
An earlier run of the same task that did not land: it failed, was cancelled, was rejected, or was withheld because its checks failed. Its record comes from Legion, not from the agent.
_Avoid_: retry history, prior run (when one of these is meant)

**Bundle**:
A self-contained copy of what one ship evaluation rested on, with a manifest of every file's hash, that someone without the project can check. A signature on it says who vouched for those bytes, not that the verdicts were right.
_Avoid_: archive, package, release (a release is the human decision; a bundle is a copy of its evidence)

**Corroboration**:
The same statement made again in a later episode. Memory keeps one fact and records that it was said again.
_Avoid_: duplicate

**Observation**:
A group of statements that keep being made, found by comparing statement keys (subject, predicate, object) with no model, and committed to memory only when a decision owner agrees. Its words may come from the template, from a model asked to suggest them, or from the decision owner, and the record says which. A statement key is not a signature; a signature is the cryptographic seal on a bundle.
_Avoid_: insight, pattern, summary

**Member**:
A named worker the coordinator may give a task to: an adapter, optionally a model, and optionally a demand that it run only in a sandbox. The default member is the project's own adapter.
_Avoid_: agent (too broad), worker

**Coordinate step**:
One member's turn in a coordinated task (distinct from a workflow step, below): the approved plan names its member and role, it works in the same tree as the steps before it, and the whole sequence repeats until the task's checks pass or the round limit is reached.
_Avoid_: subtask (a step has no contract of its own), stage, step on its own

**Broadcast**:
Giving one task to several members at once, each working alone, so a decision owner can compare their proposals and choose one. Nothing is merged.
_Avoid_: ensemble, best-of-n, voting

**Routing rule**:
A declared rule that sends a task to a member when every file the task may touch falls under the rule's patterns. Not to be confused with a Route, which is an HTTP path in the code map.
_Avoid_: route (that word is the code map's)

**Concern**:
A question about a draft spec, raised by a fixed rule or by a challenge agent, that a decision owner must answer, dismiss, or accept as a risk.
_Avoid_: finding, issue (when a concern is meant)

**Resolution**:
A decision owner's answer to a concern, recorded with their name and bound to the version of the spec it was given for.
_Avoid_: response (that is the text inside a resolution)

**Tool gateway**:
The one door through which an agent calls outside tools during a task: it shows only the tools the approved plan named and the risk policy allows, counts every call against a budget, and records each one.
_Avoid_: proxy (that is the egress proxy), MCP server (when the gateway is meant)

**Draft**:
A spec or plan written by the project's own agent from a person's request (`spec --draft`, `plan --draft`), validated and written by Legion, and unverified until a decision owner approves it. A drafted task carries only its file contract.
_Avoid_: proposal (that is an agent's change to the tree, awaiting apply)

**Browser session**:
A plan task's frozen browser settings (allowed hosts, start page, declared secrets, an app to serve, risk policy, denied tools, a step budget) under which the task's agent drives a browser through the tool gateway; the agent acts on elements by the refs of its latest observation.
_Avoid_: browser check (that is a deterministic script run as verification)

**Web session**:
A plan task's frozen web settings (allowed hosts, risk policy, denied tools, a timeout, a byte budget) under which the task's agent fetches pages through the tool gateway's built-in `web` server, which asks the project's self-hosted Firecrawl on loopback. A host off the list is never fetched; a page whose reported final URL leaves the list is withheld.
_Avoid_: browser session (that drives a browser and acts on elements), crawl (only single pages are fetched)

**Forward mode**:
The browser's own egress proxy setting: it tunnels to, or forwards for, only the hosts the browser session lists, and refuses everything else.
_Avoid_: open proxy

**Tool call**:
One request from an agent to an outside tool through the gateway, allowed or refused, kept as evidence.
_Avoid_: invocation

**Hook**:
A declared delivery of chosen audit events, span records, or memory facts to an outside service. It sends nothing until a decision owner consents to it as written.
_Avoid_: webhook (when the governed hook is meant), integration

**Consent**:
A decision owner's recorded permission for one hook, exactly as configured; any change to the hook ends it.
_Avoid_: opt-in

**Recall**:
Asking what the code map and memory say about something, answered in order of authority: the map first, then facts tools established, then facts people asserted, then facts agents recorded, and last the agents' own run summaries, unverified, each marked as such. It can be asked as of a past time, or as memory held it at a past time.
_Avoid_: search, lookup, query

**Language server**:
A program that understands one programming language and answers questions about a codebase in it, such as what a file declares and where a name is used. The code map asks configured language servers about languages it does not read itself, inside a sandbox by default, because some servers run the project's own code while they work.
_Avoid_: LSP, analyzer, plugin

**Freshness**:
Whether the code map still describes the checkout: fresh, stale (source changed since it was built), partial (some files could not be read), or absent (never built, or its cache is gone).
_Avoid_: up to date, valid, current

**Workflow step**:
One super-step of a workflow (distinct from a coordinate step, above): every node due to run, each one's writes journaled as it finishes, then folded by the state's reducers into one snapshot. A crash between two nodes loses nothing a finished node wrote.
_Avoid_: tick, iteration, phase

**Materialized tree**:
The copy of the workspace an execution edits and verifies in, never the checkout itself. It lives under its run's id, and the proposal records its fingerprint so apply can refuse a checkout that has moved on.
_Avoid_: sandbox (that is the isolation around it), worktree (one way to make it), scratch copy

**Proposal**:
What an execution asks to apply: the files it would change, each by content hash, with the edits outside the task's contract already restored and the checks already run in the corrected tree. It is evidence, never a draft; a human approves it or rejects it whole.
_Avoid_: diff, patch, PR, changeset

**Apply**:
Writing a proposal into the checkout, only when the checkout still matches the tree the proposal was made from, and only after the tier's decision. Automatic at R0 with an audit record, unless the proposal introduces an architecture-rule violation or that analysis could not run; a human decision at R1 and above and for every broadcast member.
_Avoid_: merge, commit, land

**Sandbox tier**:
The isolation an execution's agent process runs under, named for what it is: a hardened container, a kernel jail, a disposable VM, a remote sandbox (catalogued, not planned), or none at all. A tier is chosen per execution and never assumed; the unisolated tier is refused unless a human on a terminal accepts it by name.
_Avoid_: sandbox (alone, when the tier matters), container, environment

**Preflight**:
The checks a tier runs before anything executes, each with a stable id and a one-line fix a person can act on. A failed preflight refuses the execution and starts nothing.
_Avoid_: health check, smoke test, setup

**Enforcement report**:
A tier's own statement of what it does and does not enforce for this execution: filesystem, network, credentials, and the caveats behind each claim. It is recorded with the run, so a later reader knows what "sandboxed" meant that day.
_Avoid_: security summary, audit, attestation

**Egress route**:
One named upstream an execution may reach, and nothing else: an alias the agent addresses, the one host it maps to, and the secret headers the proxy sets from its own environment by variable name. Deny-all is not a route; it is the absence of one.
_Avoid_: allowlist entry, whitelist, firewall rule, proxy config

**Adapter**:
The way one coding-agent CLI is run: its frozen command line, the pointer to the brief, the environment it may see, the credential it authenticates with, and the route that carries that credential when a proxy stands in between. An adapter describes a command; the tier runs it.
_Avoid_: plugin, driver, integration, backend

**Capability profile**:
What an adapter can do and can honestly report: tools, structured output, and which usage quantities (turns, tokens, cost) it measures. A limit on a quantity the profile cannot report is refused, never silently unenforced.
_Avoid_: feature flags, model card, config

**Effect**:
A side effect a step performs on the world outside the run's own records: spawning an agent, writing the checkout. Every effect is ledgered as started and then accounted for as done or failed; one that was started and never accounted for is a crash the engine refuses to repeat.
_Avoid_: side effect (when the ledger is meant), action, mutation

**Rebaseline**:
The one repair the audit chain allows: a decision owner on a terminal, with a reason of substance, accepts the log as it stands. Every readable event is kept as an archived region pinned by its hash, the unreadable tail is set aside, and a recorded event restarts the chain. History is never rewritten; the baseline is itself history.
_Avoid_: reset, repair, rebuild, truncate

**Span record**:
One step's trace spans, written as a run's own evidence: the run, its step, and each node that ran, with identifiers, counts, hashes, and the acceptance criteria they served. Never a prompt, a path, or a file body. It is a copy of what the journal and the snapshots already prove, kept so a later collector can read the same story.
_Avoid_: trace, log, telemetry, observability data

**Review**:
A second agent's reading of the whole applied plan against the acceptance criteria, made in a disposable copy and ending in one exact line: PASS or FAIL. The reviewer is independent only when it is a different agent or model from the one that did the work; a crash or a missing verdict is a FAIL, never a pass.
_Avoid_: code review (when the gate is meant), audit, QA, approval

**Review receipt**:
A decision owner's acceptance of one passed review, bound to the spec, plan, configuration, and checkout it reviewed. Any later change to those stops it matching, and the project must be reviewed again.
_Avoid_: sign-off, LGTM, review approval

**Golden dataset**:
A versioned set of cases, each a program to run, what its output should be, and the metrics that score it, bound to the acceptance criteria it proves. A version is frozen once it has run; a change is the next version, and retiring one is archiving, never deletion.
_Avoid_: test suite, fixtures, benchmark

**Score**:
One metric's judgement of one run of a case: a number from 0 to 1 with the reason for it, or a statement that it could not be scored. A metric passes when its mean over repetitions meets its threshold; scores of different metrics are never averaged together.
_Avoid_: grade, rating, result

**Egress log**:
The record of every request that left an execution through the proxy or was refused by it: when, where to, how much, and whether it was denied. No headers and no bodies, so it can be evidence without being a leak.
_Avoid_: access log, traffic log, network capture

### Lifecycle artifacts

**Specification**:
The frozen statement of what a change must do, as a typed list of acceptance criteria plus prose. A spec is a draft until an approval matches its current fingerprint, and a draft again the moment either half changes.
_Avoid_: requirements doc, ticket, story, PRD

**Acceptance criterion**:
One testable statement inside a specification, with a stable id, a kind (behavior, test, or rubric), the surface it is verified on, and a priority. Plans, evaluations, and gate verdicts bind to it by id.
_Avoid_: requirement, check, assertion

**Approval**:
A human decision owner's content-bound receipt that a specification or plan, at a named fingerprint, may proceed. It is never edited; a changed subject simply stops matching it.
_Avoid_: sign-off, LGTM, confirmation

**Plan**:
The execution contract against one frozen specification: an ordered set of tasks, each bound to acceptance criteria. A plan records the fingerprint of the spec it was planned against and is approved only with at least one verification check.
_Avoid_: roadmap, task list, backlog

**Task**:
One unit of planned work: the criteria it delivers, the tasks it depends on, a file contract naming what it may touch and what must run to prove it, and optionally which member or coordinate steps run it and which tools and browser session it may use.
_Avoid_: ticket, step, job

**Gate**:
One named condition a change must meet before it ships, required or not according to the risk tier. Three are required at every tier (approved spec, approved plan, deterministic verification); each higher tier adds more, and architecture rules add one at every tier. The five non-bypassable controls of the architecture document (adapter choice, approve spec, approve plan, apply, ship) are human-authority points inside the verbs, not gates.
_Avoid_: check, rule, policy, criterion

**Verdict**:
A gate's tri-state answer at a moment: satisfied, unsatisfied, or unevaluable. Missing, drifted, or unproducible evidence is unevaluable, never a pass. A verdict names the evidence it rests on by hash.
_Avoid_: result, pass/fail, score

**Waiver**:
A decision owner's named, audited exception to one unmet gate, with a reason of substance. It counts toward readiness but never changes the verdict itself.
_Avoid_: override, bypass, skip

**Run**:
One recorded evaluation or execution with its own evidence and verdicts, kept whole or marked incomplete; never partially trusted.
_Avoid_: job, session, attempt

**Release**:
A decision owner's content-bound record that a ready evaluation was shipped. A later edit stops it matching, exactly like an approval.
_Avoid_: deploy, publish, version

**Fingerprint**:
The SHA-256 over an artifact's canonical content. Approvals and verdicts bind to fingerprints, so drift invalidates them without anyone editing a status.
_Avoid_: hash, checksum, version

### State and audit

**Project**:
The unit of governed work: one per workspace, with a name, named human decision owners, a default adapter, a control mode, and a default risk tier. A project record that cannot be validated puts no project in force.
_Avoid_: repo, config

**Workspace**:
The directory a project lives in, the one that holds the engine's state directory. One workspace holds at most one project.
_Avoid_: repo, root directory, checkout

**Engine lock**:
The single exclusive claim on a project's state directory that every mutating command must hold. One holder at a time, per project; a dead holder's claim may be taken over, a live one's never.
_Avoid_: mutex, file lock, semaphore

**Audit chain**:
The append-only record of what the engine did, where each event carries the digest of the one before it, so a removed or altered event is detectable from any later one. It is never rewound; the only repair is a recorded rebaseline.
_Avoid_: log, history, event stream, ledger
