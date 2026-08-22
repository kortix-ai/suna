import { rehypeCodeDefaultOptions, remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';
import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from './src/lib/code-theme';

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
  // Catalog id of an installable template this use case maps to. When set, the
  // page shows a "Use this template" button that launches the guided install.
  template: z.string().optional(),
});

// Use-case / case-study collection: long-form MDX in `content/use-cases/`,
// surfaced under /use-cases with its own listing.
export const useCases = defineDocs({
  dir: 'content/use-cases',
  docs: { schema: contentSchema },
});

export default defineConfig({
  mdxOptions: {
    // ```mermaid fences compile to <Mermaid chart="..."/> (rendered by the
    // docs MDX component map) instead of a highlighted code block.
    remarkPlugins: [remarkMdxMermaid],
    rehypeCodeOptions: {
      // Keep fumadocs' defaults (defaultColor: false dual-theme CSS vars, lazy
      // grammars, notation transformers); only swap the palette.
      ...rehypeCodeDefaultOptions,
      // Same palette as every other code surface — imported, not copied. The
      // duplicate literal that used to sit here drifted to a different theme and
      // its "keep in sync" comment named the wrong file.
      themes: { light: SHIKI_THEME_LIGHT, dark: SHIKI_THEME_DARK },
      // Emit `language-*` on the <code> element. The docs `pre` override
      // (docs-mdx-components.tsx) renders the app CodeBlock shell, whose header
      // shows the language — without this class rehype-code keeps the language
      // to itself and the label has nothing to read.
      addLanguageClass: true,
    },
  },
});
