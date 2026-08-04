import { useCases } from '@/.source';
import { loader } from 'fumadocs-core/source';

export const useCasesSource = loader({
  baseUrl: '/use-cases',
  source: useCases.toFumadocsSource(),
});
