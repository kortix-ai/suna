import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CREDENTIAL_LABEL_KEYS, credentialVia } from './audit-credential-label';

const key = (text: string) => `text${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const label = (k: string) => k;

describe('credentialVia', () => {
  test('keys are the SHA-256 keys of the English labels', () => {
    expect(CREDENTIAL_LABEL_KEYS).toEqual({
      browser_session: key('Browser'),
      personal_access_token: key('Personal access token'),
      oauth_app: key('Connected app'),
      session_token: key('Agent session'),
      api_key: key('API key'),
      service_account: key('Service account'),
      scim_token: key('SCIM token'),
    });
  });

  test('appends the credential name when known', () => {
    expect(
      credentialVia({ credential_kind: 'oauth_app', credential_name: 'Claude Code' }, label),
    ).toBe(`${key('Connected app')} · Claude Code`);
    expect(credentialVia({ credential_kind: 'browser_session' }, label)).toBe(key('Browser'));
  });

  test('a row with no credential, or an unknown one, has no Via', () => {
    expect(credentialVia({ credential_kind: null }, label)).toBeNull();
    expect(credentialVia({ credential_kind: 'made_up' }, label)).toBeNull();
    expect(credentialVia({}, label)).toBeNull();
  });
});
