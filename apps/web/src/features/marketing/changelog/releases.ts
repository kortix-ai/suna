import 'server-only';

import { unstable_cache } from 'next/cache';

import { paginateReleases } from './paging';
import { renderReleaseMarkdown } from './render';
import type { ChangelogPage, ChangelogRelease, GitHubRelease } from './types';

export const CHANGELOG_REPO = 'kortix-ai/suna';

/** Seconds a rendered changelog page is served before it is rebuilt. */
export const CHANGELOG_REVALIDATE_SECONDS = 3600;

// Only real, published version releases — never the mutable dev-latest /
// desktop-dev-latest prereleases or drafts.
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

// Release names read "v0.12.8 — Entitlement overrides, act-as support sessions".
// The version already headlines its own line, so strip it rather than print it
// twice; a name that is nothing but the version falls back to the tag.
const NAME_VERSION_PREFIX = /^v\d+\.\d+\.\d+\s*(?:[—–-]\s*)?/;

// Huge auto-generated bodies (v0.9.0 is ~800 PR lines) would swallow the whole
// page — the view clamps them in a scroll area and points to GitHub.
const LONG_BODY_CHARS = 6000;

function releaseHeadline(release: GitHubRelease): string {
  const name = release.name?.trim();
  if (!name) return release.tag_name;
  return name.replace(NAME_VERSION_PREFIX, '').trim() || release.tag_name;
}

/**
 * The raw GitHub response for 100 releases is ~4.7 MB. The fetch data cache
 * refuses entries over 2 MB, so `fetch(..., { next: { revalidate } })` never
 * cached it: every request to /changelog re-downloaded the whole list and
 * re-rendered every body (TTFB 2.4–10 s in prod). This fetch is deliberately
 * uncached; the small, rendered result is cached instead (see below).
 *
 * Throws on failure so a GitHub outage or rate limit is never cached as an
 * empty changelog for an hour.
 */
async function fetchReleases(): Promise<GitHubRelease[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kortix-web',
  };
  // Optional — lifts the 60/hr unauthenticated rate limit if a token is set.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${CHANGELOG_REPO}/releases?per_page=100`, {
    headers,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GitHub releases responded ${res.status}`);
  const data = (await res.json()) as GitHubRelease[];
  return (data ?? [])
    .filter((r) => !r.draft && SEMVER_TAG.test(r.tag_name))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
}

async function buildChangelogPage(page: number): Promise<ChangelogPage | null> {
  const all = await fetchReleases();
  const { items, pageCount, tagPages } = paginateReleases(all, page);
  if (!items) return null;
  const releases = await Promise.all(
    items.map(async (release, i): Promise<ChangelogRelease> => {
      const body = release.body?.trim() ?? '';
      return {
        tag: release.tag_name,
        headline: releaseHeadline(release),
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        prerelease: release.prerelease,
        isLatest: page === 1 && i === 0 && !release.prerelease,
        isLong: body.length > LONG_BODY_CHARS,
        html: body ? await renderReleaseMarkdown(body) : null,
      };
    }),
  );
  return { page, pageCount, releases, tagPages };
}

/**
 * One changelog page — at most `CHANGELOG_PAGE_SIZE` releases with their notes
 * already rendered to sanitized HTML. Cached per page for an hour, so a request
 * costs a cache read instead of a GitHub round trip plus ~100 markdown
 * renders. Each entry stays far below the 2 MB data-cache limit.
 *
 * Returns `null` for a page past the end, and an empty page when GitHub is
 * unreachable (not cached — the next request retries).
 */
export async function getChangelogPage(page: number): Promise<ChangelogPage | null> {
  try {
    return await unstable_cache(() => buildChangelogPage(page), ['changelog-page', 'v1', String(page)], {
      revalidate: CHANGELOG_REVALIDATE_SECONDS,
      tags: ['changelog'],
    })();
  } catch {
    return page === 1 ? { page: 1, pageCount: 1, releases: [], tagPages: {} } : null;
  }
}
