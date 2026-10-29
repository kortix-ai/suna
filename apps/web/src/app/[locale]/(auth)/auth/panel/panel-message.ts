import { EXTENSION_ORIGIN } from '@/lib/supabase/panel-cookies';

/** Sent to the extension when the panel has no session. */
export const NEED_SESSION_MESSAGE = { type: 'kortix.panel.needSession' } as const;

/**
 * The one-time token hash the extension sends back, or null for any other
 * message. Only the framing extension page counts: a message from another
 * origin or window is ignored.
 */
export function readPanelSessionMessage(
  event: { origin: string; source: unknown; data: unknown },
  parent: unknown,
): string | null {
  if (event.origin !== EXTENSION_ORIGIN || event.source !== parent) return null;
  const data = event.data as { type?: unknown; tokenHash?: unknown } | null;
  if (!data || data.type !== 'kortix.panel.session') return null;
  return typeof data.tokenHash === 'string' && data.tokenHash ? data.tokenHash : null;
}
