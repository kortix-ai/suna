import type { CoverLogo } from '@/components/blog/blog-cover';

/**
 * Post shapes and the author registry shared by the use-case pages. The blog
 * itself moved to its own codebase (kortix-ai/marketing) and is served at
 * /blog through a next.config.ts rewrite, so no blog post lives here.
 */

export interface Author {
  name: string;
  /** Short role/title shown under the name. */
  role: string;
  /** Used by <UserAvatar> for initials + image lookup. */
  email: string;
  avatarUrl?: string;
  /**
   * This author is Kortix itself, not a person — `<PostAuthorAvatar>` renders
   * the Kortix symbol instead of initials. A flag rather than a check on
   * `role`, because `role` is display copy: rewording it must not silently
   * change which mark renders.
   */
  isKortix?: boolean;
}

// Author registry. A post references one of these keys (`author: 'marko'`);
// edit a person once here and every post updates.
export const AUTHORS: Record<string, Author> = {
  marko: {
    name: 'Marko Kraemer',
    role: 'Co-founder',
    email: 'marko@kortix.ai',
  },
  team: {
    name: 'The Kortix Team',
    role: 'Kortix',
    email: 'team@kortix.ai',
    isKortix: true,
  },
};

export function resolveAuthor(key: string): Author {
  return AUTHORS[key] ?? { name: key, role: '', email: `${key}@kortix.ai` };
}

export interface PostFrontmatter {
  title: string;
  description?: string;
  date: string;
  author: string;
  tags: string[];
  cover?: string;
  coverLogos?: CoverLogo[];
  coverKortix?: boolean;
  draft: boolean;
  /** Catalog id of an installable template this post maps to (use cases only). */
  template?: string;
}

export interface Post {
  slug: string;
  url: string;
  data: PostFrontmatter;
  author: Author;
  readingTime: number;
}

export function formatPostDate(date: string): string {
  // Append a fixed time so the YYYY-MM-DD string is parsed as UTC, not local —
  // otherwise dates can render one day off depending on the server timezone.
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
