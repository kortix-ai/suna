import 'server-only';

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CoverLogo } from '@/components/blog/blog-cover';
import { resolveAuthor, type Post } from '@/lib/blog';

/**
 * The blog, as Markdown files: `content/posts/<slug>.md`, frontmatter for the
 * metadata and GitHub-flavored Markdown for the body (format kept identical to
 * kortix-ai/marketing `apps/blog`, so a post moves between the two unchanged).
 * The body renders through `@/components/blog/blog-markdown`; the rich blocks
 * (compare, verdict, logos, cta) are fenced blocks whose YAML body is the data.
 */
export type BlogPostEntry = {
  slug: string;
  title: string;
  description: string;
  /** ISO date YYYY-MM-DD — sort order and the byline. */
  date: string;
  /** Last substantive update; defaults to `date`. */
  updated?: string;
  /** Canonical URL when the post's home is another page. */
  canonical?: string;
  author: string;
  tags: string[];
  /** Cover image — used for OG/social only. */
  cover?: string;
  /** Competitor logos for the on-page cover lockup. Empty → a brand-mark cover. */
  coverLogos?: CoverLogo[];
  coverKortix?: boolean;
  /** Lead media, rendered in place of the generated cover lockup. */
  leadMedia?: {
    poster: string;
    sources: { src: string; type: string }[];
    alt: string;
    aspectRatio: string;
  };
  /** The opening paragraph, set larger than the body. Inline Markdown. */
  lead?: string;
  readingTime: number;
  draft?: boolean;
  body: string;
};

const POSTS_DIR = path.join(process.cwd(), 'content', 'posts');
const WORDS_PER_MINUTE = 230;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function asDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

export function parsePost(slug: string, source: string): BlogPostEntry {
  const match = FRONTMATTER.exec(source);
  const data = (match ? parseYaml(match[1]) : {}) as Record<string, any>;
  const body = (match ? source.slice(match[0].length) : source).trim();
  const words = `${data.lead ?? ''} ${body}`.split(/\s+/).filter(Boolean).length;
  return {
    slug,
    title: data.title,
    description: data.description ?? '',
    date: asDate(data.date),
    updated: data.updated ? asDate(data.updated) : undefined,
    canonical: data.canonical,
    author: data.author ?? 'team',
    tags: data.tags ?? [],
    cover: data.cover,
    coverLogos: data.coverLogos,
    coverKortix: data.coverKortix,
    leadMedia: data.leadMedia,
    lead: data.lead,
    readingTime: data.readingTime ?? Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    draft: data.draft ?? false,
    body,
  };
}

let cache: BlogPostEntry[] | null = null;

function loadPosts(): BlogPostEntry[] {
  cache ??= fs
    .readdirSync(POSTS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => parsePost(file.slice(0, -3), fs.readFileSync(path.join(POSTS_DIR, file), 'utf8')));
  return cache;
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
  return loadPosts()
    .filter((entry) => includeDrafts || !entry.draft)
    .map(toPost)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** The full entry (with the Markdown body) for one post. */
export function getPostEntry(slug: string): BlogPostEntry | undefined {
  return loadPosts().find((entry) => entry.slug === slug);
}
