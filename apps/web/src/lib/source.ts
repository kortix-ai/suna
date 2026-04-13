import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';

const generatedSource = docs.toFumadocsSource();

export const source = loader({
  baseUrl: '/docs',
  source: {
    files: generatedSource.files(),
  },
});
