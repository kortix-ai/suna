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
