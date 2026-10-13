# ADR-0015: Preflighted containers run by the local image Id that preflight resolved, and no container pulls

**Status:** accepted (M4 slice x, 2026-10-12) · **Date:** 2026-10-12

## Context

The report's `vm-docker` row and addendum row 27 ask for a pinned image digest. Until this slice every container was named by tag. Preflight recorded the resolved `image@sha256` as evidence, but `docker run` still took the tag. That left two gaps. A tag moved after preflight (a rebuild, a pull in another shell) changed what ran without the evidence saying so. And a `docker run` by tag pulls a missing image, so the paths without a preflight (language servers, MCP servers, the tool gateway's servers, the browser container) could download an image on their own.

## Decision

Preflight's one `docker image inspect` reads `{{.Id}}|{{first RepoDigest}}`. The local Id (`sha256:...`) is what every container of that invocation runs by: the probe, the agent, the egress proxy, each coordinate step, and each `--retry` attempt. The registry digest, or the Id for a locally built image such as the agent image, stays on the preflight report as `imageDigest`, the readable identity. Both travel in the run's `sandbox_tier` evidence next to the configured tag, and the exact argv with the Id is on each `adapter_outcome`. An Id that cannot be read fails the `docker_image` check, so a run is never left unpinned silently.

Every hardened `docker run` now carries `--pull never`. A pinned image removed after preflight makes Docker exit 125 with "No such image"; the Docker exec turns that into a spawn error naming the tag and the Id, so the run fails as `adapter_failed` with a readable reason.

The local Id rather than the registry digest is what runs, because it exists for a locally built image with no registry digest, and it names what is on this engine. Running by Id and refusing a missing Id with `--pull never` were verified on Docker Desktop on Windows, whose image store reports an Id equal to the manifest digest. Other storage backends are not verified.

## Consequences

- The pin holds for one invocation. A later `execute --resume` preflights again and runs whatever the tag names then. Each spawn's `adapter_outcome` argv is the record of what actually ran.
- Session images (`map.languageServers[].image`, `mcpServers[].image`, the browser image, and the browser's proxy) are not preflighted and still run by tag. With `--pull never` a missing one now fails instead of downloading. That is a behavior change: before this slice they pulled silently. Observed with `tools` and an absent image: the probe is `blocked` with Docker's own "No such image" in its message, and nothing is fetched. The doctor checks already print the `FIX: docker pull` line.
- `project.json` `sandbox.docker.image` still names a tag. No schema field changed, so no config fingerprint moved.
- `--pull never` is accepted by the installed Docker client (29.x); older clients were not tested.
- `execute --retry` against a vanished pinned image spends every attempt on the same Id, each failing fast with its own evidence.
