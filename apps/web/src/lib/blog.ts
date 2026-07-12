import type { CoverLogo } from '@/components/blog/blog-cover';
import { BLOG_POSTS, type BlogPostEntry } from '@/lib/blog-posts';

/**
 * Blog data layer. The blog is React-rendered from a typed registry
 * (`blog-posts.ts`), not MDX. This module turns those entries into the shape
 * the UI renders — sorted, draft-filtered, with a resolved author. Routes and
 * components import only from here.
 */

export interface Author {
  name: string;
  /** Short role/title shown under the name. */
  role: string;
  /** Used by <UserAvatar> for initials + image lookup. */
  email: string;
  avatarUrl?: string;
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

function toPost(entry: BlogPostEntry): Post {
  return {
    slug: entry.slug,
    url: `/blog/${entry.slug}`,
    data: {
      title: entry.title,
      description: entry.description,
      date: entry.date,
      author: entry.author,
      tags: entry.tags,
      cover: entry.cover,
      coverLogos: entry.coverLogos,
      coverKortix: entry.coverKortix,
      draft: entry.draft ?? false,
    },
    author: resolveAuthor(entry.author),
    readingTime: entry.readingTime,
  };
}

/** All published posts, newest first. Drafts are excluded in production. */
export function getAllPosts(): Post[] {
  const includeDrafts = process.env.NODE_ENV !== 'production';
  return BLOG_POSTS.filter((entry) => includeDrafts || !entry.draft)
    .map(toPost)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** The full registry entry (including the renderable blocks) for one post. */
export function getPostEntry(slug: string): BlogPostEntry | undefined {
  return BLOG_POSTS.find((entry) => entry.slug === slug);
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
