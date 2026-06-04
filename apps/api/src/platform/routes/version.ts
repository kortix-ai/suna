import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { makeOpenApiApp, json } from '../../openapi';
import { config } from '../../config';

/**
 * Sandbox version and changelog endpoints.
 *
 * Sources of truth:
 * - Running version: SANDBOX_VERSION, injected at container start.
 * - Stable releases: GitHub Releases API.
 * - Dev builds: Docker Hub tags for kortix/kortix-sandbox.
 */

const GITHUB_REPO = 'kortix-ai/suna';
const GITHUB_API_BASE = 'https://api.github.com';
const DOCKERHUB_REPO = 'kortix/kortix-sandbox';
const DOCKERHUB_TAGS_URL = `https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/tags`;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type VersionChannel = 'stable' | 'dev';

interface VersionEntry {
  version: string;
  channel: VersionChannel;
  date: string;
  title: string;
  body?: string;
  sha?: string;
  current: boolean;
}

export interface LatestVersionResult {
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

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const cache: {
  latestStable: CacheEntry<LatestVersionResult> | null;
  latestDev: CacheEntry<LatestVersionResult> | null;
  allVersions: CacheEntry<VersionEntry[]> | null;
} = {
  latestStable: null,
  latestDev: null,
  allVersions: null,
};

function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function getRunningVersion(): string {
  return process.env.SANDBOX_VERSION || config.SANDBOX_VERSION_OVERRIDE || 'unknown';
}

function getRunningChannel(): VersionChannel {
  return detectVersionChannel(getRunningVersion());
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchStableReleases(limit = 20): Promise<GHRelease[]> {
  try {
    const releases = await githubFetch<GHRelease[]>(`/repos/${GITHUB_REPO}/releases?per_page=${limit}`);
    return releases.filter((release) => !release.draft);
  } catch (err) {
    console.warn('[version] Failed to fetch GitHub releases:', err);
    return [];
  }
}

async function fetchDockerHubDevTags(limit = 20): Promise<DockerHubTag[]> {
  try {
    const res = await fetch(`${DOCKERHUB_TAGS_URL}/?page_size=100&ordering=last_updated`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
    const data = await res.json() as { results: DockerHubTag[] };
    return (data.results || [])
      .filter((tag) => {
        if (!tag.name.startsWith('dev-')) return false;
        if (tag.name === 'dev-latest') return false;
        if (tag.name.endsWith('-amd64') || tag.name.endsWith('-arm64')) return false;
        return true;
      })
      .slice(0, limit);
  } catch (err) {
    console.warn('[version] Failed to fetch Docker Hub dev tags:', err);
    return [];
  }
}

async function getLatestStable(): Promise<LatestVersionResult> {
  if (isCacheValid(cache.latestStable)) return cache.latestStable.data;

  const releases = await fetchStableReleases(1);
  if (releases.length > 0) {
    const release = releases[0];
    const version = release.tag_name.replace(/^v/, '');
    const result: LatestVersionResult = {
      version,
      channel: 'stable',
      date: release.published_at?.split('T')[0],
      title: release.name || `v${version}`,
    };
    cache.latestStable = { data: result, cachedAt: Date.now() };
    return result;
  }

  return { version: 'unknown', channel: 'stable', title: 'No stable release available' };
}

async function getLatestDev(): Promise<LatestVersionResult> {
  if (isCacheValid(cache.latestDev)) return cache.latestDev.data;

  const tags = await fetchDockerHubDevTags(1);
  if (tags.length > 0) {
    const tag = tags[0];
    const sha8 = tag.name.replace('dev-', '');
    const result: LatestVersionResult = {
      version: tag.name,
      channel: 'dev',
      date: tag.last_updated?.split('T')[0],
      title: `Dev build ${sha8}`,
      sha: sha8,
    };
    cache.latestDev = { data: result, cachedAt: Date.now() };
    return result;
  }

  const running = getRunningVersion();
  return {
    version: running.startsWith('dev-') ? running : 'dev-unknown',
    channel: 'dev',
    title: 'No dev build available',
  };
}

async function getAllVersions(): Promise<VersionEntry[]> {
  if (isCacheValid(cache.allVersions)) return cache.allVersions.data;

  const runningVersion = getRunningVersion();
  const versions: VersionEntry[] = [];

  const releases = await fetchStableReleases(20);
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, '');
    versions.push({
      version,
      channel: release.prerelease ? 'dev' : 'stable',
      date: release.published_at?.split('T')[0] ?? '',
      title: release.name || `v${version}`,
      body: release.body || undefined,
      current: version === runningVersion,
    });
  }

  const devTags = await fetchDockerHubDevTags(20);
  for (const tag of devTags) {
    const sha8 = tag.name.replace('dev-', '');
    versions.push({
      version: tag.name,
      channel: 'dev',
      date: tag.last_updated?.split('T')[0] ?? '',
      title: `Dev build ${sha8}`,
      sha: sha8,
      current: tag.name === runningVersion,
    });
  }

  versions.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  cache.allVersions = { data: versions, cachedAt: Date.now() };
  return versions;
}

const ChannelSchema = z.enum(['stable', 'dev']);

const RunningVersionSchema = z
  .object({
    version: z.string(),
    channel: ChannelSchema,
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
    const releases = await fetchStableReleases(20);
    for (const release of releases) {
      if (release.prerelease) continue;
      const version = release.tag_name.replace(/^v/, '');
      entries.push({
        version,
        channel: 'stable',
        date: release.published_at?.split('T')[0] ?? '',
        title: release.name || `v${version}`,
        description: release.body || '',
        changes: [],
      });
    }
  }

  if (channel === 'dev' || channel === 'all') {
    const devTags = await fetchDockerHubDevTags(20);
    for (const tag of devTags) {
      const sha8 = tag.name.replace('dev-', '');
      entries.push({
        version: tag.name,
        channel: 'dev',
        date: tag.last_updated?.split('T')[0] ?? '',
        title: `Dev build ${sha8}`,
        description: '',
        changes: [],
        sha: sha8,
      });
    }
  }

  entries.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return c.json({ changelog: entries });
  },
);

export { versionRouter };

export function detectVersionChannel(version: string | null | undefined): VersionChannel {
  return version?.startsWith('dev-') ? 'dev' : 'stable';
}

export async function getLatestVersionForChannel(channel: VersionChannel): Promise<LatestVersionResult> {
  return channel === 'dev' ? getLatestDev() : getLatestStable();
}
