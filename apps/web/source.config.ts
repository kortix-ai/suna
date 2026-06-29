import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

// Docs use fumadocs/MDX. The blog does NOT — it is React-rendered from a typed
// registry (src/lib/blog-posts.ts), so there is no blog collection here.
export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig();
