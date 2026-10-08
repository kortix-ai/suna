/**
 * Config release builder.
 *
 * A config release is one tree (its file list with blob IDs) plus one compiled
 * governance. The API-built archive of the tree is keyed by the tree ID, so
 * every commit and every variant with identical files shares one archive; a
 * tree over `MAX_CONFIG_ARCHIVE_BYTES` has none, and a v3 box builds it from
 * its checkout or the project snapshot (`snapshot.ts`). The builder reads only
 * the API's bare mirror. It never calls into a sandbox.
 *
 * The git plumbing behind `build` — tree resolution, release-tree composition,
 * archive bytes — lives in `release-tree.ts`; this module owns the release
 * orchestration (caches, governance, the store) and re-exports the plumbing's
 * public names, so every `./builder` import path keeps working.
 */

import { createHash } from 'node:crypto';
import { config } from '../config';
import { refreshMirror, runGitCapture } from '../projects/git/mirror';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from '../projects/lib/compile-agent-config';
import { buildPlatformMetaOpenCodeConfig } from '../projects/lib/platform-meta-agent';
import type { GitBackedProject } from '../projects/git/types';
import { bumpBounded } from '../shared/ttl-memo';
import { configArchiveKey, getConfigArchiveStore, type ConfigArchiveStore } from './store';
import type { ConfigReleaseFile, ConfigReleaseVariant } from './release-tree';
import {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  HEX40,
  isComposedSource,
  listConfigFiles,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  resolveReleaseTreeSource,
} from './release-tree';

export {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  isComposedSource,
  isTreeObject,
  listConfigFiles,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  resolveReleaseTreeSource,
  selectedOpenCodePlugins,
} from './release-tree';
export type { ConfigReleaseVariant } from './release-tree';

/**
 * The descriptor formats. `v2` is what a daemon that sends no `accept` gets:
 * a tree release always carries the API-built archive, so a tree over
 * `MAX_CONFIG_ARCHIVE_BYTES` gets no release at all. `v3` (the daemon sends
 * `{"accept":["config-release-v3"]}`) keeps the release for such a tree:
 * `archive` is null, and the box builds the release from its own `/workspace`
 * checkout or from the project snapshot (`snapshot`). The release ID is the
 * same in both formats for every tree under the cap.
 */
export const CONFIG_RELEASE_FORMAT_V2 = 'config-release-v2';
export const CONFIG_RELEASE_FORMAT_V3 = 'config-release-v3';
export type ConfigReleaseFormat = typeof CONFIG_RELEASE_FORMAT_V2 | typeof CONFIG_RELEASE_FORMAT_V3;

/**
 * Always `follow-base`: a session runs the base branch's CURRENT config
 * release. One member on purpose — there is no per-session config policy, and
 * a session's own edits under `/workspace` reach a box only once they are
 * pushed to the base branch.
 */
type ConfigMode = 'follow-base';

/**
 * The manifest no longer declares the agent this session was created with.
 *
 * Per-SESSION, not per-release: two sessions can share one release ID and only
 * one of them be re-pointed, so this is attached by `toDescriptor` and is
 * deliberately NOT part of `ConfigRelease` (which is cached per project,
 * commit and variant) nor of `release_id`.
 *
 * LANE D / daemon: render `reason` verbatim into the session notice
 * (`config-release/notice.ts`, composed into OpenCode `instructions` at
 * `lifecycle.ts:399-407`). It is written as a finished sentence for the agent
 * and the user; the daemon adds no wording of its own.
 */
export interface ConfigReleaseAgentRepoint {
  /** The agent name `project_sessions.agent_name` held. */
  from: string;
  /** The project's declared default agent, or null when there was none. */
  to: string | null;
  /** True when the release is built for `to`. False ⇒ the session runs no agent. */
  applied: boolean;
  /** One finished sentence, for the session notice, `GET /config`, the web header and the CLI. */
  reason: string;
}

/**
 * The project snapshot boot object of `source_commit` (`git-proxy/project-snapshot*`):
 * the commit's working tree plus a blobless `.git`, as `tar.gz`. A v3 box
 * downloads it with no credential, keeps the files `files` lists, and verifies
 * each against its blob ID. Not cached: the URL expires.
 */
export interface ConfigReleaseSnapshot {
  url: string;
  sha256: string;
  bytes: number;
  entries: number;
  expires_at: string;
}

export interface ConfigReleaseDescriptor {
  format: ConfigReleaseFormat;
  /** `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`, hex. Null when there is no release. */
  release_id: string | null;
  mode: ConfigMode;
  source_commit: string;
  config_dir: string | null;
  config_tree_id: string | null;
  /** The API-built archive. v3: null for a tree over `MAX_CONFIG_ARCHIVE_BYTES`. */
  archive: { url: string; bytes: number } | null;
  files: ConfigReleaseFile[] | null;
  compiled_governance: string | null;
  compiled_governance_etag: string | null;
  /** Why there is no release, or null. */
  reason: string | null;
  /** Set only when the manifest dropped the session's agent. */
  agent_repoint: ConfigReleaseAgentRepoint | null;
  /** v3 only, attached per request by the descriptor route. */
  snapshot?: ConfigReleaseSnapshot | null;
}

/**
 * The session-independent part of a descriptor. Cached per
 * `(project, commit, variant)`, which is why the per-session `agent_repoint`
 * is not part of it.
 */
export type ConfigRelease = Omit<ConfigReleaseDescriptor, 'format' | 'mode' | 'agent_repoint' | 'snapshot'> & {
  /** Why a tree release has no archive (over the cap). A v2 descriptor turns it into "no release". */
  archive_reason?: string;
};

class ConfigReleaseCommitNotFoundError extends Error {
  constructor(readonly commit: string) {
    super(`commit ${commit} is not in the project mirror`);
    this.name = 'ConfigReleaseCommitNotFoundError';
  }
}

/**
 * `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`,
 * hex. Null only when both are null. A session without a config archive (no
 * config dir, or no repository access) still has a release ID when it has
 * governance, so a governance-only change converges.
 */
export function configReleaseId(configTreeId: string | null, compiledGovernanceEtag: string | null): string | null;
export function configReleaseId(configTreeId: string, compiledGovernanceEtag: string | null): string;
export function configReleaseId(configTreeId: string | null, compiledGovernanceEtag: string | null): string | null {
  if (configTreeId === null && compiledGovernanceEtag === null) return null;
  return createHash('sha256')
    .update(`${configTreeId ?? ''}:${compiledGovernanceEtag ?? ''}`)
    .digest('hex');
}

/**
 * The archive's API path. A composed release tree (see `composeReleaseTree`)
 * exists in no mirror, so its path carries the commit it was composed from and
 * the route rebuilds it from there. The daemon accepts a query string.
 */
export function configArchiveRoute(projectId: string, configTreeId: string, composedFrom?: string, variant?: ConfigReleaseVariant): string {
  const path = `/v1/projects/${projectId}/config-archives/${configTreeId}`;
  return composedFrom ? `${path}?commit=${composedFrom}${variant?.startsWith('agent:') ? `&agent=${encodeURIComponent(variant.slice(6))}` : ''}` : path;
}

interface CachedRelease {
  release: ConfigRelease;
  at: number;
}

const MAX_CACHED_RELEASES = 1_000;
const releases = new Map<string, CachedRelease>();
const inflight = new Map<string, Promise<ConfigRelease>>();
/** Archive byte counts per store key. The archive is deterministic per tree ID. */
const archiveBytes = new Map<string, number>();
const MAX_CACHED_ARCHIVE_SIZES = 5_000;

interface BuildConfigReleaseOptions {
  store?: ConfigArchiveStore;
  /** Tests only: skip the in-memory descriptor cache. */
  noCache?: boolean;
  /** Tests only: a smaller archive cap, so the over-limit case needs no 32 MiB fixture. */
  archiveLimit?: number;
}

/**
 * Put the archive into the store, then bound what the project keeps.
 *
 * The store is a cache: a failure is logged and the archive route streams a
 * fresh build instead. Retention rides the publish because that is the only
 * moment a project gains an archive — no cron, no worker, no leader election.
 * A prune failure is never allowed to fail a publish; the next publish retries
 * it.
 */
export async function storeConfigArchive(
  store: ConfigArchiveStore,
  projectId: string,
  key: string,
  archive: Buffer,
  options: { keep?: number } = {},
): Promise<'created' | 'exists' | 'failed'> {
  let outcome: 'created' | 'exists';
  try {
    outcome = await store.putIfAbsent(key, archive);
  } catch (error) {
    console.warn(`[config-releases] store put ${key} failed; the archive route streams from the mirror: ${(error as Error).message}`);
    return 'failed';
  }
  // 0 = the bucket's own lifecycle rule owns retention (AWS: the API task role
  // has s3:PutObject/GetObject/ListBucket and NO s3:DeleteObject by design —
  // infra/terraform/modules/ecs-api). Supabase Storage has no lifecycle engine,
  // so there the API prunes.
  const keep = options.keep ?? config.KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT;
  if (outcome === 'created' && keep > 0) {
    try {
      const deleted = await store.pruneProject(projectId, keep);
      if (deleted.length > 0) {
        console.log(`[config-releases] pruned ${deleted.length} archive(s) of project ${projectId}, keeping ${keep}`);
      }
    } catch (error) {
      console.warn(`[config-releases] prune of project ${projectId} failed: ${(error as Error).message}`);
    }
  }
  return outcome;
}

/** The `none` variant's compiled governance: a valid, empty OpenCode config. */
const EMPTY_GOVERNANCE = '{}';

async function compileGovernance(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
): Promise<string | null> {
  if (variant === 'project') return resolveCompiledAgentConfigForSession(project, commit);
  if (variant === 'none') return EMPTY_GOVERNANCE;
  if (variant === 'meta') return buildPlatformMetaOpenCodeConfig();
  return resolveSelectedAgentConfigForSession(project, variant.slice('agent:'.length), commit);
}

async function build(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  store: ConfigArchiveStore,
  archiveLimit?: number,
): Promise<ConfigRelease> {
  let mirror = await refreshMirror(project);
  // A commit the warm mirror has not fetched yet: fetch once, then give up.
  if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
    mirror = await refreshMirror(project, true);
    if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
      throw new ConfigReleaseCommitNotFoundError(commit);
    }
  }
  const base: ConfigRelease = {
    release_id: null,
    source_commit: commit,
    config_dir: null,
    config_tree_id: null,
    archive: null,
    files: null,
    compiled_governance: null,
    compiled_governance_etag: null,
    reason: null,
  };

  // Governance first: a selected-agent compile failure means no release. The
  // session keeps its running config rather than run without its agent.
  let governance: string | null;
  try {
    governance = await compileGovernance(project, commit, variant);
  } catch (error) {
    return { ...base, reason: `${COMPILED_GOVERNANCE_FAILED}: ${(error as Error).message}` };
  }
  const etag = agentConfigEtag(governance);
  const withGovernance: ConfigRelease = {
    ...base,
    compiled_governance: governance,
    compiled_governance_etag: etag,
  };

  // The meta coordinator gets a governance-only release: its box holds no
  // project checkout.
  const governanceOnly = configReleaseId(null, etag);
  if (variant === 'meta') return { ...withGovernance, release_id: governanceOnly };
  let resolved: Awaited<ReturnType<typeof resolveReleaseTreeSource>>;
  try {
    resolved = await resolveReleaseTreeSource(mirror, project, commit, variant);
  } catch (error) {
    return { ...withGovernance, reason: (error as Error).message };
  }
  if (!('source' in resolved)) {
    return { ...withGovernance, release_id: governanceOnly, config_dir: resolved.configDir, reason: resolved.reason };
  }
  const { source } = resolved;
  const configDir = source.configDir;
  const composed = isComposedSource(source);

  let treeId = source.rootTree;
  let files: ConfigReleaseFile[] | null = null;
  let freshArchive: Buffer | null = null;
  try {
    if (composed) {
      // The tree is only known once composed; the archive builds in the same
      // scratch repository, on an archive-size cache miss only.
      const read = await readComposedRelease(mirror, source, {
        limit: archiveLimit,
        archive: (composedTreeId) => !archiveBytes.has(configArchiveKey(project.projectId, composedTreeId)),
      });
      treeId = read.treeId;
      files = read.files;
      freshArchive = read.archive;
    } else if (!archiveBytes.has(configArchiveKey(project.projectId, treeId))) {
      freshArchive = await buildConfigArchive(mirror, treeId, archiveLimit);
    }
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) {
      // The release exists; only the API-built archive does not. A v3 box
      // builds it from its checkout or the project snapshot. The answer is a
      // fact of the commit, so it is cached like any release: each miss tars
      // and gzips the whole tree again (~1.5 s for 36 MB).
      const read = composed ? await readComposedRelease(mirror, source, { archive: false }) : null;
      treeId = read?.treeId ?? treeId;
      return {
        ...withGovernance,
        release_id: configReleaseId(treeId, etag),
        config_dir: configDir,
        config_tree_id: treeId,
        files: read?.files ?? (await listConfigFiles(mirror, treeId)),
        archive_reason:
          `the repository at ${commit.slice(0, 12)} exceeds the ${archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES}-byte config archive limit. ` +
          'Move large static files out of Git into object storage (S3, R2, GCS), or mark paths no agent reads ' +
          '`export-ignore` in .gitattributes. `kortix validate` lists the largest files.',
      };
    }
    throw error;
  }
  const located: ConfigRelease = { ...withGovernance, config_dir: configDir, config_tree_id: treeId };

  const key = configArchiveKey(project.projectId, treeId);
  if (freshArchive) {
    await storeConfigArchive(store, project.projectId, key, freshArchive);
    bumpBounded(archiveBytes, key, freshArchive.length, MAX_CACHED_ARCHIVE_SIZES);
  }
  const bytes = archiveBytes.get(key)!;

  return {
    ...located,
    release_id: configReleaseId(treeId, etag),
    archive: { url: configArchiveRoute(project.projectId, treeId, composed ? commit : undefined, variant), bytes },
    files: files ?? (await listConfigFiles(mirror, treeId)),
  };
}

/**
 * Build (or read from the in-memory cache) the release for one commit and one
 * variant. `commit` must be a full commit SHA the mirror already holds. The
 * caller resolves the base tip after `invalidateProjectMirror`.
 */
export async function buildConfigRelease(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  options: BuildConfigReleaseOptions = {},
): Promise<ConfigRelease> {
  if (!HEX40.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const store = options.store ?? getConfigArchiveStore();
  if (options.noCache) return build(project, commit, variant, store, options.archiveLimit);

  const cacheKey = `${project.projectId}\0${commit}\0${variant}`;
  const cached = releases.get(cacheKey);
  if (cached) return cached.release;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const next = build(project, commit, variant, store, options.archiveLimit)
    .then((release) => {
      // A release with a reason can be transient (a compile read that failed).
      // Only complete releases are cached; an over-limit tree is one.
      if (release.release_id) {
        bumpBounded(releases, cacheKey, { release, at: Date.now() }, MAX_CACHED_RELEASES);
      }
      return release;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, next);
  return next;
}

const REPOSITORY_ACCESS_WITHHELD = 'repository access withheld';
const COMPILED_GOVERNANCE_FAILED = 'compiled governance failed';

/**
 * The wire descriptor for a release. The mode is always `follow-base`.
 *
 * A session without repository access never receives an archive: it gets no
 * repository URL and no clone (`allowsFullRepository`), and the archive would
 * disclose files that mode withholds. It keeps the compiled governance, and
 * its release ID covers the governance alone so a governance change still
 * converges.
 *
 * A v2 descriptor of a tree over the archive cap is "no release" with the
 * reason: a v2 daemon reads `archive: null` as governance only and would run
 * the image default as if it were the release.
 */
export function toDescriptor(
  release: ConfigRelease,
  options: {
    repositoryAccess: boolean;
    agentRepoint?: ConfigReleaseAgentRepoint | null;
    format?: ConfigReleaseFormat;
  } = {
    repositoryAccess: true,
  },
): ConfigReleaseDescriptor {
  const mode: ConfigMode = 'follow-base';
  const format = options.format ?? CONFIG_RELEASE_FORMAT_V3;
  const agent_repoint = options.agentRepoint ?? null;
  const { archive_reason, ...wire } = release;
  if (!options.repositoryAccess) {
    return {
      ...wire,
      format,
      mode,
      agent_repoint,
      // Governance-only release ID: a governance change still converges.
      release_id: configReleaseId(null, release.compiled_governance_etag),
      config_dir: null,
      config_tree_id: null,
      archive: null,
      files: null,
      // A governance failure is the more useful reason: it names why the
      // session gets nothing at all.
      reason: release.reason?.startsWith(COMPILED_GOVERNANCE_FAILED) ? release.reason : REPOSITORY_ACCESS_WITHHELD,
    };
  }
  if (archive_reason && format === CONFIG_RELEASE_FORMAT_V2) {
    return { ...wire, format, mode, agent_repoint, release_id: null, files: null, reason: archive_reason };
  }
  return { ...wire, format, mode, agent_repoint };
}

export function __clearConfigReleaseCachesForTests(): void {
  releases.clear();
  inflight.clear();
  archiveBytes.clear();
}
