import fs from 'fs';
import path from 'path';
import { blogSource } from '@/lib/blog-source';

/**
 * Blog data layer. One place that turns the raw fumadocs pages into the shape
 * the UI renders — sorted, draft-filtered, with derived reading time and a
 * resolved author. Routes and components import only from here.
 */

export interface Author {
  name: string;
  /** Short role/title shown under the name. */
  role: string;
  /** Used by <UserAvatar> for initials + image lookup. */
  email: string;
  avatarUrl?: string;
}

// Author registry. A post references one of these keys in its frontmatter
// (`author: marko`); edit a person once here and every post updates.
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
  draft: boolean;
}

export interface Post {
  slug: string;
  url: string;
  data: PostFrontmatter;
  author: Author;
  readingTime: number;
}

const WORDS_PER_MINUTE = 220;
const BLOG_DIR = path.join(process.cwd(), 'content', 'blog');

// Estimate reading time by counting words in the source file. Every blog page
// is statically generated, so this file read only ever happens at build time
// and the result is baked into the rendered HTML.
function readingTimeFor(slug: string): number {
  try {
    const raw = fs.readFileSync(path.join(BLOG_DIR, `${slug}.mdx`), 'utf8');
    const body = raw
      .replace(/^---[\s\S]*?---/, '') // strip frontmatter
      .replace(/```[\s\S]*?```/g, '') // drop code blocks
      .replace(/[#>*_`\-]/g, ' '); // drop markdown punctuation
    const words = body.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  } catch {
    return 1;
  }
}

function toPost(page: any): Post {
  const data = page.data as PostFrontmatter;
  const slug = page.slugs[0] ?? '';
  return {
    slug,
    url: page.url,
    data,
    author: resolveAuthor(data.author),
    readingTime: readingTimeFor(slug),
  };
}

/** All published posts, newest first. Drafts are excluded in production. */
export function getAllPosts(): Post[] {
  const includeDrafts = process.env.NODE_ENV !== 'production';
  return blogSource
    .getPages()
    .filter((page) => includeDrafts || !(page.data as PostFrontmatter).draft)
    .map(toPost)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
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
