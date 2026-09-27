/**
 * The toast for a failed public-link create (KRTX-248). The API explains a
 * refusal in a sentence (403 "Sessions using a personal connection cannot be
 * shared publicly"); the SDK puts it in the error's `message`. Show that
 * sentence for a 4xx refusal. A 401 (the login monitor handles it), a 5xx, a
 * network failure, or a bare "HTTP 404: Not Found" line gets the fallback.
 */
export const PUBLIC_LINK_FALLBACK_ERROR = 'Unable to create the link. Try again.';

export function publicLinkErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return PUBLIC_LINK_FALLBACK_ERROR;
  const status = (error as { status?: unknown }).status;
  const message = error.message.trim();
  const isRefusal = typeof status === 'number' && status >= 400 && status < 500 && status !== 401;
  if (!isRefusal || !message || /^HTTP \d{3}\b/.test(message)) return PUBLIC_LINK_FALLBACK_ERROR;
  return message;
}
