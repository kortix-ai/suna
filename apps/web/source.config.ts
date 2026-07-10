import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

// Docs use fumadocs/MDX. The blog does NOT — it is React-rendered from a typed
// registry (src/lib/blog-posts.ts), so there is no blog collection here.
export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      // Keep fumadocs' defaults (defaultColor: false dual-theme CSS vars, lazy
      // grammars, notation transformers); only swap the palette.
      ...rehypeCodeDefaultOptions,
      // Intentionally mirrors SHIKI_THEME_LIGHT / SHIKI_THEME_DARK in
      // doc-markdown.tsx so docs code matches the app's markdown renderer.
      themes: { light: 'slack-ochin', dark: 'plastic' },
    },
  },
});
