import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json } from '../../openapi';
import { config } from '../../config';
import { logger } from '../../lib/logger';

/**
 * Sandbox version and changelog endpoints.
 *
 * Sources of truth:
 * - Running version: the configured SANDBOX_VERSION image tag, or none when
 *   sandboxes use per-project snapshots with no platform-wide image.
 * - Stable releases: GitHub Releases API.
 * - Dev builds: Docker Hub tags for kortix/kortix-sandbox.
 */

const GITHUB_REPO = 'kortix-ai/suna';
const GITHUB_API_BASE = 'https://api.github.com';
const DOCKERHUB_REPO = 'kortix/kortix-sandbox';
const DOCKERHUB_TAGS_URL = `https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/tags`;
// GitHub allows 60 unauthenticated requests per hour per egress IP, shared by
// every API task. One read per 10 minutes per task stays far below that.
const FEED_TTL_MS = 10 * 60 * 1000;
const FEED_RETRY_MS = 60 * 1000;

type VersionChannel = 'stable' | 'dev';

interface VersionEntry {
  version: string;
  channel: VersionChannel;
  date: string;
  title: string;
  body?: string;
  sha?: string;
  current: boolean;
}

interface LatestVersionResult {
  version: string;
  channel: VersionChannel;
  date?: string;
  title?: string;
  sha?: string;
}

interface DockerHubTag {
  name: string;
  last_updated: string;
}

interface GHRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

function getRunningVersion(): string {
  return config.SANDBOX_VERSION_OVERRIDE || 'none';
}

function getRunningChannel(): VersionChannel | 'none' {
  const version = getRunningVersion();
  return version === 'none' ? 'none' : detectVersionChannel(version);
}

function githubRequest(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${GITHUB_API_BASE}${path}`, { headers, signal: AbortSignal.timeout(8_000) });
}

async function githubFetch<T>(path: string): Promise<T> {
  let res = await githubRequest(path, config.GITHUB_TOKEN);
  // The repo is public. A token GitHub rejects (expired, revoked, or a
  // fine-grained token the kortix-ai org forbids, KRTX-3152) reads anonymously.
  if (config.GITHUB_TOKEN && (res.status === 401 || res.status === 403)) {
    logger.warn(`[version] GitHub rejected GITHUB_TOKEN (${res.status}); reading ${path} anonymously`);
    res = await githubRequest(path);
  }
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * One upstream read per FEED_TTL_MS, shared by every endpoint and request. A
 * failed read keeps the last good copy and waits FEED_RETRY_MS before the next
 * attempt, so callers never turn a GitHub outage into a request per poll.
 */
function cachedFeed<T>(name: string, load: () => Promise<T[]>): () => Promise<T[]> {
  let data: T[] = [];
  let nextReadAt = 0;
  let inflight: Promise<T[]> | null = null;
  return () => {
    if (Date.now() < nextReadAt) return Promise.resolve(data);
    inflight ??= load()
      .then(
        (fresh) => {
          data = fresh;
          nextReadAt = Date.now() + FEED_TTL_MS;
        },
        (err) => {
          logger.warn(`[version] Failed to fetch ${name}:`, { error: err instanceof Error ? err.message : String(err) });
          nextReadAt = Date.now() + FEED_RETRY_MS;
        },
      )
      .then(() => {
        inflight = null;
        return data;
      });
    return inflight;
  };
}

/** Non-draft GitHub releases, newest first. Prereleases are included. */
const githubReleases = cachedFeed('GitHub releases', async () => {
  const releases = await githubFetch<GHRelease[]>(`/repos/${GITHUB_REPO}/releases?per_page=20`);
  return releases.filter((release) => !release.draft);
});

const dockerHubDevTags = cachedFeed('Docker Hub dev tags', async () => {
  const res = await fetch(`${DOCKERHUB_TAGS_URL}/?page_size=100&ordering=last_updated`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
  const data = await res.json() as { results: DockerHubTag[] };
  return (data.results || []).filter((tag) => {
    if (!tag.name.startsWith('dev-')) return false;
    if (tag.name === 'dev-latest') return false;
    if (tag.name.endsWith('-amd64') || tag.name.endsWith('-arm64')) return false;
    return true;
  });
});

async function getLatestStable(): Promise<LatestVersionResult> {
  const release = (await githubReleases()).find((candidate) => !candidate.prerelease);
  if (!release) return { version: 'unknown', channel: 'stable', title: 'No stable release available' };
  const version = release.tag_name.replace(/^v/, '');
  return {
    version,
    channel: 'stable',
    date: release.published_at?.split('T')[0],
    title: release.name || `v${version}`,
  };
}

async function getLatestDev(): Promise<LatestVersionResult> {
  const [tag] = await dockerHubDevTags();
  if (tag) {
    const sha8 = tag.name.replace('dev-', '');
    return {
      version: tag.name,
      channel: 'dev',
      date: tag.last_updated?.split('T')[0],
      title: `Dev build ${sha8}`,
      sha: sha8,
    };
  }

  const running = getRunningVersion();
  return {
    version: running.startsWith('dev-') ? running : 'dev-unknown',
    channel: 'dev',
    title: 'No dev build available',
  };
}

function releaseMetadata(release: GHRelease): Pick<VersionEntry, 'version' | 'date' | 'title'> {
    const version = release.tag_name.replace(/^v/, '');
    return {
      version,
      date: release.published_at?.split('T')[0] ?? '',
      title: release.name || `v${version}`,
    };
}

function tagMetadata(tag: DockerHubTag): Pick<VersionEntry, 'version' | 'channel' | 'date' | 'title' | 'sha'> {
    const sha8 = tag.name.replace('dev-', '');
    return {
      version: tag.name,
      channel: 'dev',
      date: tag.last_updated?.split('T')[0] ?? '',
      title: `Dev build ${sha8}`,
      sha: sha8,
    };
}

async function getAllVersions(): Promise<VersionEntry[]> {
  const runningVersion = getRunningVersion();
  const versions: VersionEntry[] = [];

  for (const release of await githubReleases()) {
    const metadata = releaseMetadata(release);
    versions.push({
      ...metadata,
      channel: release.prerelease ? 'dev' : 'stable',
      body: release.body || undefined,
      current: metadata.version === runningVersion,
    });
  }

  for (const tag of (await dockerHubDevTags()).slice(0, 20)) {
    versions.push({
      ...tagMetadata(tag),
      current: tag.name === runningVersion,
    });
  }

  versions.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return versions;
}

const ChannelSchema = z.enum(['stable', 'dev']);

const RunningVersionSchema = z
  .object({
    version: z.string(),
    channel: z.enum(['stable', 'dev', 'none']),
  })
  .openapi('SandboxRunningVersion');

const LatestVersionSchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
    date: z.string().optional(),
    title: z.string().optional(),
    sha: z.string().optional(),
  })
  .openapi('SandboxLatestVersion');

const VersionEntrySchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
    date: z.string(),
    title: z.string(),
    body: z.string().optional(),
    sha: z.string().optional(),
    current: z.boolean(),
  })
  .openapi('SandboxVersionEntry');

const AllVersionsSchema = z
  .object({
    versions: z.array(VersionEntrySchema),
    current: RunningVersionSchema,
  })
  .openapi('SandboxAllVersions');

// Entries are assembled as `Record<string, unknown>` (version/channel/date/title/
// description/changes, plus `sha` on dev). Keep the schema permissive so it
// documents the surface without constraining the opaque map the handler returns.
const ChangelogEntrySchema = z
  .record(z.string(), z.unknown())
  .openapi('SandboxChangelogEntry');

const ChangelogSchema = z
  .object({ changelog: z.array(ChangelogEntrySchema) })
  .openapi('SandboxChangelog');

const versionRouter = makeOpenApiApp<AppEnv>();

versionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['platform'],
    summary: 'Running sandbox version and channel',
    responses: {
      200: json(RunningVersionSchema, 'The sandbox version this server is running'),
    },
  }),
  (c) => {
    return c.json({
      version: getRunningVersion(),
      channel: getRunningChannel(),
    });
  },
);

versionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/latest',
    tags: ['platform'],
    summary: 'Latest available sandbox version for a channel',
    request: {
      query: z.object({ channel: ChannelSchema.optional() }),
    },
    responses: {
      200: json(LatestVersionSchema, 'Latest version for the requested channel (stable by default)'),
    },
  }),
  async (c) => {
    const channel = (c.req.query('channel') || 'stable') as VersionChannel;
    const latest = channel === 'dev' ? await getLatestDev() : await getLatestStable();
    return c.json(latest);
  },
);

versionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/all',
    tags: ['platform'],
    summary: 'All known sandbox versions plus the current running version',
    responses: {
      200: json(AllVersionsSchema, 'All versions across channels and the current running version'),
    },
  }),
  async (c) => {
    const versions = await getAllVersions();
    return c.json({
      versions,
      current: {
        version: getRunningVersion(),
        channel: getRunningChannel(),
      },
    });
  },
);

versionRouter.openapi(
  createRoute({
    method: 'get',
    path: '/changelog',
    tags: ['platform'],
    summary: 'Sandbox changelog entries for a channel',
    request: {
      query: z.object({ channel: z.string().optional() }),
    },
    responses: {
      200: json(ChangelogSchema, 'Changelog entries (stable, dev, or all)'),
    },
  }),
  async (c) => {
  const channel = c.req.query('channel') || 'all';
  const entries: Array<Record<string, unknown>> = [];

  if (channel === 'stable' || channel === 'all') {
    for (const release of await githubReleases()) {
      if (release.prerelease) continue;
      entries.push({
        ...releaseMetadata(release),
        channel: 'stable',
        description: release.body || '',
        changes: [],
      });
    }
  }

  if (channel === 'dev' || channel === 'all') {
    for (const tag of (await dockerHubDevTags()).slice(0, 20)) {
      entries.push({
        ...tagMetadata(tag),
        description: '',
        changes: [],
      });
    }
  }

  entries.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return c.json({ changelog: entries });
  },
);

export { versionRouter };

function detectVersionChannel(version: string | null | undefined): VersionChannel {
  return version?.startsWith('dev-') ? 'dev' : 'stable';
}
