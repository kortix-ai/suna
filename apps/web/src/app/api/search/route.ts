import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Powers the fumadocs search dialog (RootProvider defaults to fetching
// `/api/search`). Orama index is built from the docs source at request time.
export const { GET } = createFromSource(source);
