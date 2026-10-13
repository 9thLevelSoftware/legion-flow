import type { ProjectConfig } from "@9thlevelsoftware/legion-flow-schema";

export interface DockerSettings {
  image: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  /** "uid:gid" */
  user: string;
  /**
   * The local image Id (`sha256:...`) preflight resolved `image` to. When set,
   * every container runs by it, so a tag moved after preflight cannot change
   * what runs; a vanished image fails with "No such image" and is never pulled.
   */
  imageId?: string;
}

/** What `docker run` names: the pinned Id once preflight resolved one, else the configured image. */
export function runImage(settings: DockerSettings): string {
  return settings.imageId ?? settings.image;
}

export const DEFAULT_DOCKER_IMAGE = "node:22-alpine";

/**
 * Defaults live here, not in the schema, so an upgrade never changes an
 * existing project's config fingerprint. Docker Desktop (win32, darwin) maps
 * bind-mount ownership, so 1000:1000 is right there; on Linux the tree belongs
 * to whoever runs legion-flow.
 */
/** `adapterImage` is what the adapter needs; an explicit `sandbox.docker.image` in the project wins over it. */
export function resolveDockerSettings(config: ProjectConfig["sandbox"] | undefined, platform: NodeJS.Platform = process.platform, adapterImage?: string): DockerSettings {
  const d = config?.docker ?? {};
  const user =
    d.user ??
    (platform === "linux" && typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : "1000:1000");
  return {
    image: d.image ?? adapterImage ?? DEFAULT_DOCKER_IMAGE,
    memory: d.memory ?? "2g",
    cpus: d.cpus ?? 2,
    pidsLimit: d.pidsLimit ?? 512,
    user,
  };
}

/** Guest paths every tier agrees on, so adapters can build argv once. */
export const GUEST = {
  tree: "/work",
  run: "/legion/run",
  adapters: "/legion/adapters",
  plan: "/legion/fake-adapter.json",
  egress: "/legion/egress",
} as const;

/** The exact hardening set (OpenClaw-derived, addendum row 27), before mounts, env names, image, and command. */
export interface HardeningOptions {
  /** "none" (the default) or a per-run internal network. */
  network?: string;
  detach?: boolean;
  labels?: string[];
  /** Keep the container after exit (its logs survive a crash); the caller removes it. */
  keep?: boolean;
}

export function hardeningArgs(settings: DockerSettings, containerName: string, options: HardeningOptions = {}): string[] {
  return [
    "run",
    // Nothing is ever pulled: a missing image is a refusal with a FIX line, not a download.
    "--pull",
    "never",
    ...(options.keep ? [] : ["--rm"]),
    ...(options.detach ? ["-d"] : []),
    ...(options.labels ?? []).flatMap((l) => ["--label", l]),
    "--name",
    containerName,
    "--network",
    options.network ?? "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs",
    "/home/node:rw,nosuid,size=128m,uid=1000,gid=1000",
    "--user",
    settings.user,
    "--pids-limit",
    String(settings.pidsLimit),
    "--memory",
    settings.memory,
    "--cpus",
    String(settings.cpus),
  ];
}

export const containerNameFor = (runId: string) => `lf-${runId}`;
