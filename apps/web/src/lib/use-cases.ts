import fs from 'fs';
import path from 'path';

import { resolveAuthor, type Post, type PostFrontmatter } from '@/lib/blog';
import { useCasesSource } from '@/lib/use-cases-source';

/**
 * Use-case / case-study data layer. A use case is a long-form MDX post surfaced
 * under /use-cases; it reuses the blog's `Post`/author primitives but has its
 * own fumadocs collection, so this file is self-contained. Routes and components
 * import only from here.
 */

const USE_CASES_DIR = path.join(process.cwd(), 'content', 'use-cases');
const WORDS_PER_MINUTE = 220;

// Estimate reading time from the source file. Pages are statically generated, so
// this read only happens at build time and is baked into the rendered HTML.
function readingTimeFor(contentDir: string, slug: string): number {
  try {
    const raw = fs.readFileSync(path.join(contentDir, `${slug}.mdx`), 'utf8');
    const body = raw
      .replace(/^---[\s\S]*?---/, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#>*_`\-]/g, ' ');
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
    readingTime: readingTimeFor(USE_CASES_DIR, slug),
  };
}

/** All published use cases, newest first. Drafts are excluded in production. */
export function getAllUseCases(): Post[] {
  const includeDrafts = process.env.NODE_ENV !== 'production';
  return useCasesSource
    .getPages()
    .filter((page) => includeDrafts || !(page.data as PostFrontmatter).draft)
    .map(toPost)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
}
