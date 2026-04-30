import { docs, blog } from '@/.source';
import { loader } from 'fumadocs-core/source';

// ── Docs source ────────────────────────────────────────────────────────────
const generatedSource = docs.toFumadocsSource();

// fumadocs-mdx@11.x returns `Source.files` as a function; fumadocs-core@15.x
// expects an array. Invoke it here to bridge the version mismatch (build
// otherwise crashes during page-data collection with `a.map is not a function`).
const generatedFiles = generatedSource.files;
const files =
  typeof generatedFiles === 'function'
    ? (generatedFiles as unknown as () => any[])()
    : (generatedFiles as unknown as any[]);

export const source = loader({
  baseUrl: '/docs',
  source: { files },
});

// ── Blog source ────────────────────────────────────────────────────────────
const generatedBlogSource = blog.toFumadocsSource();
const blogGeneratedFiles = generatedBlogSource.files;
const blogFiles =
  typeof blogGeneratedFiles === 'function'
    ? (blogGeneratedFiles as unknown as () => any[])()
    : (blogGeneratedFiles as unknown as any[]);

export const blogSource = loader({
  baseUrl: '/blog',
  source: { files: blogFiles },
});
