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
  putStoredPiRuntimeArtifact,
  readStoredPiRuntimeArtifact,
} from "./pi-runtime-store";
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
  /** The ONE agent baked into this artifact. '' before per-agent bundling. */
  agentName: string;
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
  agentName: string,
): string {
  return createHash("sha256")
    .update(
      `${COMPILED_PI_RUNTIME_FORMAT}\0${projectId}\0${ref}\0${sourceSha}\0${workerBundleSha256}\0${agentName}`,
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
  agentName: string,
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
      // An artifact baked for another agent is a MISS, not a reusable hit: it
      // carries that agent's prompt and model.
      (metadata.agentName ?? "") !== agentName ||
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

/**
 * Write a shared-store artifact onto local disk so later boots on THIS replica
 * take the fast path. Returns null when the bytes do not match their recorded
 * digest — a corrupt row must send the caller to a clean recompile, not serve.
 */
async function hydrateFromStore(
  record: { sha256: string; size: number; manifest: Record<string, unknown>; content: Buffer },
  runtimePath: string,
  metadataPath: string,
  key: {
    projectId: string;
    ref: string;
    sourceSha: string;
    agentName: string;
    workerBundleSha256: string;
  },
): Promise<StoredCompiledPiRuntimeArtifact | null> {
  const digest = createHash("sha256").update(record.content).digest("hex");
  if (digest !== record.sha256 || record.content.byteLength !== record.size) return null;
  const staged = `${runtimePath}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(cacheRoot(), { recursive: true });
    await writeFile(staged, record.content, { mode: 0o700 });
    await rename(staged, runtimePath);
    const metadata: CachedPiRuntimeMetadata = {
      format: COMPILED_PI_RUNTIME_FORMAT,
      projectId: key.projectId,
      ref: key.ref,
      sourceSha: key.sourceSha,
      workerBundleSha256: key.workerBundleSha256,
      agentName: key.agentName,
      sha256: record.sha256,
      size: record.size,
      manifest: record.manifest as unknown as CompiledPiRuntimeManifest,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    return {
      path: runtimePath,
      sha256: record.sha256,
      size: record.size,
      sourceSha: key.sourceSha,
      cacheHit: true,
      manifest: metadata.manifest,
    };
  } catch (error) {
    console.warn("[pi-runtime-store] could not hydrate local cache", error);
    return null;
  } finally {
    await rm(staged, { force: true });
  }
}

async function compileArtifact(
  project: GitBackedProject,
  ref: string,
  sourceSha: string,
  workerBundle: PiWorkerBundle,
  runtimePath: string,
  metadataPath: string,
  agentName: string,
  artifactKey: string,
): Promise<StoredCompiledPiRuntimeArtifact> {
  const mirror = await assertExactSource(project, ref, sourceSha);
  const resolved = await resolveCompiledAgentConfigForSession(project, sourceSha);
  const projectDefaultAgent = await resolveDefaultAgentAtSha(mirror, project, sourceSha);
  // ONE artifact, ONE agent. The bundle used to carry the whole agent map and
  // pick at boot, so every worker parsed every agent's prompt to use one of
  // them, and "which agent is this box running?" was answered by an env var
  // rather than by the artifact. Narrow to the requested agent (falling back to
  // the project default) and let the cache key carry it.
  // `resolveCompiledAgentConfigForSession` hands back the SERIALIZED config, so
  // narrowing means parse -> pick -> re-serialize. A config we cannot parse is
  // passed through untouched: a bundle carrying too much still boots, one that
  // fails to compile does not.
  const baked = agentName || projectDefaultAgent || "";
  let agentConfig = resolved;
  if (baked && resolved) {
    try {
      const parsed = JSON.parse(resolved) as { agent?: Record<string, unknown> };
      const one = parsed?.agent?.[baked];
      if (one) agentConfig = JSON.stringify({ ...parsed, agent: { [baked]: one } });
    } catch {
      // keep the full config
    }
  }
  const defaultAgent = baked || projectDefaultAgent;
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
      agentName,
      sha256: artifact.sha256,
      size: artifact.size,
      manifest: artifact.manifest,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    // Publish to the shared store so no other replica — and no boot after the
    // next deploy — has to reach git for this same (project, ref, sha, agent).
    await putStoredPiRuntimeArtifact({
      artifactKey,
      projectId: project.projectId,
      ref,
      sourceSha,
      agentName,
      workerBundleSha256: workerBundle.sha256,
      sha256: artifact.sha256,
      size: artifact.size,
      manifest: artifact.manifest as unknown as Record<string, unknown>,
      content: Buffer.from(artifact.source),
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

/**
 * An agent name is part of a CACHE PATH and of the baked config, so it is
 * validated the same way a ref is rather than trusted from a query string.
 * Empty means "the project default", resolved at compile time.
 */
/**
 * The agent a project boots by default, read from the manifest at `sourceSha`.
 *
 * Exists so the push-time PREBUILD and a session request key the cache the
 * same way. The artifact is keyed per agent now, so a prebuild that baked
 * "whatever the default is" under the empty name would warm an entry no
 * session ever asks for, and every first boot would pay a full compile.
 */
export async function resolvePiDefaultAgentName(
  project: GitBackedProject,
  sourceSha: string,
): Promise<string> {
  const mirror = await refreshMirror(project);
  return (await resolveDefaultAgentAtSha(mirror, project, sourceSha)) ?? "";
}

/**
 * Every agent declared at `sourceSha`, so a push can prebuild one bundle each.
 *
 * The artifact is per-agent now, so prebuilding only the default left every
 * OTHER agent compiling on its first session — the exact "compile on session
 * start" this store exists to remove.
 */
export async function listPiAgentNames(
  project: GitBackedProject,
  sourceSha: string,
): Promise<string[]> {
  const serialized = await resolveCompiledAgentConfigForSession(project, sourceSha);
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as { agent?: Record<string, unknown> };
    return Object.keys(parsed?.agent ?? {});
  } catch {
    return [];
  }
}

export function normalizePiAgentName(input: string | null | undefined): string {
  const value = (input ?? "").trim();
  if (!value) return "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error(`invalid agent name: ${value.slice(0, 64)}`);
  }
  return value;
}

export async function buildCompiledPiRuntimeArtifact(
  project: GitBackedProject,
  refInput: string,
  sourceShaInput: string,
  agentInput?: string | null,
): Promise<StoredCompiledPiRuntimeArtifact> {
  const ref = validateRef(refInput);
  const sourceSha = validateSha(sourceShaInput);
  const agentName = normalizePiAgentName(agentInput);
  const workerBundle = await getPiWorkerBundle();
  const key = artifactKey(project.projectId, ref, sourceSha, workerBundle.sha256, agentName);
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
    agentName,
  );
  if (cached) return cached;

  // Local disk missed. Before recompiling — which needs git — ask the shared
  // store. This is the whole point of it: a deploy wipes the container's cache,
  // and a boot must not depend on the upstream being reachable.
  const shared = await readStoredPiRuntimeArtifact(key);
  if (shared) {
    const hydrated = await hydrateFromStore(
      shared,
      runtimePath,
      metadataPath,
      { projectId: project.projectId, ref, sourceSha, agentName, workerBundleSha256: workerBundle.sha256 },
    );
    if (hydrated) return hydrated;
  }

  const active = builds.get(key);
  if (active) return active;
  const build = compileArtifact(
    project,
    ref,
    sourceSha,
    workerBundle,
    runtimePath,
    metadataPath,
    agentName,
    key,
  ).finally(() => {
    builds.delete(key);
  });
  builds.set(key, build);
  return build;
}

export function __clearCompiledPiRuntimeBuildsForTests(): void {
  builds.clear();
}
