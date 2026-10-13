import type { CommandContext, CommandHandler, TextRenderer } from "./runner.js";
import {
  initCommand,
  statusCommand,
  nextCommand,
  renderNextText,
  doctorCommand,
  specCommand,
  planCommand,
  approveCommand,
  shipCommand,
  decideCommand,
  executeCommand,
  reviewCommand,
  evalCommand,
  mapCommand,
  learnCommand,
  observeCommand,
  hooksCommand,
  retroCommand,
  recallCommand,
  browseCommand,
  toolsCommand,
  renderDoctorText,
} from "./commands.js";
import { mcpServe } from "./mcp-entry.js";

/**
 * The command catalog is the single source of every verb: its name, summary,
 * synopsis, options, milestone, and (when implemented) its handler. createCli
 * registers commands by iterating it; help-all renders it; a test proves every
 * entry is registered. Adding a verb is one entry here.
 *
 * `options` is registration data (Commander registers each verbatim);
 * `usage` is the human synopsis and may mention positionals and planned flags
 * that options do not declare. They are not two copies of the same thing.
 */

export type Milestone = "M0" | "M1" | "M2" | "M3" | "M4";

export interface CommandOption {
  flags: string;
  description: string;
  defaultValue?: string;
  required?: boolean;
  /** Collect every occurrence into an array (default []). "At least one" is enforced by the handler, not Commander. */
  repeatable?: boolean;
}

export interface CommandEntry {
  name: string;
  summary: string;
  usage: string;
  humanOnly: boolean;
  category: "lifecycle" | "governance" | "diagnostics" | "inspection";
  milestone: Milestone;
  /** Positional arguments in Commander syntax, e.g. "<subject>"; folded into the handler's options by name. */
  args?: string;
  options: readonly CommandOption[];
  /** Absent for planned verbs, which register and answer a typed refusal. */
  handler?: CommandHandler<Record<string, unknown>>;
  /**
   * A long-running server that owns stdout (`mcp --stdio`): called directly,
   * outside the envelope runner, like help-all. Mutually exclusive with handler.
   */
  server?: (ctx: CommandContext, opts: Record<string, unknown>) => Promise<void>;
  renderText?: TextRenderer;
}

/** Keeps each handler typed at its definition and erases to the common type once, here. */
function defineEntry<Opts>(
  entry: Omit<CommandEntry, "handler"> & { handler?: CommandHandler<Opts> }
): CommandEntry {
  return entry as unknown as CommandEntry;
}

export const COMMAND_CATALOG: readonly CommandEntry[] = [
  defineEntry({
    name: "init",
    summary: "Initialize a new .legion-flow project state hierarchy",
    usage: "legion-flow init --adapter <id> [--name <name>] [--owner <id>]",
    humanOnly: false,
    category: "lifecycle",
    milestone: "M0",
    options: [
      { flags: "-a, --adapter <id>", description: "Default coding-agent adapter (e.g. claude, codex, fake)", required: true },
      { flags: "-n, --name <name>", description: "Project name", defaultValue: "legion-flow-project" },
      { flags: "--owner <id>", description: "Primary human decision owner id", defaultValue: "human_operator" },
    ],
    handler: initCommand,
  }),
  defineEntry({
    name: "status",
    summary: "Show current project lifecycle phase and nextAction",
    usage: "legion-flow status [--json]",
    humanOnly: false,
    category: "inspection",
    milestone: "M0",
    options: [],
    handler: statusCommand,
  }),
  defineEntry({
    name: "next",
    summary: "Print the one next command (the same derivation as status, one line)",
    usage: "legion-flow next [--json]",
    humanOnly: false,
    category: "inspection",
    milestone: "M2",
    options: [],
    handler: nextCommand,
    renderText: renderNextText,
  }),
  defineEntry({
    name: "doctor",
    summary: "Verify system readiness, toolchain versions, and PATH shadowing; --metrics reports project facts; --rebaseline-audit is the one audit repair (human-only)",
    usage: 'legion-flow doctor [--metrics] [--rebaseline-audit --reason "<24+ chars>" --approver <id>]',
    humanOnly: false,
    category: "diagnostics",
    milestone: "M0",
    options: [
      { flags: "--metrics", description: "Add metric_* facts: runs, tasks applied, interrupts, releases, audit events, usage, egress" },
      { flags: "--rebaseline-audit", description: "Human-only: archive the chain index, keep every parseable event as a pinned region, quarantine the rest, record a baseline event" },
      { flags: "--reason <text>", description: "Why the rebaseline is justified (24+ characters); recorded verbatim" },
      { flags: "--approver <id>", description: "Decision owner id recorded on the baseline event" },
    ],
    handler: doctorCommand,
    renderText: renderDoctorText,
  }),
  defineEntry({
    name: "spec",
    summary: "Draft or inspect the current specification and its acceptance criteria",
    usage: "legion-flow spec [--new <title>] | spec --challenge [--agent] | spec --challenge --resolve <C-n> (--answer|--dismiss|--accept-risk) \"<response>\" --approver <id>",
    humanOnly: false,
    category: "lifecycle",
    milestone: "M1",
    options: [
      { flags: "--new <title>", description: "Create a new draft specification with this title" },
      { flags: "--challenge", description: "Question the current draft: five lint rules, plus the challenge agent with --agent or when project.json spec.challenge is set" },
      { flags: "--agent", description: "With --challenge: also run the challenge agent (in the sandbox tier; up to three concerns, quotes verified)" },
      { flags: "--resolve <id>", description: "With --challenge: resolve one concern as a decision owner on a terminal" },
      { flags: "--answer <response>", description: "With --resolve: the concern is answered" },
      { flags: "--dismiss <response>", description: "With --resolve: the concern is dismissed" },
      { flags: "--accept-risk <response>", description: "With --resolve: the risk is accepted, and recorded as a human fact" },
      { flags: "--approver <id>", description: "With --resolve: the decision owner" },
      { flags: "--sandbox <tier>", description: "With --agent: vm-docker (default) or unhardened" },
      { flags: "--allow-no-sandbox", description: "With --agent: accept running the agent on the host (terminal only)" },
    ],
    handler: specCommand,
  }),
  defineEntry({
    name: "approve",
    summary: "Freeze the current specification or plan as a named human decision owner (Human Authority Gate)",
    usage: "legion-flow approve <spec|plan> --approver <id>",
    humanOnly: true,
    category: "governance",
    milestone: "M1",
    args: "<subject>",
    options: [
      { flags: "--approver <id>", description: "Decision owner id recorded on the receipt", required: true },
      {
        flags: "--check <argv>",
        description: "Plan only: a verification command frozen into the receipt, one per --check, run without a shell",
        repeatable: true,
      },
    ],
    handler: approveCommand,
  }),
  defineEntry({
    name: "plan",
    summary: "Draft or inspect the execution plan: tasks with FileContracts against the frozen spec",
    usage: "legion-flow plan [--new]",
    humanOnly: false,
    category: "lifecycle",
    milestone: "M1",
    options: [{ flags: "--new", description: "Create an empty draft plan against the frozen spec" }],
    handler: planCommand,
  }),
  defineEntry({
    name: "execute",
    summary: "Execute the next approved task: materialize a tree, run the adapter, propose, verify in the same tree, apply or pause",
    usage: "legion-flow execute [<taskId>] [--resume] [--jobs <n>] [--retry <n>] [--broadcast [--members <a,b>]] [--sandbox vm-docker|unhardened] [--allow-no-sandbox] [--materialize copy|worktree] [--durability sync|exit|async]",
    humanOnly: false,
    category: "lifecycle",
    milestone: "M2",
    args: "[taskId]",
    options: [
      { flags: "--resume", description: "Settle every incomplete task run, in plan order: apply a decided interrupt, settle an expired one, or continue after a crash" },
      { flags: "--jobs <n>", description: "Run up to n tasks (1 to 8) in parallel when their contracts cannot overlap; applies go one at a time, rebasing on earlier ones" },
      { flags: "--broadcast", description: "Run the named task once per coordinator member, each in its own copy, none applying by itself; a decision owner then chooses one proposal" },
      { flags: "--members <ids>", description: "With --broadcast: comma-separated member ids (default plus every declared member when absent; capped by coordinator.maxBroadcast)" },
      { flags: "--retry <n>", description: "Start up to n (1 to 3) new attempts when a run fails (adapter failure, timeout, contract violation) or, at R0, when a proposal's checks fail (it is withheld, not applied; the last attempt applies as without the flag); each brief lists the earlier attempts; the attempts share one tool budget (a later execute starts fresh)" },
      { flags: "--sandbox <tier>", description: "Sandbox tier: vm-docker (default; hardened Docker container) or unhardened (a plain copy, needs --allow-no-sandbox)", defaultValue: "vm-docker" },
      { flags: "--materialize <strategy>", description: "How the tree is made: copy (default) or worktree (git repositories only)" },
      { flags: "--allow-no-sandbox", description: "Confirm running the adapter with no isolation; honored only on a terminal" },
      { flags: "--durability <mode>", description: "Snapshot cadence: sync (every step), exit (ends only), async (treated as sync)", defaultValue: "sync" },
    ],
    handler: executeCommand,
  }),
  defineEntry({
    name: "decide",
    summary: "Resolve a pending action interrupt (Human Authority Gate)",
    usage: "legion-flow decide <interruptId> --approve|--reject|--edit <json> --approver <id> [--note <text>]",
    humanOnly: true,
    category: "governance",
    milestone: "M1",
    args: "<interruptId>",
    options: [
      { flags: "--approve", description: "Approve the action as requested" },
      { flags: "--reject", description: "Reject the action" },
      { flags: "--edit <json>", description: "Approve with edited arguments (a JSON object)" },
      { flags: "--approver <id>", description: "Decision owner id recorded on the decision", required: true },
      { flags: "--note <text>", description: "Why; recorded verbatim" },
    ],
    handler: decideCommand,
  }),
  defineEntry({
    name: "review",
    summary: "Run an independent reviewer against a copy of the applied plan; --accept records a decision owner's acceptance (human-only)",
    usage: 'legion-flow review [--sandbox vm-docker|unhardened] [--allow-no-sandbox] [--materialize copy|worktree] [--resume] [--waive "independent_review: <reason>" --approver <id>] | review --accept --approver <id>',
    humanOnly: false,
    category: "lifecycle",
    milestone: "M3",
    options: [
      { flags: "--accept", description: "Human-only: accept the latest PASS review at the current fingerprints (needs --approver, a terminal)" },
      { flags: "--approver <id>", description: "Decision owner id for --accept or a review-time --waive" },
      { flags: "--waive <spec>", description: 'Run a review whose reviewer equals the executor: "independent_review: <reason of 24+ chars>" (the gate stays unsatisfied)' },
      { flags: "--sandbox <tier>", description: "Sandbox tier for the reviewer: vm-docker (default) or unhardened", defaultValue: "vm-docker" },
      { flags: "--allow-no-sandbox", description: "Confirm running the reviewer with no isolation; honored only on a terminal" },
      { flags: "--materialize <strategy>", description: "How the review copy is made: copy (default) or worktree" },
      { flags: "--resume", description: "Re-enter a review run that did not finish" },
    ],
    handler: reviewCommand,
  }),
  defineEntry({
    name: "eval",
    summary: "Run a golden dataset's cases in a copy of the checkout and score each metric; --new scaffolds a dataset",
    usage: 'legion-flow eval --dataset <id> [--dataset-version <N>] [--resume] [--waive "eval_goldens: <reason>" --approver <id>] | eval --new <id>',
    humanOnly: false,
    category: "lifecycle",
    milestone: "M3",
    options: [
      { flags: "--new <id>", description: "Scaffold v1 of a new golden dataset under project/evals/<id>/" },
      { flags: "--dataset <id>", description: "The dataset to run (its highest unarchived version)" },
      { flags: "--dataset-version <n>", description: "Pin a version instead of the highest unarchived one" },
      { flags: "--waive <spec>", description: 'Run with a judge equal to the executor: "eval_goldens: <reason of 24+ chars>" (the gate stays unsatisfied)' },
      { flags: "--approver <id>", description: "Decision owner id for --waive" },
      { flags: "--resume", description: "Re-enter an eval run that did not finish" },
    ],
    handler: evalCommand,
  }),
  defineEntry({
    name: "mcp",
    summary: "Serve status, next, doctor, runs, show, map, and recall to host agents over MCP (stdio, or loopback HTTP), read-only",
    usage: "legion-flow mcp --stdio | --http [--port <n>] [--token-file <path>]",
    humanOnly: false,
    category: "inspection",
    milestone: "M3",
    options: [
      { flags: "--stdio", description: "Serve over stdin and stdout" },
      { flags: "--http", description: "Serve Streamable HTTP on 127.0.0.1 only, with a bearer token printed to stderr" },
      { flags: "--port <n>", description: "With --http: the port (default 0, any free port; the chosen one is printed to stderr)" },
      { flags: "--token-file <path>", description: "With --http: write the bearer token here instead of printing it" },
    ],
    server: mcpServe as CommandEntry["server"],
  }),
  defineEntry({
    name: "map",
    summary: "Build the deterministic code map (modules, exported symbols, imports, symbol usages), or ask it one question",
    usage: "legion-flow map [--deps <path> | --impact <path> | --who-uses <symbol|path#symbol> | --routes [<prefix>] | --check | --diagram [--scope <dir>] [--out <file.md>]]",
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    options: [
      { flags: "--deps <path>", description: "What a module depends on, transitively, with external packages" },
      { flags: "--impact <path>", description: "What depends on a module, transitively" },
      { flags: "--who-uses <symbol>", description: "Modules using an exported symbol (name, or path#name when the name is declared in several modules)" },
      { flags: "--routes [prefix]", description: "HTTP routes found by syntax (Express-style calls, fastify.route, Next.js app and pages/api); filter by a URL prefix starting with / or a module path" },
      { flags: "--check", description: "Judge the map against project.json map.rules; exit 3 when anything is broken" },
      { flags: "--diagram", description: "Draw the map as Mermaid (.mmd plus an HTML page under var/cache/map/)" },
      { flags: "--scope <dir>", description: "With --diagram: draw the modules under one directory" },
      { flags: "--out <file.md>", description: "With --diagram: also write a Markdown file in the workspace (only over one this command wrote)" },
      { flags: "--sandbox <tier>", description: "Where configured language servers run: vm-docker (default; each server's image, no network, tree read-only) or unhardened" },
      { flags: "--allow-no-sandbox", description: "Accept running language servers on the host (terminal only); some servers run project code" },
      { flags: "--rebuild", description: "Run every language server again instead of reusing languages whose files and configuration did not change" },
    ],
    handler: mapCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "learn",
    summary: "Record a structured fact (typed subject, predicate, object), or propose replacing one; a conflict waits for a human decision",
    usage: 'legion-flow learn <subject> <predicate> (--object <ref> | --text "<text>") [--valid-at <iso>] [--supersedes <factId>]... [--approver <id>] | learn --resume',
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    args: "[subject] [predicate]",
    options: [
      { flags: "--object <ref>", description: "The object as a typed reference (module:, symbol:, package:, task:, release:, topic:)" },
      { flags: "--text <text>", description: "The object as text (up to 2000 characters)" },
      { flags: "--valid-at <iso>", description: "When the statement became true; default now" },
      { flags: "--supersedes <factId>", description: "An active fact this one replaces; opens a supersession a decision owner decides", repeatable: true },
      { flags: "--approver <id>", description: "Assert the fact as human, as this decision owner (terminal only); otherwise it is recorded as llm-origin" },
      { flags: "--resume", description: "Commit every supersession whose decision was made (or lapse an expired one)" },
    ],
    handler: learnCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "hooks",
    summary: "List declared Optional CALL hooks; --enable or --disable one as a decision owner (nothing is ever sent without that consent)",
    usage: "legion-flow hooks [--enable <name> | --disable <name>] [--approver <id>]",
    humanOnly: false,
    category: "governance",
    milestone: "M4",
    options: [
      { flags: "--enable <name>", description: "Consent to this hook as it is configured now (terminal only, with --approver); any later change disables it" },
      { flags: "--disable <name>", description: "Revoke consent to this hook (terminal only, with --approver)" },
      { flags: "--approver <id>", description: "The decision owner giving or revoking consent" },
    ],
    handler: hooksCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "observe",
    summary: "List clusters of repeated statements in memory, found with no model; propose one for a human decision, or commit decided ones",
    usage: "legion-flow observe [--propose <obc_id> [--agent [--sandbox vm-docker|unhardened] [--allow-no-sandbox]] | --resume]",
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    options: [
      { flags: "--propose <id>", description: "Ask a decision owner to commit this candidate as an observation (decide --edit may reword it, never change its members)" },
      { flags: "--resume", description: "Commit every observation whose decision was made (or lapse an expired one)" },
      { flags: "--agent", description: "With --propose: the namer member (memory.observeNamer, else default) suggests a name and summary first, in the sandbox tier; approving commits its words, --edit replaces them" },
      { flags: "--sandbox <tier>", description: "With --agent: vm-docker (default) or unhardened" },
      { flags: "--allow-no-sandbox", description: "With --agent: accept running the namer on the host (terminal only)" },
    ],
    handler: observeCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "retro",
    summary: "Record a release's deterministic facts: gate verdicts, applied tasks, review, evals, usage",
    usage: "legion-flow retro [--release <id>]",
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    options: [{ flags: "--release <id>", description: "The release to describe; default the latest" }],
    handler: retroCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "tools",
    summary: "Probe the MCP servers declared in project.json: list their tools with risk classes from their annotations; never calls a tool",
    usage: "legion-flow tools [--server <name>] [--sandbox vm-docker|unhardened] [--allow-no-sandbox]",
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    options: [
      { flags: "--server <name>", description: "Probe one declared server" },
      { flags: "--sandbox <tier>", description: "Where the server runs: vm-docker (default; its image, no network, tree read-only) or unhardened" },
      { flags: "--allow-no-sandbox", description: "Accept running the server on the host (terminal only)" },
    ],
    handler: toolsCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "browse",
    summary: "Dry-run a browser check script against the checkout while writing it (never counts as a check)",
    usage: "legion-flow browse <script.json>",
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    args: "[script]",
    options: [],
    handler: browseCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "recall",
    summary: "Recall what the map and memory say, in authority order (map, deterministic, human, model facts), optionally as of a time",
    usage: 'legion-flow recall ["<text>"] [--subject <ref>] [--predicate <slug>] [--as-of <t>] [--known-at <t>] [--budget <tokens>]',
    humanOnly: false,
    category: "inspection",
    milestone: "M4",
    args: "[query]",
    options: [
      { flags: "--subject <ref>", description: "A typed reference; ending in / or # makes it a prefix; a module also covers its symbols" },
      { flags: "--predicate <slug>", description: "Only facts with this predicate" },
      { flags: "--as-of <t>", description: "World time: facts true at t (valid from <= t < invalid from)" },
      { flags: "--known-at <t>", description: "Record time: what memory held at t, before later decisions" },
      { flags: "--budget <tokens>", description: "Estimated tokens per block (characters / 4); default 800" },
    ],
    handler: recallCommand as CommandEntry["handler"],
  }),
  defineEntry({
    name: "ship",
    summary: "Evaluate the tier's gates into a run of evidence and tri-state verdicts; --commit records a release (Human Authority Gate)",
    usage: 'legion-flow ship [--commit --approver <id>] [--waive "<gateId>: <reason>"]... [--bundle <dir> [--release <id>] [--sign --key <private.pem>]] | ship --verify <dir> [--pubkey <public.pem>]',
    humanOnly: true,
    category: "governance",
    milestone: "M1",
    options: [
      { flags: "--commit", description: "Record a release if every required gate is satisfied or waived (needs --approver)" },
      { flags: "--approver <id>", description: "Decision owner id for --commit and --waive" },
      { flags: "--waive <spec>", description: 'A named exception, "<gateId>: <reason of 24+ chars>", one per --waive (needs --approver)', repeatable: true },
      { flags: "--bundle <dir>", description: "Write a bundle of this evaluation (manifest, records, evidence, audit chain) to a new directory outside the workspace tree" },
      { flags: "--release <id>", description: "With --bundle: re-export a past release's evaluation instead of evaluating now" },
      { flags: "--sign", description: "With --bundle: sign the manifest (Ed25519, DSSE over an in-toto statement); needs --key and --approver, terminal only" },
      { flags: "--key <path>", description: "With --sign: a PKCS8 PEM Ed25519 private key outside the workspace; an encrypted key prompts for its passphrase" },
      { flags: "--verify <dir>", description: "Verify a bundle: integrity, the audit chain, evidence hashes, and the signature; reads nothing else" },
      { flags: "--pubkey <path>", description: "With --verify: the signer's SPKI PEM public key, which must come from outside the bundle" },
    ],
    handler: shipCommand,
  }),
];

export const LEGION_CLI_ONLY_VERBS = [
  "intent",
  "discuss",
  "qa",
  "wiki",
  "ticket",
  "control-mode",
] as const;

export const LEGION_ASCENDED_ONLY_VERBS = [
  "start",
  "build",
  "attest",
  "release",
  "quick",
  "advise",
  "polish",
  "milestone",
  "council",
  "board",
  "portfolio",
  "dev",
] as const;
