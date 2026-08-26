import { createHash } from "node:crypto";
import { manifestCandidatePaths, parseManifestText } from "@kortix/manifest-schema";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCompiledAgentConfigForSession } from "../projects/lib/compile-agent-config";
import { validateRef, validateSha } from "../projects/git-ref";
import { refreshMirror, runGit, runGitCapture, spawn } from "../projects/git/mirror";
import type { GitBackedProject } from "../projects/git/types";
import {
  getCompiledAgentBundle,
  type CompiledAgentBundle,
} from "./compiled-agent-bundle";
import {
  COMPILED_RUNTIME_FORMAT,
  compileOpenCodeRuntime,
  type CompiledRuntimeManifest,
} from "./compiled-runtime";

export interface StoredCompiledRuntimeArtifact {
  path: string;
  sha256: string;
  size: number;
  sourceSha: string;
  cacheHit: boolean;
  manifest: CompiledRuntimeManifest;
}

interface CachedRuntimeMetadata {
  format: typeof COMPILED_RUNTIME_FORMAT;
  projectId: string;
  ref: string;
  sourceSha: string;
  agentBundleSha256: string;
  sha256: string;
  size: number;
  manifest: CompiledRuntimeManifest;
}

const builds = new Map<string, Promise<StoredCompiledRuntimeArtifact>>();
const MANIFEST_MARKER = "// kortix-manifest-base64url:";
const DEFAULT_OPENCODE_CONFIG_DIR = ".kortix/opencode";
const MAX_OPENCODE_CONFIG_ARCHIVE_BYTES = 4 * 1024 * 1024;

export class CompiledRuntimeSourceMovedError extends Error {
  constructor(expectedSha: string, actualSha: string) {
    super(
      `compiled runtime source moved: expected ${expectedSha}, got ${actualSha}`,
    );
    this.name = "CompiledRuntimeSourceMovedError";
  }
}

function cacheRoot(): string {
  return (
    process.env.KORTIX_COMPILED_BOOT_CACHE_DIR || "/tmp/kortix/compiled-boot"
  );
}

function artifactKey(
  projectId: string,
  ref: string,
  sourceSha: string,
  agentBundleSha256: string,
): string {
  return createHash("sha256")
    .update(
      `${COMPILED_RUNTIME_FORMAT}\0${projectId}\0${ref}\0${sourceSha}\0${agentBundleSha256}`,
    )
    .digest("hex");
}

function readEmbeddedManifest(source: Buffer): CompiledRuntimeManifest | null {
  const marker = source
    .toString("utf8")
    .split("\n", 4)
    .find((line) => line.startsWith(MANIFEST_MARKER));
  if (!marker) return null;
  try {
    const encoded = marker.slice(MANIFEST_MARKER.length).trim();
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    return JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as CompiledRuntimeManifest;
  } catch {
    return null;
  }
}

async function assertExactSource(
  project: GitBackedProject,
  ref: string,
  sourceSha: string,
): Promise<string> {
  let mirror = await refreshMirror(project);
  let actualSha = (
    await runGit(["rev-parse", "--verify", `${ref}^{commit}`], mirror, false)
  ).stdout.trim();
  if (actualSha !== sourceSha) {
    mirror = await refreshMirror(project, true);
    actualSha = (
      await runGit(["rev-parse", "--verify", `${ref}^{commit}`], mirror, false)
    ).stdout.trim();
  }
  if (actualSha !== sourceSha)
    throw new CompiledRuntimeSourceMovedError(sourceSha, actualSha);
  return mirror;
}

function safeConfigDir(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("-")) return null;
  if (
    trimmed
      .split("/")
      .some((part) => !part || part === "." || part === ".." || !/^[\w .-]+$/.test(part))
  ) return null;
  return trimmed;
}

async function resolveOpencodeConfigDirAtSha(
  mirror: string,
  project: GitBackedProject,
  sourceSha: string,
): Promise<string | null> {
  let configDir = DEFAULT_OPENCODE_CONFIG_DIR;
  for (const candidate of manifestCandidatePaths(project.manifestPath)) {
    const manifest = await runGitCapture(["show", `${sourceSha}:${candidate.path}`], mirror);
    if (manifest.exitCode !== 0) continue;
    const parsed = parseManifestText(manifest.stdout, candidate.format);
    const opencode = parsed.opencode;
    if (opencode && typeof opencode === "object" && !Array.isArray(opencode)) {
      configDir = safeConfigDir((opencode as Record<string, unknown>).config_dir) ?? configDir;
    }
    break;
  }
  for (const filename of ["opencode.jsonc", "opencode.json"]) {
    const exists = await runGitCapture(
      ["cat-file", "-e", `${sourceSha}:${configDir}/${filename}`],
      mirror,
    );
    if (exists.exitCode === 0) return configDir;
  }
  return null;
}

async function archiveOpencodeConfig(
  mirror: string,
  sourceSha: string,
  configDir: string,
): Promise<Buffer> {
  const child = spawn("git", ["archive", "--format=tar.gz", `${sourceSha}:${configDir}`], {
    cwd: mirror,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OPENCODE_CONFIG_ARCHIVE_BYTES) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (size > MAX_OPENCODE_CONFIG_ARCHIVE_BYTES) {
    throw new Error(`OpenCode config archive exceeds ${MAX_OPENCODE_CONFIG_ARCHIVE_BYTES} bytes`);
  }
  if (exitCode !== 0) {
    throw new Error(`OpenCode config archive failed: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return Buffer.concat(stdout);
}

async function readCachedArtifact(
  runtimePath: string,
  metadataPath: string,
  projectId: string,
  ref: string,
  sourceSha: string,
  agentBundleSha256: string,
): Promise<StoredCompiledRuntimeArtifact | null> {
  try {
    const metadata = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as CachedRuntimeMetadata;
    const source = await readFile(runtimePath);
    const runtime = await stat(runtimePath);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const embeddedManifest = readEmbeddedManifest(source);
    if (
      metadata.format !== COMPILED_RUNTIME_FORMAT ||
      metadata.projectId !== projectId ||
      metadata.ref !== ref ||
      metadata.sourceSha !== sourceSha ||
      metadata.agentBundleSha256 !== agentBundleSha256 ||
      metadata.size !== runtime.size ||
      metadata.sha256 !== sha256 ||
      JSON.stringify(embeddedManifest) !== JSON.stringify(metadata.manifest) ||
      runtime.size <= 0
    ) {
      return null;
    }
    return {
      path: runtimePath,
      sha256,
      size: runtime.size,
      sourceSha,
      cacheHit: true,
      manifest: metadata.manifest,
    };
  } catch {
    return null;
  }
}

async function compileArtifact(
  project: GitBackedProject,
  ref: string,
  sourceSha: string,
  agentBundle: CompiledAgentBundle,
  runtimePath: string,
  metadataPath: string,
): Promise<StoredCompiledRuntimeArtifact> {
  const mirror = await assertExactSource(project, ref, sourceSha);
  const agentConfig = await resolveCompiledAgentConfigForSession(
    project,
    sourceSha,
  );
  const opencodeConfigDir = await resolveOpencodeConfigDirAtSha(mirror, project, sourceSha);
  const opencodeConfigArchive = opencodeConfigDir
    ? await archiveOpencodeConfig(mirror, sourceSha, opencodeConfigDir)
    : null;
  const artifact = compileOpenCodeRuntime({
    projectId: project.projectId,
    ref,
    sourceSha,
    agentConfig,
    agentBundle: agentBundle.source,
    opencodeConfigDir,
    opencodeConfigArchiveBase64: opencodeConfigArchive?.toString("base64") ?? null,
  });
  const stagedPath = `${runtimePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(stagedPath, artifact.source, { mode: 0o700 });
    await rename(stagedPath, runtimePath);
    const metadata: CachedRuntimeMetadata = {
      format: COMPILED_RUNTIME_FORMAT,
      projectId: project.projectId,
      ref,
      sourceSha,
      agentBundleSha256: agentBundle.sha256,
      sha256: artifact.sha256,
      size: artifact.size,
      manifest: artifact.manifest,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, {
      mode: 0o600,
    });
    return {
      path: runtimePath,
      sha256: artifact.sha256,
      size: artifact.size,
      sourceSha,
      cacheHit: false,
      manifest: artifact.manifest,
    };
  } finally {
    await rm(stagedPath, { force: true });
  }
}

export async function buildCompiledRuntimeArtifact(
  project: GitBackedProject,
  refInput: string,
  sourceShaInput: string,
): Promise<StoredCompiledRuntimeArtifact> {
  const ref = validateRef(refInput);
  const sourceSha = validateSha(sourceShaInput);
  const agentBundle = await getCompiledAgentBundle();
  const key = artifactKey(project.projectId, ref, sourceSha, agentBundle.sha256);
  await mkdir(cacheRoot(), { recursive: true });
  const runtimePath = join(cacheRoot(), `${key}.server.mjs`);
  const metadataPath = join(cacheRoot(), `${key}.runtime.json`);
  const cached = await readCachedArtifact(
    runtimePath,
    metadataPath,
    project.projectId,
    ref,
    sourceSha,
    agentBundle.sha256,
  );
  if (cached) return cached;

  const active = builds.get(key);
  if (active) return active;
  const build = compileArtifact(
    project,
    ref,
    sourceSha,
    agentBundle,
    runtimePath,
    metadataPath,
  ).finally(() => {
    builds.delete(key);
  });
  builds.set(key, build);
  return build;
}

export function __clearCompiledRuntimeBuildsForTests(): void {
  builds.clear();
}
