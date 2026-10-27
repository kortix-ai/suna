import 'server-only';

import { type PublicArtifact, getPublicArtifact } from '@kortix/sdk';
import { cache } from 'react';

import { getEnv } from '@/lib/env-config';

export type PublicArtifactResult =
  | { kind: 'shared'; artifact: PublicArtifact }
  /** Unknown, deleted, or no longer public (404). */
  | { kind: 'missing' }
  /** The API is rate-limiting (429) or failing (5xx). */
  | { kind: 'busy' };

/**
 * Read a public artifact on the server, once per request (the page and
 * `generateMetadata` share it). No fetch cache: turning a link private must
 * take effect on the next view.
 */
export const loadPublicArtifact = cache(async (id: string): Promise<PublicArtifactResult> => {
  try {
    return { kind: 'shared', artifact: await getPublicArtifact(id, { backendUrl: getEnv().BACKEND_URL, cache: 'no-store' }) };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404 || status === 400) return { kind: 'missing' };
    if (status === 429 || (typeof status === 'number' && status >= 500)) return { kind: 'busy' };
    throw error;
  }
});
