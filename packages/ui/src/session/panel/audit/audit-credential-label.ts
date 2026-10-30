// "Via": what the API authenticated for an audit event. Never a client label:
// the API knows the credential, not which app the caller says it is.

/** `hardcodedUi.i18nComplete` keys (`text` + first 12 hex of the string's SHA-256). */
export const CREDENTIAL_LABEL_KEYS = {
  browser_session: 'textd31de1a5c5c8', // Browser
  personal_access_token: 'texta6d0f740e426', // Personal access token
  oauth_app: 'text2bbd1ec2197d', // Connected app
  session_token: 'textda3d3fb8f598', // Agent session
  api_key: 'text16f0ee47f993', // API key
  service_account: 'textce5e9df4a78f', // Service account
  scim_token: 'text4dcb7e3b10a9', // SCIM token
} as const;

export type CredentialKind = keyof typeof CREDENTIAL_LABEL_KEYS;

/** Filter options, in display order. */
export const CREDENTIAL_KINDS = Object.keys(CREDENTIAL_LABEL_KEYS) as CredentialKind[];

interface EventCredential {
  credential_kind?: string | null;
  credential_name?: string | null;
}

/** "Personal access token · ci-deploy", "Browser", or null for a row with no known credential. */
export function credentialVia(
  event: EventCredential,
  label: (key: string) => string,
): string | null {
  const key = CREDENTIAL_LABEL_KEYS[event.credential_kind as CredentialKind];
  if (!key) return null;
  const kind = label(key);
  return event.credential_name ? `${kind} · ${event.credential_name}` : kind;
}
