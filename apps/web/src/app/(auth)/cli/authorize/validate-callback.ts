/**
 * The CLI's one-shot callback server must be local: `kortix login` listens on
 * `http://127.0.0.1:<port>/callback` (or `localhost`). Anything else — other
 * protocols, other hosts — is refused before the page offers to mint a token.
 */

export interface CallbackValidation {
  ok: boolean;
  reason: string;
  display: string;
}

export function validateCallback(raw: string | null): CallbackValidation {
  if (!raw) return { ok: false, reason: 'No callback URL provided.', display: '' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Callback is not a valid URL.', display: '' };
  }
  if (url.protocol !== 'http:') {
    return {
      ok: false,
      reason: 'Callback must use http:// — refusing other protocols.',
      display: url.origin,
    };
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return {
      ok: false,
      reason: 'Callback must be a localhost address.',
      display: url.origin,
    };
  }
  return { ok: true, reason: '', display: `${url.hostname}:${url.port}` };
}
