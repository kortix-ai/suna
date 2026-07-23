import { PublicSessionShareError } from '@kortix/sdk/projects-client';

export interface ShareLoadError {
  status: number | null;
  message: string;
}

/**
 * Normalize whatever `getPublicSessionShare`/`getPublicSessionShareMessages`
 * reject with into a status + message pair the UI can branch on.
 * `PublicSessionShareError` carries the real HTTP status from
 * `GET /v1/public/session-shares/:shareId` (404/410/503); anything else
 * (network failure, unexpected throw) has no status to key off of.
 */
export function toShareLoadError(err: unknown): ShareLoadError {
  if (err instanceof PublicSessionShareError) {
    return { status: err.status, message: err.message };
  }
  return { status: null, message: err instanceof Error ? err.message : 'Failed to load share' };
}

/**
 * Map a load error to display copy. 404/410/503 mirror the exact semantics
 * `resolvePublicShare` (apps/api/src/shared/session-public-shares.ts) already
 * documents for every other public-share surface: unknown token, revoked or
 * expired token, and a session whose sandbox hasn't been provisioned yet.
 */
export function describeShareError(error: ShareLoadError | null): { title: string; description: string } {
  if (error?.status === 404) {
    return {
      title: 'Share Not Found',
      description: 'This shared session does not exist or has been removed.',
    };
  }
  if (error?.status === 410) {
    return {
      title: 'Share Link Expired',
      description: 'This share link has been revoked or has expired.',
    };
  }
  if (error?.status === 503) {
    return {
      title: 'Session Not Ready',
      description: "This session's sandbox hasn't started yet. Try again in a moment.",
    };
  }
  return {
    title: 'Error Loading Share',
    description: error?.message || 'The session data could not be loaded.',
  };
}

/** Copy for a transient in-band transcript failure (still a 200 — see
 *  `PublicSessionTranscript.available`), e.g. Runtime not ready yet. */
export function transcriptUnavailableMessage(reason: string | null): string {
  return reason ? `Conversation temporarily unavailable — ${reason}.` : 'Conversation temporarily unavailable.';
}
