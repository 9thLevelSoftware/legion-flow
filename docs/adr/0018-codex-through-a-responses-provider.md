# ADR-0018: codex runs against an OpenAI-compatible provider through an explicit Responses provider and a catalog entry Legion writes

**Status:** accepted (M4 slice aa, 2026-10-12) · **Date:** 2026-10-12 · Partly supersedes ADR-0016

## Context

ADR-0016 pointed the `claude` adapter at an Anthropic-compatible provider and refused a provider when `codex` was the default. Xiaomi MiMo also serves an OpenAI-compatible root (`/v1`) speaking the Responses API. MiMo's codex guide configures an explicit provider (`wire_api = "responses"`), turns web search off, and needs a model catalog file marking its models as "Responses lite". MiMo distributes that file as a download. Without the lite flag, codex's custom tools fail, and codex edits files through one, its freeform patch tool.

## Decision

`adapter.http` now applies to the project's **default** adapter when that is `claude` or `codex`. `claude` reads `baseUrl` as an Anthropic-compatible root and `codex` as an OpenAI-compatible one. Another vendor in the same project keeps its own API, because one base URL speaks one protocol. This replaces ADR-0016's "every `claude` member and the reviewer".

For `codex`, `withProvider` adds:

- **Provider overrides.** One-run `-c` overrides name an explicit provider (`legion_provider`): `wire_api=responses`, `env_key=OPENAI_API_KEY`, and `base_url=${OPENAI_BASE_URL}`. The tier fills that root from its constants: the proxy route in a container, the provider's root on the host. The overrides also set `web_search=disabled` and no reasoning summaries, as MiMo's guide does.
- **A catalog entry Legion writes.** It goes to the run directory as `codex-model-catalog.json` and is passed with `-c model_catalog_json`. It holds `use_responses_lite`, the freeform patch tool, three reasoning levels, no experimental tools, no verbosity, and one line of base instructions written by Legion, never codex's built-in text. Its context window is `adapter.http.contextWindow`, or 128,000 when unset. Nothing is downloaded.
- **Auth.** As for `claude`: the container holds the placeholder in `OPENAI_API_KEY` and the proxy sets `Authorization: Bearer` from `apiKeyEnv`. On the host the real value is handed over as `OPENAI_API_KEY` under no other name.
- **A required model.** `adapter.http.model` is required, because the catalog is keyed by it. Without it the run is refused as `adapter_provider_model_required`.

The task prompt now says that "Files allowed" paths are relative to the agent's working directory, the task's tree, never to the prompt file.

## Consequences

- **The catalog format is codex-internal.** Its required fields were found empirically against codex-cli 0.162.0, the version pinned in the agent image, by running the installed codex against a dead loopback provider until it parsed. A codex upgrade can break it. `codex-gateway.test.ts` runs the installed codex, when it is on PATH, against a fake Responses endpoint, with an isolated `CODEX_HOME` and no model request. It checks that codex posts `/v1/responses` with the configured model, the patch tool among its tools, no web-search tool, and the bearer from the renamed variable. In lite mode, codex sends its tools as an `additional_tools` input item rather than a top-level `tools` field.
- **Verified live.** One codex task run on `vm-docker` against MiMo's Token Plan `/v1` endpoint passed: the file was written, the check passed, every egress line named only the provider, and the key's value was in no record. That proves codex speaks Responses to an explicit custom provider through the proxy with the placeholder bearer. Codex's built-in OpenAI provider honouring `OPENAI_BASE_URL` is not exercised by any path in this repository: with a provider set, codex is told to use the explicit one.
- **The prompt fix came from a live run.** On the first live attempt, the model wrote `hello.txt` into the run directory beside the prompt and ran the check there. Legion saw no change and reported `execution_no_changes`. After the prompt wording was clarified, codex and `claude` both passed.
- **Narrower rule.** A `claude` member or reviewer in a project whose default is `codex` or `fake` no longer uses `adapter.http`.
- **Codex sessions stay contained in a container.** There `CODEX_HOME` is the tmpfs home, so no catalog or token touches the user's own `~/.codex`. On the host tier codex uses the user's real `~/.codex`, with `--ignore-user-config` and `--ephemeral` as the only guards; the host-tier test isolates `CODEX_HOME` itself.
- **No reasoning effort is sent.** The catalog entry names three levels but no default, and the captured request carried `reasoning: {"context":"all_turns"}` with no effort, so the provider's own default applies. MiMo's guide sets `model_reasoning_effort = "high"`; that is not set here.
