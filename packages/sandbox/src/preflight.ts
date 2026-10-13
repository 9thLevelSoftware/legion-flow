import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LegionFlowPaths } from "@9thlevelsoftware/legion-flow-persist";
import type { DockerCli } from "./docker-cli.js";
import { hardeningArgs, runImage, GUEST, type DockerSettings } from "./settings.js";
import { cleanupStale } from "./network.js";

export interface PreflightCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  message: string;
  /** The one-line instruction, starting with "FIX:". */
  fix?: string;
}

export interface PreflightReport {
  tier: string;
  ok: boolean;
  checks: PreflightCheck[];
  /** The human-readable identity: the registry `image@sha256:...` when the image has one, else its local Id. */
  imageDigest?: string;
  /** The local image Id (`sha256:...`) every container of this invocation runs by. */
  imageId?: string;
  /** The uid the probe container reported. */
  probeUid?: string;
}

export interface DockerPreflightInput {
  docker: DockerCli;
  settings: DockerSettings;
  paths: LegionFlowPaths;
  /** The adapters package directory, mounted read-only by the probe to prove that drive is shared too. */
  adaptersDir: string;
  /**
   * Run the probe container (bind-mounts the workspace drive, writes through
   * it, reports its uid). Skipped by doctor, which must not start containers.
   */
  probe: boolean;
  /** When the image is built locally (the agent image), the Dockerfile to write and the FIX to print instead of a pull. */
  imageBuild?: { dockerfile: string; dockerfileDir: string };
  now?: () => Date;
}

const FIX = {
  docker_cli: "FIX: install Docker Desktop and make sure `docker` is on PATH",
  docker_daemon: "FIX: start Docker Desktop (the daemon did not answer)",
  docker_linux_engine: "FIX: switch Docker Desktop to Linux containers",
  docker_image: (image: string) => `FIX: docker pull ${image}`,
  docker_image_build: (image: string, dir: string) => `FIX: docker build -t ${image} "${dir}" (the Dockerfile was written there; building downloads the vendor CLIs once)`,
  docker_image_id: "FIX: check that `docker image inspect` works for this image with the installed Docker client",
  docker_probe: "FIX: the daemon rejected the hardened run or the workspace drive is not shared with Docker Desktop; the probe's stderr follows",
} as const;

/** One inspect for both identities: `<Id>|<first RepoDigest or empty>`. */
export const IMAGE_IDENTITY_FORMAT = "{{.Id}}|{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The checks that need no container: safe for doctor. */
export async function dockerCheapChecks(input: Pick<DockerPreflightInput, "docker" | "settings" | "imageBuild">): Promise<{ checks: PreflightCheck[]; imageDigest?: string; imageId?: string }> {
  const checks: PreflightCheck[] = [];
  const version = await input.docker.run(["version", "--format", "{{.Client.Version}}|{{.Server.Os}}|{{.Server.Version}}"], { timeoutMs: 15_000 });
  if (version.spawnError || version.code === null) {
    checks.push({ id: "docker_cli", status: "fail", message: `the docker client could not be started: ${version.spawnError ?? "no exit code"}`, fix: FIX.docker_cli });
    return { checks };
  }
  const [client, serverOs, server] = version.stdout.trim().split("|");
  checks.push({ id: "docker_cli", status: "pass", message: `docker client ${client || "present"}` });
  if (version.code !== 0 || !server) {
    checks.push({ id: "docker_daemon", status: "fail", message: `the daemon did not answer: ${version.stderr.trim().split("\n")[0] ?? "no response"}`, fix: FIX.docker_daemon });
    return { checks };
  }
  checks.push({ id: "docker_daemon", status: "pass", message: `docker engine ${server}` });
  if (serverOs !== "linux") {
    checks.push({ id: "docker_linux_engine", status: "fail", message: `the engine runs ${serverOs} containers; the hardening set is Linux-only`, fix: FIX.docker_linux_engine });
    return { checks };
  }
  checks.push({ id: "docker_linux_engine", status: "pass", message: "linux engine" });
  // The local Id is what runs (it exists for a locally built image too); a registry image also has a RepoDigest, recorded as the readable identity.
  const inspect = await input.docker.run(["image", "inspect", input.settings.image, "--format", IMAGE_IDENTITY_FORMAT], { timeoutMs: 15_000 });
  if (inspect.code !== 0 || !inspect.stdout.trim()) {
    if (input.imageBuild) {
      await mkdir(input.imageBuild.dockerfileDir, { recursive: true });
      await writeFile(join(input.imageBuild.dockerfileDir, "Dockerfile"), input.imageBuild.dockerfile, "utf8");
      checks.push({ id: "docker_image", status: "fail", message: `agent image ${input.settings.image} is not built; execute never builds on its own`, fix: FIX.docker_image_build(input.settings.image, input.imageBuild.dockerfileDir) });
    } else {
      checks.push({ id: "docker_image", status: "fail", message: `image ${input.settings.image} is not present locally; execute never pulls on its own`, fix: FIX.docker_image(input.settings.image) });
    }
    return { checks };
  }
  const [imageId = "", repoDigest = ""] = inspect.stdout.trim().split("|");
  if (!IMAGE_ID.test(imageId)) {
    checks.push({ id: "docker_image", status: "fail", message: `image ${input.settings.image} is present, but its local Id could not be read (got '${inspect.stdout.trim().slice(0, 120)}'), so the run cannot be pinned to it`, fix: FIX.docker_image_id });
    return { checks };
  }
  const imageDigest = repoDigest || imageId;
  checks.push({ id: "docker_image", status: "pass", message: `image ${input.settings.image} present as ${imageDigest}${repoDigest && repoDigest.split("@")[1] !== imageId ? ` (local Id ${imageId})` : ""}` });
  return { checks, imageDigest, imageId };
}

/**
 * Full preflight for the vm-docker tier. The probe is the check most likely to
 * fail for a real Windows user: it bind-mounts a scratch directory on the
 * workspace drive and the adapters directory, writes a file through the mount,
 * reads it back on the host, and reports the uid it ran as, through `node`.
 */
export async function dockerPreflight(input: DockerPreflightInput): Promise<PreflightReport> {
  const cheap = await dockerCheapChecks(input);
  const checks = [...cheap.checks];
  const failed = () => checks.some((c) => c.status === "fail");
  if (failed() || !input.probe) {
    return { tier: "vm-docker", ok: !failed(), checks, ...(cheap.imageDigest ? { imageDigest: cheap.imageDigest } : {}), ...(cheap.imageId ? { imageId: cheap.imageId } : {}) };
  }

  // The engine lock is per project, not per machine: two projects probing at once must not share a name or a directory.
  const suffix = randomBytes(4).toString("hex");
  const stale = await cleanupStale(input.docker, (input.now ?? (() => new Date()))());
  checks.push({ id: "docker_stale_cleanup", status: "pass", message: stale.removed.length === 0 ? "no stale legion-flow containers or networks" : `removed stale: ${stale.removed.join(", ")}` });
  const probeDir = join(input.paths.sandboxDir, `_probe-${suffix}`);
  await mkdir(probeDir, { recursive: true });
  const name = `lf-probe-${suffix}`;
  const script = 'const fs=require("fs");fs.writeFileSync("/work/probe.txt","probe-ok\\n");fs.readdirSync("/legion/adapters");process.stdout.write(String(process.getuid()))';
  const result = await input.docker.run(
    [...hardeningArgs(input.settings, name), "-v", `${probeDir}:${GUEST.tree}`, "-v", `${input.adaptersDir}:${GUEST.adapters}:ro`, "-w", GUEST.tree, runImage({ ...input.settings, ...(cheap.imageId ? { imageId: cheap.imageId } : {}) }), "node", "-e", script],
    { timeoutMs: 120_000, containerName: name }
  );
  let wrote = "";
  try {
    wrote = await readFile(join(probeDir, "probe.txt"), "utf8");
  } catch {
    // not written
  }
  await rm(probeDir, { recursive: true, force: true });
  if (result.code !== 0 || wrote.trim() !== "probe-ok") {
    checks.push({
      id: "docker_probe",
      status: "fail",
      message: `probe container exit ${result.code ?? result.signal}; file written through the mount: ${wrote.trim() === "probe-ok" ? "yes" : "no"}. ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`,
      fix: FIX.docker_probe,
    });
    return { tier: "vm-docker", ok: false, checks, imageDigest: cheap.imageDigest, imageId: cheap.imageId };
  }
  const probeUid = result.stdout.trim();
  checks.push({ id: "docker_probe", status: "pass", message: `hardened probe ran as uid ${probeUid}, wrote through the workspace mount, saw the adapters mount` });
  return { tier: "vm-docker", ok: true, checks, imageDigest: cheap.imageDigest, imageId: cheap.imageId, probeUid };
}
