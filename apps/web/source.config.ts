import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

// Docs use fumadocs/MDX. The blog does NOT — it is React-rendered from a typed
// registry (src/lib/blog-posts.ts), so there is no blog collection here.
export const docs = defineDocs({
  dir: 'content/docs',
});

// Frontmatter contract for the use-case / case-study MDX collection. `author`
// references a key in the author registry (src/lib/blog.ts); the rest is
// self-describing.
const contentSchema = frontmatterSchema.extend({
  // ISO date (YYYY-MM-DD). Drives sort order and the visible byline. YAML
  // auto-parses an unquoted `2026-06-03` into a Date, so accept both and
  // normalize to a "YYYY-MM-DD" string either way.
  date: z
    .union([z.string(), z.date()])
    .transform((v) => (typeof v === 'string' ? v : v.toISOString().slice(0, 10))),
  author: z.string(),
  tags: z.array(z.string()).default([]),
  cover: z.string().optional(),
  draft: z.boolean().default(false),
});

// Use-case / case-study collection: long-form MDX in `content/use-cases/`,
// surfaced under /use-cases with its own listing.
export const useCases = defineDocs({
  dir: 'content/use-cases',
  docs: { schema: contentSchema },
});

export default defineConfig();
