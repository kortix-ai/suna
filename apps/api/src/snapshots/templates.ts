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

import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { sandboxTemplates, projects } from '@kortix/db';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '@kortix/shared';
type DbSandboxTemplate = typeof sandboxTemplates.$inferSelect;
import { db } from '../shared/db';
import { readManifest } from '../projects/triggers';
import { resolveCommitSha, readRepoFile, type GitBackedProject } from '../projects/git';
import { SANDBOX_VERSION, config } from '../config';
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENT_SRC_DIR = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
const AGENT_PKG_JSON = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/package.json');
const ENTRYPOINT_PATH = process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const SLACK_CLI_SRC_PATH = process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/slack-cli');
const EXECUTOR_SDK_SRC_PATH = process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH
  || resolve(REPO_ROOT, 'packages/executor-sdk');
// Source of the `kortix` CLI binary baked into every sandbox. We fingerprint
// the SOURCE (not the compiled binary, which `bun build --compile` produces
// non-deterministically) so a CLI code change rebuilds snapshots while a
// rebuild of the identical source does not.
//
// Scope: only the files whose change can alter what the CLI does INSIDE a
// sandbox. The single compiled `kortix` binary bakes ALL of apps/cli/src, but a
// session only ever invokes `kortix executor` / `kortix executor mcp` — the rest
// (`ship`, `cr`, `tunnel`, `self-host`, `accounts`, the whole `init`/scaffold
// surface, …) is developer-facing and runs on a laptop, never in the sandbox.
// Hashing the WHOLE tree meant every dev-only CLI edit re-minted every project's
// runtime identity AND moved the non-agent `swapKey`, which DISABLES the cheap
// agent-swap fast path and forces a full O(all-projects) rebuild (measured: ~4 of
// 11 forced mass-rebuilds over 2 weeks were pure dev-CLI churn). So we hash the
// in-sandbox executor import-closure instead of `apps/cli/src` wholesale.
//
// This closure is asserted complete by snapshots/__tests__/cli-executor-closure
// .test.ts, which re-derives it from the `kortix executor` entrypoints and fails
// if a new import escapes the hashed set — so scoping can never silently ship a
// stale in-sandbox executor. packages/starter (scaffolding) and packages/
// manifest-schema (only reached by laptop-side `ship`/`validate`) are likewise
// never in the sandbox and are deliberately not fingerprinted.
const CLI_SRC_DIR = resolve(REPO_ROOT, 'apps/cli/src');
// The in-sandbox `kortix executor` closure (see comment above). Relative to
// CLI_SRC_DIR; the guard test keeps this in sync with the real import graph.
const CLI_EXECUTOR_CLOSURE = [
  'executor',
  'commands/executor.ts',
  'api/auth.ts',
  'api/client.ts',
  'api/config.ts',
  'api/sandbox-env.ts',
  'project-link.ts',
] as const;
const CLI_PKG_JSON = resolve(REPO_ROOT, 'apps/cli/package.json');
const FINGERPRINT_EXCLUDES = ['node_modules', '.bin', 'dist', '.turbo', '.cache'] as const;

// Bump when the rendered Kortix Dockerfile layer changes (the Dockerfile text
// itself is not hashed into the snapshot fingerprint, so a layer change needs a
// manual version bump to invalidate cached images). v2: bake OpenCode config
// deps into /opt/kortix/opencode-config-deps for offline boot-time install.
// v10: warm a real opencode project instance at build time (instance-warm) so the
// one-time first-instance plugin/model/ripgrep cost is cached into the image
// instead of paid on the session hot path (6–60s → ~2–4s cold start).
// v11: bake a real Chromium (Playwright, cross-arch) for agent-browser so the
// browser-automation skill works out of the box with no runtime download.
// v12: bake the full LLM model catalog (/opt/kortix/llm-catalog.json) so the
// no-restart warm seed serves the full picker without a PARK-time fetch.
// v14: bake the COMPLETE config-dir deps (incl. @opencode-ai/plugin + its effect/
// zod/sdk tree + overrides) instead of a partial hardcoded list.
// v15: pin the baked @opencode-ai/plugin to the OPENCODE BINARY version (opencode
// loads the plugin SDK matching its own binary and re-fetches it over the network
// if the baked tree carries a different version — the stale starter pin left every
// boot re-installing it, the ~5–8s opencode-session-created gap).
// v16: ship the `meet` channel CLI + the kortix-meet skill.
// v17: `meet chat` (bot talks back in-call) + live-relay skill section.
// v18: `meet speak` (TTS voice in-call) + voice-reply skill section.
// v19: natural-conversation relay (debounce + acknowledgement + follow-up) skill notes.
// v20: multi-platform rebrand (Meet/Zoom/Teams) + dedicated speaking skill section.
// v21: configurable bot name (project setting) + wake word = bot's first name (skill).
// v22: spoken turns MUST reply by voice (skill) — no chat fallback for speech.
// v23: auto-recap on meeting end (bot.done webhook -> session produces notes).
// v24: hard-fail the bake if the baked opencode-config-deps tree (or the
// starter tool files against it) can't actually be bundled by Bun — a
// bundle-breaking axios override once shipped silently baked into every
// sandbox image (bun install succeeded; the runtime bundle did not).
const RUNTIME_LAYER_VERSION = 'baked-config-deps-binplugin-v24';
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
export async function resolveDefaultTemplate(): Promise<ResolvedTemplate> {
  const [shared] = await db
    .select()
    .from(sandboxTemplates)
    .where(and(eq(sandboxTemplates.slug, DEFAULT_SANDBOX_SLUG), eq(sandboxTemplates.isShared, true)))
    .limit(1);
  return shared ? rowToResolved(shared) : synthesizedDefault();
}

/**
 * Fetch a single template row by (project, slug) — DB-only, no synthesis.
 * Used by CRUD operations that must operate on a concrete row.
 */
export async function getTemplateRow(
  projectId: string | null,
  slug: string,
): Promise<DbSandboxTemplate | null> {
  const conds = [eq(sandboxTemplates.slug, slug)];
  if (projectId === null) conds.push(isNull(sandboxTemplates.projectId));
  else conds.push(eq(sandboxTemplates.projectId, projectId));
  const [row] = await db
    .select()
    .from(sandboxTemplates)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
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
      provider: 'managed',
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
  };
  const hash = computeSnapshotHash({ ...hashInputs, runtimeFingerprint });
  // swapKey identifies EVERYTHING the agent-swap does NOT touch: the user image,
  // the spec, and the NON-agent runtime layer (opencode/entrypoint/CLI/slack-cli/
  // executor-sdk/manifest-schema/layer+browser versions). It is computed by hashing
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
    await reapPredecessorSnapshot(templateId, oldName, args.provider ?? prev?.provider ?? 'managed');
  }
}

/** Managed snapshot namespaces we own and may reap. Anything else (Daytona's
 *  own base/sample images, etc.) is left strictly alone. */
const REAPABLE_SNAPSHOT_PREFIXES = ['kortix-default-', 'kortix-tpl-', 'kortix-wproj-', 'kortix-ppwarm-'];

/**
 * Delete a snapshot a template row just stopped pointing at. Best-effort and
 * heavily guarded: gated by KORTIX_SNAPSHOT_REAP_PREDECESSOR, restricted to our
 * managed namespaces, and skipped if ANY other template row still references the
 * name (snapshots are content-addressed, so two projects with byte-identical
 * inputs share one image). Never throws — a failed reap just falls back to the
 * quota GC, and a cross-env row that still pointed at this (identical) name
 * self-heals via the boot-time rebuild-and-retry path.
 */
async function reapPredecessorSnapshot(
  templateId: string,
  snapshotName: string,
  provider: string,
): Promise<void> {
  try {
    if (!config.KORTIX_SNAPSHOT_REAP_PREDECESSOR) return;
    if (!REAPABLE_SNAPSHOT_PREFIXES.some((p) => snapshotName.startsWith(p))) return;
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
    provider: 'managed',
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
    provider: row.provider ?? 'managed',
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
    swapKey: row.swapKey ?? null,
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
          provider: 'managed',
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

// The runtime layer bakes source artifacts into every template's rootfs. Exactly
// TWO are the kortix-agent binary; the rest (entrypoint, in-sandbox CLI surface,
// slack-cli, executor-sdk) are the non-agent runtime. The agent-swap fast path
// replaces ONLY the agent, so the builder must prove the NON-agent runtime is
// byte-identical before swapping — hence the split into two artifact sets.
const AGENT_RUNTIME_ARTIFACTS = [
  { label: 'kortix-agent-src', path: AGENT_SRC_DIR, excludeNames: FINGERPRINT_EXCLUDES },
  { label: 'kortix-agent-pkg', path: AGENT_PKG_JSON },
];
const NON_AGENT_RUNTIME_ARTIFACTS = [
  { label: 'kortix-entrypoint', path: ENTRYPOINT_PATH },
  { label: 'kortix-slack-cli', path: SLACK_CLI_SRC_PATH, excludeNames: FINGERPRINT_EXCLUDES },
  { label: 'kortix-executor-sdk', path: EXECUTOR_SDK_SRC_PATH, excludeNames: FINGERPRINT_EXCLUDES },
  // Only the in-sandbox `kortix executor` closure (NOT the whole apps/cli/src) —
  // see CLI_EXECUTOR_CLOSURE. Labels carry the relative path so two files can't
  // collide, and the set is sorted by label in buildRuntimeArtifactFingerprint.
  ...CLI_EXECUTOR_CLOSURE.map((rel) => ({
    label: `kortix-cli-${rel}`,
    path: join(CLI_SRC_DIR, rel),
    excludeNames: FINGERPRINT_EXCLUDES,
  })),
  { label: 'kortix-cli-pkg', path: CLI_PKG_JSON },
];
// Both version strings fold in the layer/opencode/browser/sandbox constants — all
// NON-agent inputs (bumped when the layer/opencode/browser change, not the agent
// binary), so they belong in BOTH fingerprints. The per-process cache re-walks the
// actual files on every fresh deploy, so an agent-src change between deploys moves
// the full fingerprint (drift) while leaving the non-agent fingerprint unchanged.
const runtimeVersionKey = () => `${SANDBOX_VERSION}:${RUNTIME_LAYER_VERSION}:${OPENCODE_VERSION}:${AGENT_BROWSER_VERSION}`;
const sandboxVersionStr = () => `${SANDBOX_VERSION}:layer:${RUNTIME_LAYER_VERSION}:ab:${AGENT_BROWSER_VERSION}`;

let runtimeFingerprintCache: { key: string; value: string } | null = null;
let runtimeFingerprintInflight: Promise<string> | null = null;
let nonAgentFingerprintCache: { key: string; value: string } | null = null;
let nonAgentFingerprintInflight: Promise<string> | null = null;

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
 *
 * Exported for the warm-snapshot baker (snapshots/warm-bake.ts), which derives
 * the warm-base name from this fingerprint so a new release (SANDBOX_VERSION
 * bump / runtime source change) automatically gets a fresh warm base.
 */
export async function currentRuntimeArtifactFingerprint(): Promise<string> {
  const key = runtimeVersionKey();
  if (runtimeFingerprintCache?.key === key) return runtimeFingerprintCache.value;
  if (runtimeFingerprintInflight) return runtimeFingerprintInflight;

  runtimeFingerprintInflight = buildRuntimeArtifactFingerprint({
    sandboxVersion: sandboxVersionStr(),
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [...AGENT_RUNTIME_ARTIFACTS, ...NON_AGENT_RUNTIME_ARTIFACTS],
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

/**
 * Fingerprint of the runtime layer EXCLUDING the kortix-agent binary. Changes iff
 * a NON-agent runtime input moved — opencode/entrypoint/CLI/slack-cli/executor-sdk/
 * manifest-schema source, or the layer/browser/sandbox version constants. The
 * agent-swap fast path is sound ONLY when this is byte-identical between the
 * predecessor and the new identity (i.e. the agent binary is the SOLE runtime
 * delta). Folded into the template's swapKey so the builder can compare against the
 * predecessor's stored value — see maybeSwapAgent in builder.ts.
 */
export async function currentNonAgentRuntimeFingerprint(): Promise<string> {
  const key = runtimeVersionKey();
  if (nonAgentFingerprintCache?.key === key) return nonAgentFingerprintCache.value;
  if (nonAgentFingerprintInflight) return nonAgentFingerprintInflight;

  nonAgentFingerprintInflight = buildRuntimeArtifactFingerprint({
    sandboxVersion: sandboxVersionStr(),
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [...NON_AGENT_RUNTIME_ARTIFACTS],
  })
    .then((value) => {
      nonAgentFingerprintCache = { key, value };
      nonAgentFingerprintInflight = null;
      return value;
    })
    .catch((err) => {
      nonAgentFingerprintInflight = null;
      throw err;
    });
  return nonAgentFingerprintInflight;
}
