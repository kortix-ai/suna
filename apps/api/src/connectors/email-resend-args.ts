/**
 * Shape the Email channel's provider-bound arguments for Resend.
 *
 * The attachment claim hands each file over as a signed `url`. A reply takes a
 * URL as `path`, but a draft (`send_message`) takes only inline `content`, so
 * for a draft each file is fetched and base64-encoded here, within Resend's
 * 25 MB limit.
 */
import { config } from '../config';
import { safeEgressFetch } from '../shared/ssrf-guard';

type Fetch = (url: string) => Promise<Response>;

/**
 * Read one attachment. Kortix's own storage (the signed URL the claim minted)
 * is fetched directly; any other URL a caller supplied goes through the
 * egress guard, so a draft cannot be used to read an internal address.
 */
export const fetchAttachmentBytes: Fetch = (url) => {
  const own = [config.SUPABASE_PUBLIC_URL, config.SUPABASE_URL]
    .filter((origin): origin is string => Boolean(origin))
    .some((origin) => url.startsWith(origin.replace(/\/+$/, '') + '/'));
  return own ? fetch(url) : safeEgressFetch(url);
};

/** Resend's limit on a draft's attachment bytes. */
export const RESEND_DRAFT_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;

export async function toResendEmailArgs(
  actionPath: string,
  args: Record<string, unknown>,
  fetchImpl: Fetch = fetchAttachmentBytes,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(args.attachments)) return args;
  const inline = actionPath === 'send_message';
  let total = 0;
  const attachments = [];
  for (const [index, item] of args.attachments.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`attachments[${index}] is invalid`);
    const { url, content_disposition: _disposition, attachment_id: _id, ...rest } = item as Record<string, unknown>;
    if (typeof url !== 'string' || !url) {
      attachments.push(rest);
      continue;
    }
    if (!inline) {
      attachments.push({ ...rest, path: url });
      continue;
    }
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`attachments[${index}] could not be read (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    total += bytes.byteLength;
    if (total > RESEND_DRAFT_ATTACHMENT_LIMIT_BYTES) {
      throw new Error('attachments exceed 25 MB, the most one email can carry');
    }
    // A draft takes no content id: Resend refuses `content_id` there.
    const { content_id: _cid, ...draftFields } = rest;
    attachments.push({ ...draftFields, content: bytes.toString('base64') });
  }
  return { ...args, attachments };
}

/** The draft id a `send_message` create answered, or null. */
export function createdDraftId(data: unknown): string | null {
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
}
