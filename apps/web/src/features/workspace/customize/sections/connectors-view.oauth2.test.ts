import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const connectorsSource = readFileSync(join(dir, 'connectors-view.tsx'), 'utf8');
const fieldsSource = readFileSync(join(dir, 'connector-oauth2-fields.tsx'), 'utf8');

describe('Custom connector OAuth2 onboarding', () => {
  test('shows OAuth 2.0 in the initial Auth selector', () => {
    expect(connectorsSource).toContain('<SelectItem value="oauth2_client_credentials">');
    expect(connectorsSource).toContain('OAuth 2.0');
  });

  test('renders the OAuth2 credential fields before connector creation', () => {
    expect(connectorsSource).toContain('oauth2Selected={sharedOAuth2Selected}');
    expect(connectorsSource).toContain('idPrefix="new-connector-oauth2"');
    expect(connectorsSource).toContain('createConnectorWithOptionalOAuth2(');
  });

  test('covers every supported token endpoint authentication strategy', () => {
    expect(fieldsSource).toContain('value="none"');
    expect(fieldsSource).toContain('value="client_secret_post"');
    expect(fieldsSource).toContain('value="client_secret_basic"');
    expect(fieldsSource).toContain('value="client_secret_jwt"');
    expect(fieldsSource).toContain('value="private_key_jwt"');
  });

  test('covers the supported OAuth 2.0 grants', () => {
    expect(connectorsSource).toContain('value="client_credentials"');
    expect(connectorsSource).toContain('value="authorization_code"');
    expect(connectorsSource).toContain('value="device_authorization"');
  });

  test('offers every supported request authentication strategy', () => {
    for (const strategy of [
      'none',
      'bearer',
      'basic',
      'api_key',
      'oauth1',
      'hmac',
      'aws_sigv4',
      'mtls',
      'custom',
    ]) {
      expect(connectorsSource).toContain(`<SelectItem value="${strategy}">`);
    }
  });

  test('does not contain provider-specific OAuth examples', () => {
    expect(fieldsSource).not.toContain('microsoftonline.com');
    expect(fieldsSource).not.toContain('graph.microsoft.com');
    expect(fieldsSource).not.toContain('sharepoint.com');
  });
});
