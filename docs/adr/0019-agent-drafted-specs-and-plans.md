# ADR-0019: Specs and plans can be drafted by the project's own agent; Legion validates and writes them, and a human still approves

**Status:** accepted (2026-10-12) · **Date:** 2026-10-12

## Context

Until now the only way to write a spec or a plan was to edit `spec.json`, `SPEC.md`, and `plan.json` by hand, or to have a host agent (Claude Code with the Agent Skill) do it. A person using the CLI alone had to write JSON. The README made that look like the normal path.

## Decision

`spec --draft "<request>"` and `plan --draft ["<guidance>"]` run the project's default adapter in the sandbox tier, on a disposable copy of the checkout with the current spec (and plan) placed into it. The agent answers with one JSON document in its run directory: `{ title, intent, acceptanceCriteria, outOfScope? }` for a spec, or `{ tasks, checks? }` for a plan. Legion parses that answer, unwrapping a fenced code block, validates it against the real schemas, and writes the files itself. The agent never writes into `.legion-flow/`.

- **Which phase.** `spec --draft` creates the spec at `initialized` and rewrites the same draft (same id and directory) at `spec_draft`. `plan --draft` does the same at `spec_frozen` and `planning`. Any approved spec or plan is refused (`draft_phase`), because rewriting it would invalidate its approval.
- **What a drafted task may carry.** Only `id`, `title`, `acceptanceIds`, `dependsOn`, and the file contract (`filesAllowed`, `verificationCommands`). Tools, browser and web access, members, and coordinate steps widen what an agent can later do, so they are stripped from the answer with a named warning (`draft_fields_stripped`). A human adds them by hand. Any other unknown key, such as a drafted `contract.maxFilesTouched`, is dropped without a warning; the contract's other fields take their schema defaults.
- **Drafted checks.** A plan's checks run on the host once a human approves the plan, so the envelope lists them verbatim with that warning (`draft_checks`), flags any check `approve plan` would refuse (`draft_check_refused`), and flags a whole-tree contract (`draft_whole_tree`). The drafter's suggested approval checks are only a diagnostic (`draft_suggested_checks`), never the next action, because `next` prints that bare and people paste it.
- **Validation.** `validatePlanAgainstSpec` runs on the drafted plan, and its findings are shown as warnings saying `approve plan` will refuse them until fixed. An unusable answer is refused (`draft_invalid`) and nothing is written. The raw answer is kept as `draft_output` evidence either way.
- **Provenance.** `SPEC.md` opens with the adapter, model, run, and request that drafted it. The envelope wraps drafted titles, criteria, and checks in `<untrusted-content source="drafter">`. Drafts are labelled agent-written and unverified; once approved, they are the decision owner's.
- **Recording.** Both workflows (`draft_spec`, `draft_plan`) are non-lifecycle runs and never set the phase. Each appends a `spec_drafted` or `plan_drafted` audit event. The spawn kind is `drafter`, so `sandbox.require` applies.

## Consequences

- **Verified live.** One draft-to-ship run on `vm-docker` through `claude` and an Anthropic-compatible provider (MiMo) passed: `spec --draft` (about 70 s) produced three precise criteria, `plan --draft` (about 62 s) produced one task with a one-file contract and the repository's existing check, and `execute` applied it (about 37 s). The key's value was in no file and the only egress host was the provider.
- **More approval, not less.** Drafting removes the JSON writing, not the human review. The README now leads with this loop and keeps hand-editing as an appendix for use without a model.
- **Agents may draft.** `spec --draft` and `plan --draft` are allowed to host agents; approving remains human-only.
- **Envelope.** The drafting envelopes do not repeat the `sandbox_tier` and `adapter_provider` lines that `execute` prints; the run's evidence holds both, and the `spec_drafted` and `plan_drafted` messages name the adapter and model.
- **Scope.** A rewritten draft makes any earlier challenge round stale, and the envelope says so. Drafting is one-shot: there is no resume for an interrupted drafting run; running `--draft` again is the recovery.
