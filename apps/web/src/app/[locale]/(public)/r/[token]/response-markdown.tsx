'use client';

import { UnifiedMarkdown } from '@kortix/ui/markdown';

/**
 * The shared response, through the transcript's markdown renderer.
 *
 * `untrusted`: an anonymous reader on a kortix.com URL gets no setup-link cards
 * (they would turn an agent's text into a credential form on our origin) and
 * no remote image loads until they click (a tracking pixel would read their IP).
 */
export function ResponseMarkdown({ markdown }: { markdown: string }) {
  return <UnifiedMarkdown content={markdown} trust="untrusted" />;
}
