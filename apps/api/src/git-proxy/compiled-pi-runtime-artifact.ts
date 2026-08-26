/**
 * Build-and-cache for compiled pi runtime artifacts — the `engine: 'pi'`
 * sibling of ./compiled-runtime-artifact.ts, sharing its shape deliberately:
 * same cache root, same staged-write + atomic-rename discipline, same
 * single-flight map, same "the ref must still point at the requested sha"
 * verification. Distinct format string and file suffixes keep the two artifact
 * kinds from ever colliding in the shared cache directory.
 *
 * Smaller than the opencode builder on purpose: a pi artifact has no config-dir
 * archive to extract at boot — the compiled agent config rides inside the
 * artifact itself (see compiled-pi-runtime.ts).
 */
import { createHash } from "node:crypto";
import { manifestCandidatePaths, parseManifestText } from "@kortix/manifest-schema";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCompiledAgentConfigForSession } from "../projects/lib/compile-agent-config";
import { validateRef, validateSha } from "../projects/git-ref";
import { refreshMirror, runGit, runGitCapture } from "../projects/git/mirror";
import type { GitBackedProject } from "../projects/git/types";
import { getPiWorkerBundle, type PiWorkerBundle } from "./pi-worker-bundle";
import {
  COMPILED_PI_RUNTIME_FORMAT,
  compilePiRuntime,
  type CompiledPiRuntimeManifest,
} from "./compiled-pi-runtime";

export interface StoredCompiledPiRuntimeArtifact {
  path: string;
  sha256: string;
  size: number;
  sourceSha: string;
  cacheHit: boolean;
  manifest: CompiledPiRuntimeManifest;
}

interface CachedPiRuntimeMetadata {
  format: typeof COMPILED_PI_RUNTIME_FORMAT;
  projectId: string;
  ref: string;
  sourceSha: string;
  workerBundleSha256: string;
  sha256: string;
  size: number;
  manifest: CompiledPiRuntimeManifest;
}

const builds = new Map<string, Promise<StoredCompiledPiRuntimeArtifact>>();
const MANIFEST_MARKER = "// kortix-manifest-base64url:";

export class CompiledPiRuntimeSourceMovedError extends Error {
  constructor(expectedSha: string, actualSha: string) {
    super(`compiled pi runtime source moved: expected ${expectedSha}, got ${actualSha}`);
    this.name = "CompiledPiRuntimeSourceMovedError";
  }
}

function cacheRoot(): string {
  return process.env.KORTIX_COMPILED_BOOT_CACHE_DIR || "/tmp/kortix/compiled-boot";
}

function artifactKey(
  projectId: string,
  ref: string,
  sourceSha: string,
  workerBundleSha256: string,
): string {
  return createHash("sha256")
    .update(
      `${COMPILED_PI_RUNTIME_FORMAT}\0${projectId}\0${ref}\0${sourceSha}\0${workerBundleSha256}`,
    )
    .digest("hex");
}

function readEmbeddedManifest(source: Buffer): CompiledPiRuntimeManifest | null {
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
    ) as CompiledPiRuntimeManifest;
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
    throw new CompiledPiRuntimeSourceMovedError(sourceSha, actualSha);
  return mirror;
}

/** `default_agent` from the manifest at the exact compiled sha, or null. */
async function resolveDefaultAgentAtSha(
  mirror: string,
  project: GitBackedProject,
  sourceSha: string,
): Promise<string | null> {
  for (const candidate of manifestCandidatePaths(project.manifestPath)) {
    const manifest = await runGitCapture(["show", `${sourceSha}:${candidate.path}`], mirror);
    if (manifest.exitCode !== 0) continue;
    try {
      const parsed = parseManifestText(manifest.stdout, candidate.format);
      const value = (parsed as Record<string, unknown>).default_agent;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readCachedArtifact(
  runtimePath: string,
  metadataPath: string,
  projectId: string,
  ref: string,
  sourceSha: string,
  workerBundleSha256: string,
): Promise<StoredCompiledPiRuntimeArtifact | null> {
  try {
    const metadata = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as CachedPiRuntimeMetadata;
    const source = await readFile(runtimePath);
    const runtime = await stat(runtimePath);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const embeddedManifest = readEmbeddedManifest(source);
    if (
      metadata.format !== COMPILED_PI_RUNTIME_FORMAT ||
      metadata.projectId !== projectId ||
      metadata.ref !== ref ||
      metadata.sourceSha !== sourceSha ||
      metadata.workerBundleSha256 !== workerBundleSha256 ||
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
  workerBundle: PiWorkerBundle,
  runtimePath: string,
  metadataPath: string,
): Promise<StoredCompiledPiRuntimeArtifact> {
  const mirror = await assertExactSource(project, ref, sourceSha);
  const agentConfig = await resolveCompiledAgentConfigForSession(project, sourceSha);
  const defaultAgent = await resolveDefaultAgentAtSha(mirror, project, sourceSha);
  const artifact = compilePiRuntime({
    projectId: project.projectId,
    ref,
    sourceSha,
    agentConfig,
    defaultAgent,
    workerBundle: workerBundle.source,
  });
  const stagedPath = `${runtimePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(stagedPath, artifact.source, { mode: 0o700 });
    await rename(stagedPath, runtimePath);
    const metadata: CachedPiRuntimeMetadata = {
      format: COMPILED_PI_RUNTIME_FORMAT,
      projectId: project.projectId,
      ref,
      sourceSha,
      workerBundleSha256: workerBundle.sha256,
      sha256: artifact.sha256,
      size: artifact.size,
      manifest: artifact.manifest,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
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

export async function buildCompiledPiRuntimeArtifact(
  project: GitBackedProject,
  refInput: string,
  sourceShaInput: string,
): Promise<StoredCompiledPiRuntimeArtifact> {
  const ref = validateRef(refInput);
  const sourceSha = validateSha(sourceShaInput);
  const workerBundle = await getPiWorkerBundle();
  const key = artifactKey(project.projectId, ref, sourceSha, workerBundle.sha256);
  await mkdir(cacheRoot(), { recursive: true });
  const runtimePath = join(cacheRoot(), `${key}.pi-worker.mjs`);
  const metadataPath = join(cacheRoot(), `${key}.pi-runtime.json`);
  const cached = await readCachedArtifact(
    runtimePath,
    metadataPath,
    project.projectId,
    ref,
    sourceSha,
    workerBundle.sha256,
  );
  if (cached) return cached;

  const active = builds.get(key);
  if (active) return active;
  const build = compileArtifact(
    project,
    ref,
    sourceSha,
    workerBundle,
    runtimePath,
    metadataPath,
  ).finally(() => {
    builds.delete(key);
  });
  builds.set(key, build);
  return build;
}

export function __clearCompiledPiRuntimeBuildsForTests(): void {
  builds.clear();
}
