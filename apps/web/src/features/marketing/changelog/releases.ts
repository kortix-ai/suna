import 'server-only';

import { unstable_cache } from 'next/cache';

import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';

import { CHANGELOG_PAGE_SIZE, changelogPageHref, paginateReleases } from './paging';
import { CHANGELOG_REPO, renderReleaseMarkdown } from './render';
import type {
  ChangelogPage,
  ChangelogRelease,
  ChangelogWeek,
  ChangelogWeekDetail,
  ChangelogWeekly,
  GitHubRelease,
} from './types';
import {
  groupByWeek,
  isoWeekId,
  parseSections,
  pickHighlights,
  splitLead,
  weekSlug,
  type ReleaseSections,
  type WeekWindow,
} from './weekly';
import { readWeeklyBriefs, type WeeklyBriefs } from './weekly-briefs';

export { CHANGELOG_REPO };

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
 * Returns `null` for a page past the end. When GitHub is unreachable nothing
 * is cached (the next request retries): page 1 comes back empty, a later
 * page throws.
 */
export async function getChangelogPage(page: number): Promise<ChangelogPage | null> {
  try {
    // The data cache outlives deploys, so the key names everything that
    // shapes an entry: bump `v1` when ChangelogPage changes shape.
    return await unstable_cache(
      () => buildChangelogPage(page),
      ['changelog-page', 'v2', `size-${CHANGELOG_PAGE_SIZE}`, String(page)],
      { revalidate: CHANGELOG_REVALIDATE_SECONDS, tags: ['changelog'] },
    )();
  } catch (error) {
    // On Vercel the page is ISR (static per locale, regenerated hourly). A
    // failed read during a background regeneration throws, so Next keeps
    // serving the last good page instead of the empty state for an hour. The
    // build (no page to fall back to) and per-request rendering (standalone)
    // fall through to the states below.
    if (runtimeConfigIsBakedAtBuild() && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw error;
    }
    // Page 1 shows its "couldn't load releases" state. A later page cannot
    // say anything useful, and a 404 would tell crawlers it is gone: rethrow
    // so it answers 500, which crawlers treat as transient.
    if (page === 1) return { page: 1, pageCount: 1, releases: [], tagPages: {} };
    throw error;
  }
}

/** Weeks on `/changelog`, each with its own page. Older weeks live on Release history. */
export const WEEKLY_WEEK_COUNT = 12;

interface WeekSource {
  window: WeekWindow;
  slug: string;
  /** Newest first, each with its parsed sections. */
  releases: { release: GitHubRelease; sections: ReleaseSections }[];
  /** Index of the release that names the week: the most New items, ties to the newest. */
  lead: number;
}

/** The newest `WEEKLY_WEEK_COUNT` weeks, parsed and named. */
function weekSources(all: GitHubRelease[]): WeekSource[] {
  return groupByWeek(all)
    .slice(0, WEEKLY_WEEK_COUNT)
    .map(({ window, releases }) => {
      const parsed = releases.map((release) => ({
        release,
        sections: parseSections(release.body),
      }));
      const lead = parsed.reduce(
        (best, r, i) => (r.sections.new.length > parsed[best].sections.new.length ? i : best),
        0,
      );
      return { window, slug: weekSlug(window), releases: parsed, lead };
    });
}

async function weekSummary(
  source: WeekSource,
  tagPages: Record<string, number>,
  currentWeek: string,
  briefs: WeeklyBriefs,
): Promise<ChangelogWeek> {
  const { window, releases, lead, slug } = source;
  const count = (key: keyof ReleaseSections) =>
    releases.reduce((sum, r) => sum + r.sections[key].length, 0);
  const highlights = await Promise.all(
    pickHighlights(releases.map((r) => r.sections.new)).map(async (bullet) => {
      const { title, body } = splitLead(bullet);
      return { title, html: body ? await renderReleaseMarkdown(body) : '' };
    }),
  );
  return {
    id: window.id,
    slug,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    inProgress: window.id === currentWeek,
    headline: releaseHeadline(releases[lead].release),
    releases: releases.map(({ release }) => ({
      tag: release.tag_name,
      headline: releaseHeadline(release),
      publishedAt: release.published_at!,
      href: `${changelogPageHref(tagPages[release.tag_name] ?? 1)}#${release.tag_name}`,
    })),
    highlights,
    summary: briefs[window.id] ?? null,
    counts: { new: count('new'), improved: count('improved'), fixed: count('fixed') },
  };
}

/** One section merged across the week's releases → one rendered list, or `null` when empty. */
function renderBullets(bullets: string[]): Promise<string | null> {
  if (bullets.length === 0) return Promise.resolve(null);
  return renderReleaseMarkdown(bullets.map((b) => `- ${b}`).join('\n'));
}

async function buildWeeklyChangelog(): Promise<ChangelogWeekly> {
  const [all, briefs] = await Promise.all([fetchReleases(), readWeeklyBriefs()]);
  const { tagPages } = paginateReleases(all, 1);
  const currentWeek = isoWeekId(new Date());
  const weeks = await Promise.all(
    weekSources(all).map((source) => weekSummary(source, tagPages, currentWeek, briefs)),
  );
  return { weeks, tagPages };
}

async function buildWeekDetail(slug: string): Promise<ChangelogWeekDetail | null> {
  const [all, briefs] = await Promise.all([fetchReleases(), readWeeklyBriefs()]);
  const source = weekSources(all).find((w) => w.slug === slug);
  if (!source) return null;
  const { tagPages } = paginateReleases(all, 1);
  const merged = (key: keyof ReleaseSections) => source.releases.flatMap((r) => r.sections[key]);
  const [week, newHtml, improvedHtml, fixedHtml] = await Promise.all([
    weekSummary(source, tagPages, isoWeekId(new Date()), briefs),
    renderBullets(merged('new')),
    renderBullets(merged('improved')),
    renderBullets(merged('fixed')),
  ]);
  return { week, sections: { new: newHtml, improved: improvedHtml, fixed: fixedHtml } };
}

/**
 * The newest `WEEKLY_WEEK_COUNT` weeks that had a production release, newest
 * first, for `/changelog`. Cached and failure-handled like `getChangelogPage`:
 * a GitHub outage is never cached, ISR keeps the last good page, and other
 * renders get an empty list.
 */
export async function getWeeklyChangelog(): Promise<ChangelogWeekly> {
  try {
    // Bump the version when ChangelogWeekly changes shape: the data cache outlives deploys.
    return await unstable_cache(buildWeeklyChangelog, ['changelog-weekly', 'v7'], {
      revalidate: CHANGELOG_REVALIDATE_SECONDS,
      tags: ['changelog'],
    })();
  } catch (error) {
    if (runtimeConfigIsBakedAtBuild() && process.env.NEXT_PHASE !== 'phase-production-build') {
      throw error;
    }
    return { weeks: [], tagPages: {} };
  }
}

/**
 * One week with every New, Improved and Fixed item, for `/changelog/<slug>`.
 * `null` for a slug that is not one of the listed weeks. The slug is checked
 * against the cached week list first, so an unknown URL never reaches GitHub
 * or adds a cache entry. Throws when GitHub is unreachable: the page answers
 * 500, which crawlers treat as transient (same as a later Release history page).
 */
export async function getChangelogWeek(slug: string): Promise<ChangelogWeekDetail | null> {
  const { weeks } = await getWeeklyChangelog();
  if (!weeks.some((w) => w.slug === slug)) return null;
  return unstable_cache(() => buildWeekDetail(slug), ['changelog-week', 'v5', slug], {
    revalidate: CHANGELOG_REVALIDATE_SECONDS,
    tags: ['changelog'],
  })();
}
