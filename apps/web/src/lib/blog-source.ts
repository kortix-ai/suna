import { blog } from '@/.source';
import { loader } from 'fumadocs-core/source';

// fumadocs-mdx@11.x returns `Source.files` as a function; fumadocs-core@15.x
// expects an array. Invoke it here to bridge the version mismatch (mirrors the
// same workaround in src/lib/source.ts for the docs collection).
const generatedSource = blog.toFumadocsSource();
const generatedFiles = generatedSource.files;
const files =
  typeof generatedFiles === 'function'
    ? (generatedFiles as unknown as () => any[])()
    : (generatedFiles as unknown as any[]);

export const blogSource = loader({
  baseUrl: '/blog',
  source: { files },
});
