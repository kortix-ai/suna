import { defineDocs, defineConfig, frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content/docs',
});

// Blog collection. Each post is a single `.mdx` file in `content/blog/`.
// The frontmatter schema below is the contract — adding a post is just dropping
// in a file with these fields. `author` references a key in the author registry
// (src/lib/blog.ts); everything else is self-describing.
export const blog = defineDocs({
  dir: 'content/blog',
  docs: {
    schema: frontmatterSchema.extend({
      // ISO date (YYYY-MM-DD). Drives sort order and the visible byline.
      // YAML auto-parses an unquoted `2026-06-03` into a Date, so accept both a
      // string and a Date and normalize to a "YYYY-MM-DD" string either way.
      date: z
        .union([z.string(), z.date()])
        .transform((v) => (typeof v === 'string' ? v : v.toISOString().slice(0, 10))),
      // Author key from the registry in src/lib/blog.ts (e.g. "marko").
      author: z.string(),
      // Optional taxonomy — shown as pills, no routing required.
      tags: z.array(z.string()).default([]),
      // Optional cover image (path under /public, e.g. "/blog/foo.png").
      // Omit it and the card/header fall back to a clean typographic treatment.
      cover: z.string().optional(),
      // Hide from listings/sitemap while drafting.
      draft: z.boolean().default(false),
    }),
  },
});

export default defineConfig();
