import { useCases } from '@/.source';
import { loader } from 'fumadocs-core/source';

// fumadocs-mdx@11.x returns `Source.files` as a function; fumadocs-core@15.x
// expects an array. Invoke it here to bridge the version mismatch (mirrors the
// same workaround in src/lib/blog-source.ts for the blog collection).
const generatedSource = useCases.toFumadocsSource();
const generatedFiles = generatedSource.files;
const files =
  typeof generatedFiles === 'function'
    ? (generatedFiles as unknown as () => any[])()
    : (generatedFiles as unknown as any[]);

export const useCasesSource = loader({
  baseUrl: '/use-cases',
  source: { files },
});
