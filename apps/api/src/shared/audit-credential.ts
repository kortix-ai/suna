/**
 * What the API authenticated for this request: the credential class and its
 * identifier, derived from the auth middleware's context variables. Never
 * from a request header, and never the secret itself. A LEAF module (no
 * imports) so authenticators and the audit writer can both use it.
 */
export type AuditCredentialKind =
  | 'browser_session'
  | 'personal_access_token'
  | 'oauth_app'
  | 'session_token'
  | 'api_key'
  | 'service_account'
  | 'scim_token';

export interface AuditCredential {
  credentialKind?: AuditCredentialKind;
  credentialId?: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function credentialFromContext(get: (key: string) => unknown): AuditCredential {
  switch (get('authType')) {
    case 'supabase':
      return { credentialKind: 'browser_session', credentialId: str(get('sessionId')) };
    case 'pat':
      // A PAT minted for one agent session is bound to it (patPrincipal sets sandboxId).
      return get('sandboxId')
        ? { credentialKind: 'session_token', credentialId: str(get('sandboxId')) }
        : { credentialKind: 'personal_access_token', credentialId: str(get('iamTokenId')) };
    case 'oauth':
      return { credentialKind: 'oauth_app', credentialId: str(get('oauthClientId')) };
    case 'service_account':
      return { credentialKind: 'service_account', credentialId: str(get('iamTokenId')) };
    case 'apiKey':
      return get('apiKeyType') === 'sandbox'
        ? { credentialKind: 'session_token', credentialId: str(get('sandboxId')) }
        : { credentialKind: 'api_key', credentialId: str(get('keyId')) };
    default:
      return {};
  }
}
