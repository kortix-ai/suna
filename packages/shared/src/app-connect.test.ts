import { describe, expect, test } from 'bun:test';
import { APP_CONNECT_TABS, appConnectSnippets } from './app-connect';

const issuer = 'https://api.example.test/v1/projects/11111111-2222-4333-8444-555555555555';
const app = {
  app_id: '99999999-8888-4777-8666-555555555555',
  project_id: '11111111-2222-4333-8444-555555555555',
  slug: 'crm',
  url: 'https://crm.apps.example.test',
  capabilities: ['deployments', 'member_tokens'],
  auth: { issuer, audience: '99999999-8888-4777-8666-555555555555', jwks_uri: `${issuer}/jwks.json` },
};

const code = (id: string, snippets = appConnectSnippets(app)) =>
  snippets.find((snippet) => snippet.id === id)?.code ?? '';

describe('appConnectSnippets', () => {
  test('every tab has snippets and every id is unique', () => {
    const snippets = appConnectSnippets(app);
    for (const tab of APP_CONNECT_TABS) expect(snippets.some((s) => s.tab === tab)).toBe(true);
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
  });

  test('another App links this one first, then calls it through its binding', () => {
    const ids = appConnectSnippets(app).filter((s) => s.tab === 'app').map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(['app-uses', 'app-client']);
    expect(code('app-uses')).toBe('kortix apps link <app> --uses crm\n# or in kortix.yaml: apps.<app>.uses: [crm]');
    expect(code('app-client')).toContain('const crm = kortixBinding("crm");');
    expect(code('app-client')).toContain('await crm.token()');
  });

  test('this App verifies the bearer token with verifyKortixToken', () => {
    expect(code('server-verify')).toContain('await verifyKortixToken(bearer)');
  });

  test('outside callers send a bearer to the App URL', () => {
    expect(code('outside-token-cli')).toBe('TOKEN=$(kortix apps token crm)');
    expect(code('outside-token-sdk')).toContain(
      'kortix.project("11111111-2222-4333-8444-555555555555").apps.token("99999999-8888-4777-8666-555555555555")',
    );
    expect(code('outside-request')).toBe('curl -s https://crm.apps.example.test/ -H "Authorization: Bearer $TOKEN"');
    expect(code('outside-verify')).toContain('await verifyKortixToken(bearer)');
  });

  test("a server's environment is the App's auth values: issuer, audience, key set URL", () => {
    expect(code('outside-verify-env')).toBe(
      `KORTIX_AUTH_ISSUER=${issuer}\nKORTIX_AUTH_AUDIENCE=${app.app_id}\nKORTIX_AUTH_JWKS=${issuer}/jwks.json`,
    );
  });

  test('no member_tokens capability, no outside tab', () => {
    const plain = appConnectSnippets({ ...app, capabilities: ['deployments'] });
    expect(plain.some((s) => s.tab === 'outside')).toBe(false);
  });

  test('an App with no URL yet, or an older server: placeholders, no environment snippet', () => {
    const snippets = appConnectSnippets({ ...app, url: null, auth: undefined });
    expect(snippets.some((s) => s.id === 'outside-verify-env')).toBe(false);
    expect(code('outside-request', snippets)).toContain('curl -s <url>/ ');
  });

  test('no snippet names a retired kind or an admin key', () => {
    expect(JSON.stringify(appConnectSnippets(app))).not.toMatch(/convex|admin_key|ADMIN_KEY/i);
  });
});
