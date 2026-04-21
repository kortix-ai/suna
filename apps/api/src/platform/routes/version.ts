import { Hono } from 'hono';
import { config } from '../../config';

/**
 * Sandbox version + changelog endpoints.
 *
 * Sources of truth:
 *   - Running version: process.env.SANDBOX_VERSION (injected at container start)
 *   - Stable releases: GitHub Releases API
 *   - Dev builds:      Docker Hub Tags API (kortix/computer:dev-*)
 *
 * Docker Hub tag convention:
 *   - Stable:  kortix/computer:0.8.29,  kortix/computer:latest
 *   - Dev:     kortix/computer:dev-{sha8},  kortix/computer:dev-latest
 *
 * Update flow (frontend):
 *   1. GET /v1/platform/sandbox/version           → running version
 *   2. GET /v1/platform/sandbox/version/latest    → latest available (by channel)
 *   3. GET /v1/platform/sandbox/version/all       → all installable versions
 *   4. POST /v1/platform/sandbox/update { version } → pull + recreate container
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const GITHUB_REPO = 'kortix-ai/suna';
const GITHUB_API_BASE = 'https://api.github.com';
const DOCKERHUB_REPO = 'kortix/computer';
const DOCKERHUB_TAGS_URL = `https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/tags`;

const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

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
  full_size: number;
}

interface GHRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

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
  return entry !== null && (Date.now() - entry.cachedAt) < CACHE_TTL_MS;
}

// ─── Running version (injected at container start) ─────────────────────────

function getRunningVersion(): string {
  return process.env.SANDBOX_VERSION || config.SANDBOX_VERSION_OVERRIDE || 'unknown';
}

function getRunningChannel(): VersionChannel {
  const version = getRunningVersion();
  return version.startsWith('dev-') ? 'dev' : 'stable';
}

// ─── GitHub API ─────────────────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${config.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch<T>(path: string): Promise<T> {
  const url = `${GITHUB_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchStableReleases(limit = 20): Promise<GHRelease[]> {
  try {
    const releases = await githubFetch<GHRelease[]>(`/repos/${GITHUB_REPO}/releases?per_page=${limit}`);
    return releases.filter((r) => !r.draft);
  } catch (err) {
    console.warn('[version] Failed to fetch GitHub releases:', err);
    return [];
  }
}

// ─── Docker Hub API ─────────────────────────────────────────────────────────

async function fetchDockerHubDevTags(limit = 20): Promise<DockerHubTag[]> {
  try {
    const res = await fetch(`${DOCKERHUB_TAGS_URL}/?page_size=100&ordering=last_updated`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
    const data = await res.json() as { results: DockerHubTag[] };
    return (data.results || [])
      .filter((tag) => {
        // Only user-installable dev tags (dev-{sha8}), not internal multi-arch
        // build artifacts (dev-{sha8}-amd64, dev-{sha8}-arm64) or the moving
        // dev-latest pointer.
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

// ─── Resolvers ──────────────────────────────────────────────────────────────

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

  // No dev tags — fall back to running version if it's a dev build
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

  // Stable releases from GitHub Releases API
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

  // Dev builds from Docker Hub Tags API
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

  // Sort by date descending
  versions.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  cache.allVersions = { data: versions, cachedAt: Date.now() };
  return versions;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const versionRouter = new Hono();

/**
 * GET /v1/platform/sandbox/version
 * Returns the version of this running API container.
 */
versionRouter.get('/', async (c) => {
  const version = getRunningVersion();
  const channel = getRunningChannel();
  return c.json({ version, channel });
});

/**
 * GET /v1/platform/sandbox/version/latest
 * Query: ?channel=stable (default) | dev
 */
versionRouter.get('/latest', async (c) => {
  const channel = (c.req.query('channel') || 'stable') as VersionChannel;

  if (channel === 'dev') {
    const latest = await getLatestDev();
    return c.json({
      version: latest.version,
      channel: 'dev' as const,
      date: latest.date,
      sha: latest.sha,
      title: latest.title,
    });
  }

  const latest = await getLatestStable();
  return c.json({
    version: latest.version,
    channel: 'stable' as const,
    date: latest.date,
    title: latest.title,
  });
});

/**
 * GET /v1/platform/sandbox/version/all
 * Returns all installable versions (stable from GitHub Releases + dev from Docker Hub).
 */
versionRouter.get('/all', async (c) => {
  const versions = await getAllVersions();
  const runningVersion = getRunningVersion();
  const runningChannel = getRunningChannel();
  return c.json({
    versions,
    current: {
      version: runningVersion,
      channel: runningChannel,
    },
  });
});

/**
 * GET /v1/platform/sandbox/version/changelog
 * Returns a unified changelog (stable releases + dev commits merged).
 * Query: ?channel=all (default) | stable | dev
 */
versionRouter.get('/changelog', async (c) => {
  const channel = c.req.query('channel') || 'all';
  const entries: any[] = [];

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

  // Sort by date descending
  entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  return c.json({ changelog: entries });
});

export { versionRouter };
export function detectVersionChannel(version: string | null | undefined): VersionChannel {
  return version?.startsWith('dev-') ? 'dev' : 'stable';
}

export function hasNewerSandboxVersion(current: string, latest: string, channel: VersionChannel): boolean {
  if (channel === 'dev') return current !== latest;
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export async function getLatestVersionForChannel(channel: VersionChannel): Promise<LatestVersionResult> {
  return channel === 'dev' ? getLatestDev() : getLatestStable();
}
