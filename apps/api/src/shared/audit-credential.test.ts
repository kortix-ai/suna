import { describe, expect, test } from 'bun:test';
import { credentialFromContext } from './audit-credential';

const from = (vars: Record<string, unknown>) => credentialFromContext((key) => vars[key]);

describe('credentialFromContext', () => {
  test('classifies each credential class the auth middleware can tell apart', () => {
    expect(from({ authType: 'supabase', sessionId: 'jwt-session' })).toEqual({
      credentialKind: 'browser_session',
      credentialId: 'jwt-session',
    });
    expect(from({ authType: 'pat', iamTokenId: 'tok-1' })).toEqual({
      credentialKind: 'personal_access_token',
      credentialId: 'tok-1',
    });
    expect(from({ authType: 'pat', iamTokenId: 'tok-2', sandboxId: 'sbx-1', sessionId: 'sbx-1' })).toEqual({
      credentialKind: 'session_token',
      credentialId: 'sbx-1',
    });
    expect(from({ authType: 'oauth', oauthClientId: 'client-1' })).toEqual({
      credentialKind: 'oauth_app',
      credentialId: 'client-1',
    });
    expect(from({ authType: 'service_account', iamTokenId: 'sa-1' })).toEqual({
      credentialKind: 'service_account',
      credentialId: 'sa-1',
    });
    expect(from({ authType: 'apiKey', apiKeyType: 'secret', keyId: 'key-1' })).toEqual({
      credentialKind: 'api_key',
      credentialId: 'key-1',
    });
    expect(from({ authType: 'apiKey', apiKeyType: 'sandbox', keyId: 'key-2', sandboxId: 'sbx-2' })).toEqual({
      credentialKind: 'session_token',
      credentialId: 'sbx-2',
    });
  });

  test('returns nothing for an unauthenticated request', () => {
    expect(from({})).toEqual({});
  });

  test('ignores any client-supplied header value', () => {
    expect(from({ authType: 'pat', iamTokenId: 'tok-1', 'x-kortix-client': 'web' })).toEqual({
      credentialKind: 'personal_access_token',
      credentialId: 'tok-1',
    });
  });
});
