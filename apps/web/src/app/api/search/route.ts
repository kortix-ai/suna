import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '@/lib/source';

/**
 * The docs search index, served once as a static file.
 *
 * `GET` (the dynamic handler) ran a query on the SERVER for every keystroke:
 * open the dialog, type eight characters, and that is eight round-trips, each
 * one waiting on a debounce first. On a 31-page site the whole index is
 * smaller than a single screenshot — shipping it once and querying it in the
 * browser is both less work and an order of magnitude less waiting. That is
 * what `staticGET` is for: it exports the index instead of answering queries,
 * and the dialog's `type: 'static'` client (see `docs/layout.tsx`) fetches it
 * one time and searches locally from then on.
 *
 * `revalidate = false` lets Next treat the response as immutable and serve it
 * from the static cache; the index only changes when the docs are rebuilt,
 * which rebuilds this route with them.
 */
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
