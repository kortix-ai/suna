/**
 * Sandbox template service.
 *
 * The durable identity for "what kind of sandbox a session can boot from."
 * Templates live in `kortix.sandbox_templates`. The platform default is a
 * shared row (project_id NULL, is_shared=true) that any project can boot
 * from. Custom templates can be defined either in `kortix.yaml` (synced to
 * the DB on first read for a project) or directly via the UI/CRUD API.
 *
 * Provider-agnostic: each template carries the provider of its most recent
 * successful build; the matching Daytona, Platinum, or E2B adapter is resolved
 * through the shared provider registry.
 */

import { and, eq, ne, or } from 'drizzle-orm';
import { sandboxTemplates, projects } from '@kortix/db';
type DbSandboxTemplate = typeof sandboxTemplates.$inferSelect;
import { db } from '../shared/db';
import { DEFAULT_CPU, DEFAULT_DISK_GB, DEFAULT_MEMORY_GB } from './build-context';
import { isWarmBuildSlug, templateSlugFromBuildSlug } from './build-slug';
import { metadataMerge } from '../projects/lib/metadata-merge';
import { isReapableTemplatePredecessor } from './predecessor-reap-policy';
import { readManifest } from '../projects/triggers';
import { resolveCommitSha, readRepoFile, type GitBackedProject } from '../projects/git';
import { config } from '../config';
import {
  buildDefaultSandboxTemplate,
  DEFAULT_SANDBOX_SLUG,
  extractSandboxDefault,
  extractSandboxTemplates,
  normalizeUserDockerfileForSnapshot,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  SANDBOX_SPEC_LIMITS,
} from './dockerfile-layer';
import { computeSnapshotHash } from './hash';
import {
  currentRuntimeArtifactFingerprint,
  currentNonAgentRuntimeFingerprint,
} from './template-runtime-fingerprint';
export {
  currentRuntimeArtifactFingerprint,
  currentNonAgentRuntimeFingerprint,
  RUNTIME_ARTIFACTS,
} from './template-runtime-fingerprint';
import { getSandboxProvider } from './providers';
import { BoundedMap } from '../shared/bounded-map';

/** Pretty resolved view used by both the boot path and the UI. */
export interface ResolvedTemplate {
  templateId: string | null; // null only for a synthesized platform default
  projectId: string | null;
  slug: string;
  name: string;
  isShared: boolean;
  source: 'platform' | 'toml' | 'ui';
  provider: string;
  image: string | null;
  dockerfilePath: string | null;
  entrypoint: string | null;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  /** kortix.yaml `container_runtime: true` — the sandbox runs Docker. */
  containerRuntime: boolean;
  /** Live provider state — refreshed by the caller on demand. */
  providerState: string;
  providerSnapshotName: string | null;
  contentHash: string | null;
  /** Git commit the last successful build read the Dockerfile from. */
  builtFromCommit: string | null;
  /**
   * Agent-swap eligibility key of the last build (user image + spec + non-agent
   * runtime). null for rows built before this column existed → no swap (rebuild).
   */
  swapKey: string | null;
}

/**
 * List every template available to a project: the platform-shared default(s)
 * plus this project's own templates. Order: platform default first, then
 * project templates by creation order.
 *
 * Side effect: TOML-declared `[[sandbox.templates]]` entries are upserted into the DB
 * here, so the canonical list lives in the DB after a single read.
 */
/**
 * Per-project throttle on TOML → DB sync. The manifest doesn't change between
 * sessions of the same boot burst, so re-reading it (a git mirror fetch) on
 * every session boot is pure dead time. We refresh at most once per
 * TOML_SYNC_TTL_MS per project. Force-bypass with `forceTomlSync: true` after
 * a manifest mutation (CR merge handles its own reconciliation).
 */
const TOML_SYNC_TTL_MS = 60_000;
const tomlSyncCache = new BoundedMap<string, number>(2_000);

/**
 * Per-project cache of the resolved template list. Burst session-boot scenarios
 * (e.g. dashboard opening N sessions back-to-back) hit the templates table
 * with the same query each time; even at ~5-15ms per round-trip, caching
 * for a few seconds shaves time off the hot path without risking staleness
 * (templates only change via CRUD which already invalidates).
 */
const TEMPLATE_LIST_TTL_MS = 5_000;
const templateListCache = new BoundedMap<string, { at: number; value: ResolvedTemplate[] }>(500);

/** Invalidate the in-memory template list cache for a project. Called from
 *  the CRUD endpoints after a create / update / delete. */
export function invalidateTemplateCache(projectId: string): void {
  templateListCache.delete(projectId);
}

export async function listTemplatesForProject(
  project: GitBackedProject,
  opts: { forceTomlSync?: boolean } = {},
): Promise<ResolvedTemplate[]> {
  // Burst-cache: hot reads return without touching the DB.
  if (!opts.forceTomlSync) {
    const cached = templateListCache.get(project.projectId);
    if (cached && Date.now() - cached.at < TEMPLATE_LIST_TTL_MS) {
      return cached.value;
    }
  }

  const last = tomlSyncCache.get(project.projectId) ?? 0;
  if (opts.forceTomlSync || Date.now() - last > TOML_SYNC_TTL_MS) {
    await syncManifestTemplatesForProject(project);
    tomlSyncCache.set(project.projectId, Date.now());
  }

  const rows = await db
    .select()
    .from(sandboxTemplates)
    .where(or(eq(sandboxTemplates.projectId, project.projectId), eq(sandboxTemplates.isShared, true)));

  if (rows.length === 0) {
    // No DB rows at all — synthesize a platform default so the system still
    // works before migrations seed one.
    const value = [synthesizedDefault()];
    templateListCache.set(project.projectId, { at: Date.now(), value });
    return value;
  }

  // Project-scoped rows SHADOW shared rows with the same slug. So if a project
  // defines its own `[[sandbox.templates]]` entry with slug
  // "default", that wins over the platform default. Otherwise the platform's
  // shared row is the project's default.
  const projectSlugs = new Set(rows.filter((r) => !r.isShared).map((r) => r.slug));
  const deduped = rows.filter((r) => !r.isShared || !projectSlugs.has(r.slug));

  // Sort: shared (platform default) first, then project templates by createdAt.
  deduped.sort((a, b) => {
    if (a.isShared && !b.isShared) return -1;
    if (!a.isShared && b.isShared) return 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const value = deduped.map(rowToResolved);
  templateListCache.set(project.projectId, { at: Date.now(), value });
  return value;
}

/**
 * A slug that resolves to no template. Typed so callers can answer 404 instead of
 * folding a client mistake into a generic 502 alongside real provider failures.
 */
export class TemplateNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`No sandbox template with slug "${slug}" in this project.`);
    this.name = 'TemplateNotFoundError';
  }
}

/** Resolve a slug → ResolvedTemplate. Throws TemplateNotFoundError if slug missing. */
export async function resolveTemplateBySlug(
  project: GitBackedProject,
  slug: string | undefined,
): Promise<ResolvedTemplate> {
  const target = (slug ?? '').trim() || DEFAULT_SANDBOX_SLUG;

  // Fast path for the platform default — the overwhelming majority of boots.
  // The default template's identity is a constant (PLATFORM_DEFAULT_USER_DOCKERFILE),
  // so it does NOT depend on the project's kortix.yaml. `listTemplatesForProject`
  // would run `syncManifestTemplatesForProject` → `readManifest` → a host-side git
  // fetch of the repo (15-30s cold) on every boot once the 60s TTL lapses — and
  // boots are minutes apart, so it lapses every time. Slug "default" is reserved
  // (the manifest sync skips it and the manifest schema forbids it), so a project
  // can never shadow it: the shared row is always the answer. Resolve it from the
  // DB directly and skip the git fetch entirely.
  if (target === DEFAULT_SANDBOX_SLUG) {
    return resolveDefaultTemplate();
  }

  const items = await listTemplatesForProject(project);
  const match = items.find((t) => t.slug === target);
  if (match) return match;
  throw new TemplateNotFoundError(target);
}

/**
 * Resolve a slug that may have come from a BUILD LOG rather than a template.
 *
 * The warm bake records its build under `<template>-warm`, which is not a template
 * (see WARM_BUILD_SLUG_SUFFIX). Every surface that hands a `latest_failure.slug` /
 * `latest_build.slug` back to the API — Retry build, Fix with agent — lands here.
 * Resolving the slug verbatim FIRST keeps a project that legitimately declares a
 * template named `foo-warm` working; only when that misses do we treat the `-warm`
 * as the derived-bake marker it usually is.
 */
export async function resolveTemplateForBuildSlug(
  project: GitBackedProject,
  slug: string | undefined,
): Promise<ResolvedTemplate> {
  try {
    return await resolveTemplateBySlug(project, slug);
  } catch (err) {
    if (err instanceof TemplateNotFoundError && slug && isWarmBuildSlug(slug)) {
      return resolveTemplateBySlug(project, templateSlugFromBuildSlug(slug));
    }
    throw err;
  }
}

/**
 * Resolve the platform-shared default template — project-independent. The
 * default's identity is a constant (PLATFORM_DEFAULT_USER_DOCKERFILE), so it
 * needs no project, no manifest, and no git fetch. Used by the session-boot
 * fast path and the startup pre-build that mints the global default image.
 */
export async function resolveDefaultTemplate(): Promise<ResolvedTemplate> {
  const [shared] = await db
    .select()
    .from(sandboxTemplates)
    .where(and(eq(sandboxTemplates.slug, DEFAULT_SANDBOX_SLUG), eq(sandboxTemplates.isShared, true)))
    .limit(1);
  return shared ? rowToResolved(shared) : synthesizedDefault();
}

export async function getTemplateById(templateId: string): Promise<DbSandboxTemplate | null> {
  const [row] = await db
    .select()
    .from(sandboxTemplates)
    .where(eq(sandboxTemplates.templateId, templateId))
    .limit(1);
  return row ?? null;
}

export interface CreateTemplateInput {
  projectId: string;
  accountId: string;
  slug: string;
  name?: string;
  image?: string;
  dockerfilePath?: string;
  entrypoint?: string;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  source?: 'toml' | 'ui';
}

/** Insert a new project-scoped template. Slug must be unique per project. */
export async function createTemplate(input: CreateTemplateInput): Promise<DbSandboxTemplate> {
  validateTemplateMutation(input);
  const [row] = await db
    .insert(sandboxTemplates)
    .values({
      projectId: input.projectId,
      accountId: input.accountId,
      slug: input.slug,
      name: input.name || input.slug,
      isShared: false,
      source: input.source ?? 'ui',
      provider: 'daytona',
      image: input.image ?? null,
      dockerfilePath: input.dockerfilePath ?? null,
      entrypoint: input.entrypoint ?? null,
      cpu: clamp(input.cpu, SANDBOX_SPEC_LIMITS.cpu),
      memoryGb: clamp(input.memoryGb, SANDBOX_SPEC_LIMITS.memory),
      diskGb: clamp(input.diskGb, SANDBOX_SPEC_LIMITS.disk),
      providerState: 'missing',
    })
    .returning();
  invalidateTemplateCache(input.projectId);
  return row;
}

export interface UpdateTemplateInput {
  name?: string;
  image?: string | null;
  dockerfilePath?: string | null;
  entrypoint?: string | null;
  cpu?: number | null;
  memoryGb?: number | null;
  diskGb?: number | null;
}

/** Patch a template by id. When `expectProjectId` is given, the row must belong
 *  to that project or the update is refused (returns null) — a data-layer guard
 *  against cross-tenant mutation so callers can't poison another project's
 *  template by id even if a handler-level ownership check is missing. */
export async function updateTemplate(
  templateId: string,
  patch: UpdateTemplateInput,
  expectProjectId?: string,
): Promise<DbSandboxTemplate | null> {
  const row = await getTemplateById(templateId);
  if (!row) return null;
  if (expectProjectId !== undefined && row.projectId !== expectProjectId) return null;
  if (row.isShared) {
    throw new Error('Shared platform templates are read-only.');
  }
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name || row.slug;
  if (patch.image !== undefined) next.image = patch.image;
  if (patch.dockerfilePath !== undefined) next.dockerfilePath = patch.dockerfilePath;
  if (patch.entrypoint !== undefined) next.entrypoint = patch.entrypoint;
  if (patch.cpu !== undefined) next.cpu = clamp(patch.cpu ?? undefined, SANDBOX_SPEC_LIMITS.cpu);
  if (patch.memoryGb !== undefined) next.memoryGb = clamp(patch.memoryGb ?? undefined, SANDBOX_SPEC_LIMITS.memory);
  if (patch.diskGb !== undefined) next.diskGb = clamp(patch.diskGb ?? undefined, SANDBOX_SPEC_LIMITS.disk);
  // Identity changed → snapshot is stale.
  if (
    patch.image !== undefined ||
    patch.dockerfilePath !== undefined ||
    patch.entrypoint !== undefined ||
    patch.cpu !== undefined ||
    patch.memoryGb !== undefined ||
    patch.diskGb !== undefined
  ) {
    next.providerSnapshotName = null;
    next.contentHash = null;
    next.providerState = 'missing';
  }
  validateTemplateMutation({
    image: (next.image as string | null | undefined) ?? row.image ?? undefined,
    dockerfilePath:
      (next.dockerfilePath as string | null | undefined) ?? row.dockerfilePath ?? undefined,
  });
  const [updated] = await db
    .update(sandboxTemplates)
    .set(next)
    .where(eq(sandboxTemplates.templateId, templateId))
    .returning();
  if (updated?.projectId) invalidateTemplateCache(updated.projectId);
  return updated;
}

export async function deleteTemplate(templateId: string): Promise<boolean> {
  const row = await getTemplateById(templateId);
  if (!row) return false;
  if (row.isShared) throw new Error('Shared platform templates cannot be deleted.');
  await db.delete(sandboxTemplates).where(eq(sandboxTemplates.templateId, templateId));
  if (row.projectId) invalidateTemplateCache(row.projectId);
  return true;
}

/**
 * Refresh `provider_state` for a template by asking the provider. Mostly
 * informational; the boot path doesn't trust this column.
 */
export async function refreshTemplateState(
  templateId: string,
): Promise<DbSandboxTemplate | null> {
  const row = await getTemplateById(templateId);
  if (!row || !row.providerSnapshotName) return row;
  const adapter = getSandboxProvider(row.provider);
  const state = await adapter.getSnapshotState(row.providerSnapshotName);
  const [updated] = await db
    .update(sandboxTemplates)
    .set({ providerState: state, updatedAt: new Date() })
    .where(eq(sandboxTemplates.templateId, templateId))
    .returning();
  return updated;
}

/**
 * Resolve a template's snapshot identity: derive the content-addressed
 * snapshot name from (Dockerfile bytes or FROM image, runtime fingerprint,
 * spec). Used by builder.ts to know what to ask the provider for.
 */
export async function computeTemplateIdentity(
  project: GitBackedProject,
  template: ResolvedTemplate,
): Promise<{
  snapshotName: string;
  contentHash: string;
  shortHash: string;
  runtimeFingerprint: string;
  userDockerfile: string;
  /** Commit the Dockerfile was read from; null for default/image templates. */
  builtFromCommit: string | null;
  /**
   * Identity of everything the agent-swap does NOT touch: user image + spec +
   * NON-agent runtime layer (contentHash with the non-agent runtime fingerprint
   * in place of the full one). The builder swaps the agent ONLY when this matches
   * the predecessor's STORED swapKey (→ the agent binary is the sole delta);
   * otherwise it does a full rebuild. Never ships stale opencode/CLI/entrypoint.
   */
  swapKey: string;
}> {
  const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
  const { dockerfile: userDockerfile, commit } = await resolveUserDockerfile(project, template);
  const hashInputs = {
    dockerfile: userDockerfile,
    contextTreeOid: template.isShared ? 'platform-default' : `template:${template.slug}`,
    spec: { cpu: template.cpu, memory: template.memoryGb, disk: template.diskGb },
    containerRuntime: template.containerRuntime,
  };
  const hash = computeSnapshotHash({ ...hashInputs, runtimeFingerprint });
  // swapKey identifies EVERYTHING the agent-swap does NOT touch: the user image,
  // the spec, and the NON-agent runtime layer (opencode/entrypoint/CLI/slack-cli/
  // SDK/manifest-schema/layer+browser versions). It is computed by hashing
  // the same inputs with the non-agent runtime fingerprint in place of the full one.
  // Two identities with the SAME swapKey differ ONLY by the agent binary → the swap
  // is sound. A change to the user image, spec, OR any non-agent runtime artifact
  // moves swapKey → the builder rebuilds instead of swapping (never ships stale).
  const nonAgentRuntimeFingerprint = await currentNonAgentRuntimeFingerprint();
  const swapKey = computeSnapshotHash({ ...hashInputs, runtimeFingerprint: nonAgentRuntimeFingerprint }).shortHash;
  const namePrefix = template.isShared ? 'kortix-default' : 'kortix-tpl';
  return {
    snapshotName: `${namePrefix}-${hash.shortHash}`,
    contentHash: hash.contentHash,
    shortHash: hash.shortHash,
    runtimeFingerprint,
    userDockerfile,
    builtFromCommit: commit,
    swapKey,
  };
}

export async function resolveUserDockerfile(
  project: GitBackedProject,
  template: ResolvedTemplate,
): Promise<{ dockerfile: string; commit: string | null }> {
  if (template.isShared) return { dockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, commit: null };
  if (template.dockerfilePath) {
    const commitSha = await resolveCommitSha(project, project.defaultBranch);
    const bytes = await readRepoFile(project, template.dockerfilePath, commitSha);
    const normalized = normalizeUserDockerfileForSnapshot(bytes);
    if (!normalized.trim()) {
      throw new Error(`Sandbox template "${template.slug}": Dockerfile ${template.dockerfilePath} is empty`);
    }
    return { dockerfile: normalized, commit: commitSha };
  }
  if (template.image) {
    return { dockerfile: `FROM ${template.image}\n`, commit: null };
  }
  throw new Error(`Sandbox template "${template.slug}" has neither image nor dockerfilePath`);
}

/**
 * Persist the build result on the template row. Called by builder.ts after a
 * successful build OR a state observation.
 */
export async function recordTemplateBuilt(
  templateId: string | null,
  args: { snapshotName: string; contentHash: string; builtFromCommit?: string | null; provider?: string; swapKey?: string | null },
): Promise<void> {
  if (!templateId) return;
  // Read the row first so we know which snapshot we're about to repoint AWAY
  // from (the predecessor) and on which provider it lives.
  const prev = await getTemplateById(templateId).catch(() => null);
  await db
    .update(sandboxTemplates)
    .set({
      providerSnapshotName: args.snapshotName,
      contentHash: args.contentHash,
      builtFromCommit: args.builtFromCommit ?? null,
      // swapKey of what we just built — the agent-swap eligibility key (user image
      // + spec + non-agent runtime). Only overwrite when provided so a state-only
      // observation doesn't wipe it. The agent-swap fast path requires this stored.
      ...(args.swapKey !== undefined ? { swapKey: args.swapKey } : {}),
      providerState: 'active',
      // Track WHERE it was built — so the build-state is correct per provider
      // (the trust-the-row fast path checks this) and switching providers
      // rebuilds instead of reusing the other provider's snapshot.
      ...(args.provider ? { provider: args.provider as any } : {}),
      lastBuiltAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(sandboxTemplates.templateId, templateId))
    .catch(() => {});

  // Reap-on-repoint: the row now points at the freshly-built snapshot, so the
  // one it referenced before is superseded. Drop it immediately instead of
  // leaving it to accumulate against the org-wide 100-snapshot quota until the
  // lazy, pressure-gated GC eventually notices.
  const oldName = prev?.providerSnapshotName ?? null;
  if (oldName && oldName !== args.snapshotName) {
    // Off the caller's path: the first session after every deploy lands here
    // (the release gate builds the new image unpublished), and the reap is a
    // provider lookup + delete that session never needed. It is best-effort by
    // construction (reapPredecessorSnapshot catches and logs everything; quota
    // GC collects whatever it leaves), so a session must not wait on it.
    const reap = reapPredecessorSnapshot(
      templateId,
      oldName,
      args.provider ?? prev?.provider ?? 'daytona',
    );
    pendingPredecessorReaps.add(reap);
    void reap.finally(() => pendingPredecessorReaps.delete(reap));
  }
}

// replica-local: only reaps this process started, kept so a test can await
// them. The reaps themselves are best-effort background deletes (quota GC
// collects whatever is left), so nothing needs to survive a restart or be
// visible to another replica.
const pendingPredecessorReaps = new Set<Promise<void>>();

/** Test hook: settle every predecessor reap kicked by recordTemplateBuilt. */
export async function settlePredecessorReapsForTests(): Promise<void> {
  while (pendingPredecessorReaps.size > 0) await Promise.all([...pendingPredecessorReaps]);
}

/**
 * Delete a snapshot a template row just stopped pointing at. Best-effort and
 * heavily guarded: gated by KORTIX_SNAPSHOT_REAP_PREDECESSOR, restricted to our
 * legacy managed namespaces, and skipped if ANY other template row still
 * references the name. Scoped `kpp2-` project images are excluded because this
 * path has no data-plane ownership proof. The ownership-aware per-project
 * reaper handles them; Daytona quota GC is the provider-specific pressure
 * backstop. Never throws — a failed reap falls back to later cleanup.
 */
async function reapPredecessorSnapshot(
  templateId: string,
  snapshotName: string,
  provider: string,
): Promise<void> {
  try {
    if (!config.KORTIX_SNAPSHOT_REAP_PREDECESSOR) return;
    if (!isReapableTemplatePredecessor(snapshotName)) return;
    // Still referenced by a DIFFERENT template row? Leave it shared.
    const stillUsed = await db
      .select({ id: sandboxTemplates.templateId })
      .from(sandboxTemplates)
      .where(
        and(
          eq(sandboxTemplates.providerSnapshotName, snapshotName),
          ne(sandboxTemplates.templateId, templateId),
        ),
      )
      .limit(1);
    if (stillUsed.length > 0) return;
    await getSandboxProvider(provider).deleteSnapshot(snapshotName);
    console.log(`[snapshots] reaped superseded snapshot ${snapshotName} (provider=${provider})`);
  } catch (err) {
    console.warn(
      `[snapshots] reap of superseded snapshot ${snapshotName} failed (left for quota GC):`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function recordTemplateFailed(
  templateId: string | null,
  message: string,
): Promise<void> {
  if (!templateId) return;
  await db
    .update(sandboxTemplates)
    .set({
      providerState: 'error',
      lastError: message.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(sandboxTemplates.templateId, templateId))
    .catch(() => {});
}

// ─── Internals ────────────────────────────────────────────────────────────

function synthesizedDefault(): ResolvedTemplate {
  const tpl = buildDefaultSandboxTemplate();
  return {
    templateId: null,
    projectId: null,
    slug: tpl.slug,
    name: tpl.name ?? 'Default',
    isShared: true,
    source: 'platform',
    provider: 'daytona',
    image: null,
    dockerfilePath: null,
    entrypoint: null,
    cpu: DEFAULT_CPU,
    memoryGb: DEFAULT_MEMORY_GB,
    diskGb: DEFAULT_DISK_GB,
    containerRuntime: false,
    providerState: 'missing',
    providerSnapshotName: null,
    contentHash: null,
    builtFromCommit: null,
    swapKey: null,
  };
}

function rowToResolved(row: DbSandboxTemplate): ResolvedTemplate {
  return {
    templateId: row.templateId,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    isShared: row.isShared,
    source: (row.source as ResolvedTemplate['source']) ?? 'toml',
    provider: row.provider ?? 'daytona',
    image: row.image,
    dockerfilePath: row.dockerfilePath,
    entrypoint: row.entrypoint,
    cpu: row.cpu ?? DEFAULT_CPU,
    memoryGb: row.memoryGb ?? DEFAULT_MEMORY_GB,
    diskGb: row.diskGb ?? DEFAULT_DISK_GB,
    containerRuntime: row.containerRuntime,
    providerState: row.providerState ?? 'missing',
    providerSnapshotName: row.providerSnapshotName,
    contentHash: row.contentHash,
    builtFromCommit: row.builtFromCommit ?? null,
    swapKey: row.swapKey ?? null,
  };
}

/**
 * Upsert `sandbox.templates` entries from the project's kortix.yaml into the DB.
 * Best-effort: a broken manifest never blocks the boot path.
 */
async function syncManifestTemplatesForProject(project: GitBackedProject): Promise<void> {
  try {
    const parsed = await readManifest(project);
    const tomlTemplates = extractSandboxTemplates(parsed?.raw ?? null);
    for (const tpl of tomlTemplates) {
      if (tpl.slug === DEFAULT_SANDBOX_SLUG) continue;
      await db
        .insert(sandboxTemplates)
        .values({
          projectId: project.projectId,
          accountId: null,
          slug: tpl.slug,
          name: tpl.name ?? tpl.slug,
          isShared: false,
          source: 'toml',
          provider: 'daytona',
          image: tpl.image ?? null,
          dockerfilePath: tpl.dockerfile ?? null,
          entrypoint: null,
          cpu: clamp(tpl.spec.cpu, SANDBOX_SPEC_LIMITS.cpu),
          memoryGb: clamp(tpl.spec.memory, SANDBOX_SPEC_LIMITS.memory),
          diskGb: clamp(tpl.spec.disk, SANDBOX_SPEC_LIMITS.disk),
          containerRuntime: tpl.containerRuntime === true,
          providerState: 'missing',
        })
        .onConflictDoUpdate({
          target: [sandboxTemplates.projectId, sandboxTemplates.slug],
          set: {
            name: tpl.name ?? tpl.slug,
            image: tpl.image ?? null,
            dockerfilePath: tpl.dockerfile ?? null,
            cpu: clamp(tpl.spec.cpu, SANDBOX_SPEC_LIMITS.cpu),
            memoryGb: clamp(tpl.spec.memory, SANDBOX_SPEC_LIMITS.memory),
            diskGb: clamp(tpl.spec.disk, SANDBOX_SPEC_LIMITS.disk),
            containerRuntime: tpl.containerRuntime === true,
            updatedAt: new Date(),
          },
        });
    }

    // Persist `sandbox.default` → projects.metadata.default_sandbox_slug, so
    // session boot can cheaply pick the project's default template without a
    // git fetch. Only honor a default that names a template we just synced
    // (else it would point at nothing); clear it otherwise.
    const wantedDefault = extractSandboxDefault(parsed?.raw ?? null);
    const validDefault =
      wantedDefault && tomlTemplates.some((t) => t.slug === wantedDefault) ? wantedDefault : null;
    const [projectRow] = await db
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, project.projectId))
      .limit(1);
    const meta = (projectRow?.metadata ?? {}) as Record<string, unknown>;
    const current = typeof meta.default_sandbox_slug === 'string' ? meta.default_sandbox_slug : null;
    if (current !== validDefault) {
      // FIX-J: SQL-side atomic merge of ONLY `default_sandbox_slug` (set / delete)
      // so this manifest-sync write can't revert a routing pin written between the
      // read above and this write.
      await db
        .update(projects)
        .set({
          metadata: validDefault
            ? metadataMerge({ default_sandbox_slug: validDefault })
            : metadataMerge({}, ['default_sandbox_slug']),
          updatedAt: new Date(),
        })
        .where(eq(projects.projectId, project.projectId));
    }
  } catch (err) {
    console.warn(
      `[templates] manifest sync failed for ${project.projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function clamp(
  value: number | undefined | null,
  bounds: { min: number; max: number },
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < bounds.min) return null;
  if (n > bounds.max) return bounds.max;
  return n;
}

function validateTemplateMutation(args: { image?: unknown; dockerfilePath?: unknown }): void {
  const image = typeof args.image === 'string' && args.image.trim() ? args.image.trim() : null;
  const dockerfilePath =
    typeof args.dockerfilePath === 'string' && args.dockerfilePath.trim()
      ? args.dockerfilePath.trim()
      : null;
  if (image && dockerfilePath) {
    throw new Error('Set exactly one of `image` or `dockerfile_path` (not both).');
  }
}
