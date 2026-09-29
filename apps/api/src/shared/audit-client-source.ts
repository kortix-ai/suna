const CLIENT_SOURCE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CREDENTIAL_SOURCE_RE = /^(?:sk-|gh[opusr]_|kortix_(?:pat|sbx)_)/i;

const CLIENT_VERSION_RE = /^[0-9a-z][0-9a-z.+-]{0,63}$/i;

/** `X-Kortix-Client-Version` as sent, or null when it is not a plausible version string. */
export function normalizeClientVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!CLIENT_VERSION_RE.test(trimmed) || CREDENTIAL_SOURCE_RE.test(trimmed)) return null;
  return trimmed;
}

export function normalizeAuditClientSource(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!CLIENT_SOURCE_RE.test(normalized) || CREDENTIAL_SOURCE_RE.test(normalized)) return null;
  return normalized;
}
