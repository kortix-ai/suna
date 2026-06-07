/**
 * Sandbox template service.
 *
 * The durable identity for "what kind of sandbox a session can boot from."
 * Templates live in `kortix.sandbox_templates`. The platform default is a
 * shared row (project_id NULL, is_shared=true) that any project can boot
 * from. Custom templates can be defined either in `kortix.toml` (synced to
 * the DB on first read for a project) or directly via the UI/CRUD API.
 *
 * Provider-agnostic: each template carries a `provider` column; the matching
 * adapter (currently just Daytona) is resolved via `getSandboxProvider`.
 */

import { and, eq, or } from 'drizzle-orm';
import { sandboxTemplates, projects } from '@kortix/db';
type DbSandboxTemplate = typeof sandboxTemplates.$inferSelect;
import { db } from '../shared/db';
import { readManifest } from '../projects/triggers';
import { resolveCommitSha, readRepoFile, type GitBackedProject } from '../projects/git';
import { SANDBOX_VERSION } from '../config';
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
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';
import { getSandboxProvider, type SandboxProviderAdapter } from './providers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENT_SRC_DIR = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
const AGENT_PKG_JSON = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/package.json');
const ENTRYPOINT_PATH = process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const AGENT_CLI_SRC_PATH = process.env.KORTIX_SNAPSHOT_AGENT_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/agent-cli');
const EXECUTOR_SDK_SRC_PATH = process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH
  || resolve(REPO_ROOT, 'packages/executor-sdk');
// Source of the `kortix` CLI binary baked into every sandbox. We fingerprint
// the SOURCE (not the compiled binary, which `bun build --compile` produces
// non-deterministically) so a CLI code change rebuilds snapshots while a
// rebuild of the identical source does not. packages/starter is deliberately
// excluded: it only feeds `kortix init` scaffolding, which is never run inside
// a sandbox, so its churn shouldn't invalidate every project's image.
const CLI_SRC_DIR = resolve(REPO_ROOT, 'apps/cli/src');
const CLI_PKG_JSON = resolve(REPO_ROOT, 'apps/cli/package.json');
const MANIFEST_SCHEMA_SRC_DIR = resolve(REPO_ROOT, 'packages/manifest-schema/src');
const FINGERPRINT_EXCLUDES = ['node_modules', '.bin', 'dist', '.turbo', '.cache'] as const;

const OPENCODE_VERSION = '1.15.10';
const AGENT_BROWSER_VERSION = '0.27.0';
// Bump when the rendered Kortix Dockerfile layer changes (the Dockerfile text
// itself is not hashed into the snapshot fingerprint, so a layer change needs a
// manual version bump to invalidate cached images). v2: bake OpenCode config
// deps into /opt/kortix/opencode-config-deps for offline boot-time install.
const RUNTIME_LAYER_VERSION = 'baked-oc-migration-v9-noka-ab';
const DEFAULT_CPU = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2);
const DEFAULT_MEMORY_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 4);
const DEFAULT_DISK_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_DISK_GB', 20);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

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
  /** Live provider state — refreshed by the caller on demand. */
  providerState: string;
  providerSnapshotName: string | null;
  contentHash: string | null;
  /** Git commit the last successful build read the Dockerfile from. */
  builtFromCommit: string | null;
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
const tomlSyncCache = new Map<string, number>();

/**
 * Per-project cache of the resolved template list. Burst session-boot scenarios
 * (e.g. dashboard opening N sessions back-to-back) hit the templates table
 * with the same query each time; even at ~5-15ms per round-trip, caching
 * for a few seconds shaves time off the hot path without risking staleness
 * (templates only change via CRUD which already invalidates).
 */
const TEMPLATE_LIST_TTL_MS = 5_000;
const templateListCache = new Map<string, { at: number; value: ResolvedTemplate[] }>();

/** Invalidate the in-memory template list cache for a project. Called from
 *  the CRUD endpoints after a create / update / delete. */
function invalidateTemplateCache(projectId: string): void {
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
    await syncTomlTemplatesForProject(project);
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

/** Resolve a slug → ResolvedTemplate. Throws if slug missing. */
export async function resolveTemplateBySlug(
  project: GitBackedProject,
  slug: string | undefined,
): Promise<ResolvedTemplate> {
  const target = (slug ?? '').trim() || DEFAULT_SANDBOX_SLUG;

  // Fast path for the platform default — the overwhelming majority of boots.
  // The default template's identity is a constant (PLATFORM_DEFAULT_USER_DOCKERFILE),
  // so it does NOT depend on the project's kortix.toml. `listTemplatesForProject`
  // would run `syncTomlTemplatesForProject` → `readManifest` → a host-side git
  // fetch of the repo (15-30s cold) on every boot once the 60s TTL lapses — and
  // boots are minutes apart, so it lapses every time. Slug "default" is reserved
  // (the TOML sync skips it and the manifest schema forbids it), so a project can
  // never shadow it: the shared row is always the answer. Resolve it from the DB
  // directly and skip the git fetch entirely.
  if (target === DEFAULT_SANDBOX_SLUG) {
    return resolveDefaultTemplate();
  }

  const items = await listTemplatesForProject(project);
  const match = items.find((t) => t.slug === target);
  if (match) return match;
  throw new Error(`No sandbox template with slug "${target}" in this project.`);
}

/**
 * Resolve the platform-shared default template — project-independent. The
 * default's identity is a constant (PLATFORM_DEFAULT_USER_DOCKERFILE), so it
 * needs no project, no manifest, and no git fetch. Used by the session-boot
 * fast path and the startup pre-build that mints the global default image.
 */
async function resolveDefaultTemplate(): Promise<ResolvedTemplate> {
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

/** Patch a template by id. */
export async function updateTemplate(
  templateId: string,
  patch: UpdateTemplateInput,
): Promise<DbSandboxTemplate | null> {
  const row = await getTemplateById(templateId);
  if (!row) return null;
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
}> {
  const runtimeFingerprint = await currentRuntimeArtifactFingerprint();
  const { dockerfile: userDockerfile, commit } = await resolveUserDockerfile(project, template);
  const hash = computeSnapshotHash({
    dockerfile: userDockerfile,
    contextTreeOid: template.isShared ? 'platform-default' : `template:${template.slug}`,
    spec: { cpu: template.cpu, memory: template.memoryGb, disk: template.diskGb },
    runtimeFingerprint,
  });
  const namePrefix = template.isShared ? 'kortix-default' : 'kortix-tpl';
  return {
    snapshotName: `${namePrefix}-${hash.shortHash}`,
    contentHash: hash.contentHash,
    shortHash: hash.shortHash,
    runtimeFingerprint,
    userDockerfile,
    builtFromCommit: commit,
  };
}

async function resolveUserDockerfile(
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
  args: { snapshotName: string; contentHash: string; builtFromCommit?: string | null; provider?: string },
): Promise<void> {
  if (!templateId) return;
  await db
    .update(sandboxTemplates)
    .set({
      providerSnapshotName: args.snapshotName,
      contentHash: args.contentHash,
      builtFromCommit: args.builtFromCommit ?? null,
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
    providerState: 'missing',
    providerSnapshotName: null,
    contentHash: null,
    builtFromCommit: null,
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
    providerState: row.providerState ?? 'missing',
    providerSnapshotName: row.providerSnapshotName,
    contentHash: row.contentHash,
    builtFromCommit: row.builtFromCommit ?? null,
  };
}

/**
 * Upsert `[[sandbox.templates]]` entries from the project's kortix.toml into the DB.
 * Best-effort: a broken manifest never blocks the boot path.
 */
async function syncTomlTemplatesForProject(project: GitBackedProject): Promise<void> {
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
            updatedAt: new Date(),
          },
        });
    }

    // Persist `[sandbox] default` → projects.metadata.default_sandbox_slug, so
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
      const nextMeta = { ...meta };
      if (validDefault) nextMeta.default_sandbox_slug = validDefault;
      else delete nextMeta.default_sandbox_slug;
      await db
        .update(projects)
        .set({ metadata: nextMeta, updatedAt: new Date() })
        .where(eq(projects.projectId, project.projectId));
    }
  } catch (err) {
    console.warn(
      `[templates] TOML sync failed for ${project.projectId}:`,
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

let runtimeFingerprintCache: { key: string; value: string } | null = null;
let runtimeFingerprintInflight: Promise<string> | null = null;

/**
 * Cache the runtime artifact fingerprint by the pinned version constants only,
 * NOT by the source dir mtime. Mtime-keyed caching used to invalidate on every
 * file save in `apps/kortix-sandbox-agent-server/src` (and every git checkout),
 * forcing a ~30 MB tree walk on the session-boot hot path. The version
 * constants are bumped explicitly when the runtime layer actually changes —
 * that's the right invalidation trigger.
 *
 * Concurrent first-callers share the same in-flight promise so a session-boot
 * burst doesn't spawn N parallel tree walks.
 */
async function currentRuntimeArtifactFingerprint(): Promise<string> {
  const key = `${SANDBOX_VERSION}:${RUNTIME_LAYER_VERSION}:${OPENCODE_VERSION}:${AGENT_BROWSER_VERSION}`;
  if (runtimeFingerprintCache?.key === key) return runtimeFingerprintCache.value;
  if (runtimeFingerprintInflight) return runtimeFingerprintInflight;

  runtimeFingerprintInflight = buildRuntimeArtifactFingerprint({
    sandboxVersion: `${SANDBOX_VERSION}:layer:${RUNTIME_LAYER_VERSION}:ab:${AGENT_BROWSER_VERSION}`,
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [
      { label: 'kortix-agent-src', path: AGENT_SRC_DIR, excludeNames: FINGERPRINT_EXCLUDES },
      { label: 'kortix-agent-pkg', path: AGENT_PKG_JSON },
      { label: 'kortix-entrypoint', path: ENTRYPOINT_PATH },
      { label: 'kortix-agent-cli', path: AGENT_CLI_SRC_PATH, excludeNames: FINGERPRINT_EXCLUDES },
      { label: 'kortix-executor-sdk', path: EXECUTOR_SDK_SRC_PATH, excludeNames: FINGERPRINT_EXCLUDES },
      { label: 'kortix-cli-src', path: CLI_SRC_DIR, excludeNames: FINGERPRINT_EXCLUDES },
      { label: 'kortix-cli-pkg', path: CLI_PKG_JSON },
      { label: 'kortix-manifest-schema-src', path: MANIFEST_SCHEMA_SRC_DIR, excludeNames: FINGERPRINT_EXCLUDES },
    ],
  })
    .then((value) => {
      runtimeFingerprintCache = { key, value };
      runtimeFingerprintInflight = null;
      return value;
    })
    .catch((err) => {
      runtimeFingerprintInflight = null;
      throw err;
    });
  return runtimeFingerprintInflight;
}
