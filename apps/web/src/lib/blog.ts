/**
 * Blog post utilities.
 *
 * Reads MDX frontmatter from `content/blog/` at build time using a simple
 * regex-based frontmatter parser. Avoids adding gray-matter as a dependency.
 * The MDX body is rendered via Next.js dynamic import (withMDX already configured).
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;      // ISO date string
  author?: string;
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const raw = match[1] ?? '';
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}

// ─── Blog directory ───────────────────────────────────────────────────────────

function getBlogDir(): string {
  // Works for both local dev and Next.js standalone build
  return path.join(process.cwd(), 'content', 'blog');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all blog posts, sorted by date descending. */
export function getAllPosts(): BlogPost[] {
  const dir = getBlogDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mdx'));

  const posts: BlogPost[] = files
    .map((file) => {
      const slug = file.replace(/\.mdx$/, '');
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      return {
        slug: fm.slug ?? slug,
        title: fm.title ?? slug,
        description: fm.description ?? '',
        date: fm.date ?? '1970-01-01',
        author: fm.author,
      };
    })
    .filter((p) => p.title !== '');

  return posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/** Get a single post's metadata by slug. */
export function getPostBySlug(slug: string): BlogPost | null {
  const all = getAllPosts();
  return all.find((p) => p.slug === slug) ?? null;
}

/** Get all slugs for static params generation. */
export function getAllSlugs(): string[] {
  const dir = getBlogDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.replace(/\.mdx$/, ''));
}
