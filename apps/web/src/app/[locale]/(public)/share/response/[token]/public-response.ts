import 'server-only';

import { type PublicResponse, getPublicResponse } from '@kortix/sdk';
import { cache } from 'react';

import { getEnv } from '@/lib/env-config';

export type PublicResponseResult =
  | { kind: 'shared'; response: PublicResponse }
  /** The token never existed: the route's not-found page. */
  | { kind: 'missing' }
  /** The sharer turned the link off (410). */
  | { kind: 'revoked' };

/**
 * Read a shared response on the server, once per request: the page,
 * `generateMetadata` and the OG image all call this with the same token.
 *
 * The backend URL is passed explicitly: the web app configures the global SDK
 * client in the browser only (`lib/kortix-config.ts`).
 */
export const loadPublicResponse = cache(async (token: string): Promise<PublicResponseResult> => {
  try {
    const response = await getPublicResponse(token, {
      backendUrl: getEnv().BACKEND_URL,
      // Never from the server's fetch cache: "Stop sharing" must take effect
      // on the next load, not after a revalidate window.
      cache: 'no-store',
    });
    return { kind: 'shared', response };
  } catch (error) {
    // `HostBoundaryError.status`: 404 unknown link, 410 revoked.
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404) return { kind: 'missing' };
    if (status === 410) return { kind: 'revoked' };
    throw error;
  }
});

/** The first ~160 characters of the response as plain text, for a link preview. */
export function plainTextExcerpt(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
