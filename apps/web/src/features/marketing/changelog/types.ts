export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

/** A release as the changelog view renders it: notes already sanitized HTML. */
export interface ChangelogRelease {
  tag: string;
  headline: string;
  publishedAt: string | null;
  htmlUrl: string;
  prerelease: boolean;
  isLatest: boolean;
  isLong: boolean;
  /** Sanitized HTML of the release notes; `null` when the release has none. */
  html: string | null;
}

export interface ChangelogPage {
  /** 1-based. */
  page: number;
  pageCount: number;
  releases: ChangelogRelease[];
  /** Every listed release tag -> the page that renders it. Lets a deep link
   *  to `/changelog#<tag>` find a release that moved to a later page. */
  tagPages: Record<string, number>;
}

/** One ISO week (UTC) of production releases, as the weekly changelog renders it. */
export interface ChangelogWeek {
  /** `2026-W42`. */
  id: string;
  /** The week's Monday, `2026-10-19`: `/changelog/<slug>` and its anchor on `/changelog`. */
  slug: string;
  /** Monday 00:00Z, inclusive. */
  start: string;
  /** The next Monday 00:00Z, exclusive. */
  end: string;
  /** The current week when the entry was built; stale for up to one cache
   *  lifetime (1 h) after Monday 00:00Z. */
  inProgress: boolean;
  /** Headline of the release that added the most New items. */
  headline: string;
  /** Newest first. `href` points at the release on Release history. */
  releases: { tag: string; headline: string; publishedAt: string; href: string }[];
  /** Up to `WEEKLY_HIGHLIGHT_COUNT` New items. `html` is the sanitized body;
   *  `title` is its bold lead, when it has one. */
  highlights: { title: string | null; html: string }[];
  /** The week's 1–5 agent-written summary lines (`weekly-briefs.ts`), or
   *  `null` until the Monday trigger has written them. Shown instead of `highlights`. */
  summary: string[] | null;
  /** Every New / Improved / Fixed bullet across the week's releases. */
  counts: { new: number; improved: number; fixed: number };
}

export interface ChangelogWeekly {
  weeks: ChangelogWeek[];
  /** Same as `ChangelogPage.tagPages`: an old `/changelog#<tag>` link finds its release. */
  tagPages: Record<string, number>;
}

/** One week's page: the summary plus every item, merged per section. */
export interface ChangelogWeekDetail {
  week: ChangelogWeek;
  /** Sanitized HTML of each section's bullets across the week; `null` when empty. */
  sections: { new: string | null; improved: string | null; fixed: string | null };
}
