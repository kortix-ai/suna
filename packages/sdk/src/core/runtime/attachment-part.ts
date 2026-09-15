import { authenticatedFetch } from '../http/auth';
import { getActiveOpenCodeUrl } from '../session/server-store/active';
import { platformConfig } from '../http/config';
import { parseSessionAttachmentReference } from './session-attachment-reference';

/**
 * The legacy daemon attachment prefix. Pi also uses session attachment paths.
 *
 * The transcript list no longer inlines file bytes: the daemon (and the API
 * proxy, for sandboxes on an older daemon) swaps every oversized `data:` url
 * in a file part for `/kortix/part/:sessionID/:messageID/:partID`, so a session
 * with hundreds of image reads lists in kilobytes instead of tens of megabytes.
 * Measured before the change (essentia, 2026-08-24): 20 messages = 7-19 MB,
 * reads dying on the 30 s fetch deadline, a retry re-issuing the whole thing.
 *
 * Visible rows fetch bytes with authentication. Legacy references use the
 * runtime URL. Session attachment paths use the API and work without a runtime.
 */
export const ATTACHMENT_PART_REF_PREFIX = '/kortix/part/';

export function isAttachmentPartRef(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith(ATTACHMENT_PART_REF_PREFIX) || parseSessionAttachmentReference(value) !== null);
}

/**
 * The bytes of one attachment part, as a Blob carrying the part's mime type.
 *
 * Legacy references require a bound runtime. Session references require only
 * the configured API. Throws when storage returns a non-success response.
 */
export async function fetchAttachmentPart(ref: string): Promise<Blob> {
  if (!isAttachmentPartRef(ref)) {
    throw new Error(`not an attachment part reference: ${ref}`);
  }
  const base = parseSessionAttachmentReference(ref)
    ? platformConfig().backendUrl.replace(/\/$/, '')
    : getActiveOpenCodeUrl();
  if (!base) throw new Error('runtime url not bound');
  const res = await authenticatedFetch(`${base}${ref}`);
  if (!res.ok) throw new Error(`attachment part fetch failed: ${res.status}`);
  return res.blob();
}
