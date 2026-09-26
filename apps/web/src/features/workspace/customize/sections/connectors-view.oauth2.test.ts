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
    // No connector-level authorization strategy gates this any more (a
    // custom connector's draft carries no owner choice) — the OAuth2-at-
    // creation offer is plain `oauth2Selected` state.
    expect(connectorsSource).toContain('oauth2Selected={oauth2Selected}');
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

  test('the credential dialog offers OAuth 2.0 only when the server requires it', () => {
    // The tab strip is gated on discovery (`oauth2CredentialOffered`) — an
    // API-key connector must open on its one real credential form, not a
    // selector that includes a grant flow its server does not speak.
    expect(connectorsSource).toContain('oauth2CredentialOffered(plan)');
    expect(connectorsSource).toContain('{showOAuth2Tabs ? (');
    // …and the hidden tab keeps a manual way in for servers that demand OAuth
    // without advertising it.
    expect(connectorsSource).toContain("tI18nHardcoded.raw('i18nComplete.textdee89ced3d79')");
    expect(connectorsSource).toContain('setOauth2Requested(true)');
  });

  test('a flaky discovery never silently costs an MCP connector its Connect button', () => {
    // The probe walks the server's whole metadata chain; `retry: false` meant
    // one transient failure anywhere in it left the dialog on a bare token
    // field with no trace of the one-click OAuth path — "sometimes there is
    // no Connect button" (Jay, 2026-09-15).
    const discoveryStart = connectorsSource.indexOf('connectorOAuth2Discovery');
    const discoveryEnd = connectorsSource.indexOf('const discovery =', discoveryStart);
    expect(discoveryStart).toBeGreaterThan(-1);
    expect(discoveryEnd).toBeGreaterThan(discoveryStart);
    const discoveryQuery = connectorsSource.slice(discoveryStart, discoveryEnd);
    expect(discoveryQuery).toContain('retry: 1,');
    expect(discoveryQuery).not.toContain('retry: false');
    // And while the strip is absent on an MCP connector, the static tab says
    // WHY: still checking (probe in flight) or failed, with the retry that
    // brings the option back. Other providers keep only the escape hatch —
    // for an API key, "no OAuth" is the designed answer, not a failure.
    expect(connectorsSource).toContain("connector?.provider === 'mcp' && discoveryPending ? (");
    expect(connectorsSource).toContain("connector?.provider === 'mcp' && discoveryError ? (");
    expect(connectorsSource).toContain('void discoveryQuery.refetch()');
  });

  test('does not contain provider-specific OAuth examples', () => {
    expect(fieldsSource).not.toContain('microsoftonline.com');
    expect(fieldsSource).not.toContain('graph.microsoft.com');
    expect(fieldsSource).not.toContain('sharepoint.com');
  });
});
