import { authenticatedFetch } from '../http/auth';
import { getActiveOpenCodeUrl } from '../session/server-store/active';

/**
 * An attachment whose BYTES live behind the sandbox daemon's part endpoint.
 *
 * The transcript list no longer inlines file bytes: the daemon (and the API
 * proxy, for sandboxes on an older daemon) swaps every oversized `data:` url
 * in a file part for `/kortix/part/:sessionID/:messageID/:partID`, so a session
 * with hundreds of image reads lists in kilobytes instead of tens of megabytes.
 * Measured before the change (essentia, 2026-08-24): 20 messages = 7-19 MB,
 * reads dying on the 30 s fetch deadline, a retry re-issuing the whole thing.
 *
 * The bytes are fetched here, per part, when a row is on screen — through the
 * same authenticated runtime fetch every other sandbox read uses, against the
 * same runtime base. The endpoint answers `immutable` with a strong ETag, so
 * the browser asks once per part, ever.
 */
export const ATTACHMENT_PART_REF_PREFIX = '/kortix/part/';

export function isAttachmentPartRef(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ATTACHMENT_PART_REF_PREFIX);
}

/**
 * The bytes of one attachment part, as a Blob carrying the part's mime type.
 *
 * Throws when no runtime is bound yet (the caller shows its loading state and
 * retries on the next render, the way every sandbox read does) or when the
 * daemon answers anything but 200.
 */
export async function fetchAttachmentPart(ref: string): Promise<Blob> {
  if (!isAttachmentPartRef(ref)) {
    throw new Error(`not an attachment part reference: ${ref}`);
  }
  const base = getActiveOpenCodeUrl();
  if (!base) throw new Error('runtime url not bound');
  const res = await authenticatedFetch(`${base}${ref}`);
  if (!res.ok) throw new Error(`attachment part fetch failed: ${res.status}`);
  return res.blob();
}
