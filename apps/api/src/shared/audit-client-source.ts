const CLIENT_SOURCE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CREDENTIAL_SOURCE_RE = /^(?:sk-|gh[opusr]_|kortix_(?:pat|sbx)_)/i;

export function normalizeAuditClientSource(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!CLIENT_SOURCE_RE.test(normalized) || CREDENTIAL_SOURCE_RE.test(normalized)) return null;
  return normalized;
}
