import { describe, expect, test } from 'bun:test';
import { APP_CONNECT_TABS, appConnectSnippets } from './app-connect';

const issuer = 'https://api.example.test/v1/projects/11111111-2222-4333-8444-555555555555';
const app = {
  app_id: '99999999-8888-4777-8666-555555555555',
  project_id: '11111111-2222-4333-8444-555555555555',
  slug: 'crm',
  url: 'https://crm.apps.example.test',
  capabilities: ['deployments', 'snapshots', 'admin_credentials', 'dashboard', 'member_tokens'],
  auth: { issuer, audience: '99999999-8888-4777-8666-555555555555', jwks_uri: `${issuer}/jwks.json` },
  instance: { site_url: 'https://crm-site.apps.example.test' },
};

const code = (id: string, snippets = appConnectSnippets(app)) =>
  snippets.find((snippet) => snippet.id === id)?.code ?? '';

describe('appConnectSnippets', () => {
  test('every tab has snippets and every id is unique', () => {
    const snippets = appConnectSnippets(app);
    for (const tab of APP_CONNECT_TABS) expect(snippets.some((s) => s.tab === tab)).toBe(true);
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
  });

  test('another App links this one first, then binds to it on its own origin', () => {
    const ids = appConnectSnippets(app).filter((s) => s.tab === 'app').map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(['app-install', 'app-uses']);
    expect(code('app-uses')).toBe('kortix apps link <app> --uses crm\n# or in kortix.yaml: apps.<app>.uses: [crm]');
    expect(code('app-client')).toContain('const crm = kortixBinding("crm");');
    expect(code('app-client')).toContain('new ConvexReactClient(crm.url)');
    expect(code('app-client')).toContain('convex.setAuth(crm.token);');
  });

  test('the server accepts tokens from the project issuer for this App', () => {
    expect(code('server-auth-config')).toContain('issuer: process.env.KORTIX_AUTH_ISSUER!');
    expect(code('server-function')).toContain('requireKortixMember(await ctx.auth.getUserIdentity())');
  });

  test('outside callers send a bearer to /api/query, /api/mutation and the HTTP actions origin', () => {
    expect(code('outside-token-cli')).toBe('TOKEN=$(kortix apps token crm)');
    expect(code('outside-token-sdk')).toContain(
      'kortix.project("11111111-2222-4333-8444-555555555555").apps.token("99999999-8888-4777-8666-555555555555")',
    );
    expect(code('outside-query')).toContain('curl -s https://crm.apps.example.test/api/query');
    expect(code('outside-query')).toContain('"path":"members:me"');
    expect(code('outside-mutation')).toContain('https://crm.apps.example.test/api/mutation');
    expect(code('outside-http-action')).toBe('curl -s https://crm-site.apps.example.test/hello -H "Authorization: Bearer $TOKEN"');
    expect(code('outside-verify')).toContain('await verifyKortixToken(bearer)');
  });

  test("a server's environment is the App's auth values: issuer, audience, key set URL", () => {
    expect(code('outside-verify-env')).toBe(
      `KORTIX_AUTH_ISSUER=${issuer}\nKORTIX_AUTH_AUDIENCE=${app.app_id}\nKORTIX_AUTH_JWKS=${issuer}/jwks.json`,
    );
  });

  test('admin is the CLI: deploy, credentials, client CLI commands, dashboard; never a key', () => {
    const admin = code('admin-cli');
    expect(admin).toContain('kortix apps deploy <dir> --app crm');
    expect(admin).toContain('eval "$(kortix apps credentials crm)"');
    expect(admin).toContain('kortix apps dashboard crm --open');
    expect(JSON.stringify(appConnectSnippets(app))).not.toMatch(/ADMIN_KEY|admin_key/);
  });

  test('capabilities decide the tabs: no admin credentials, no admin tab; no member tokens, no outside tab', () => {
    const plain = appConnectSnippets({ ...app, capabilities: ['deployments', 'snapshots'] });
    expect(plain.some((s) => s.tab === 'admin' || s.tab === 'outside')).toBe(false);
  });

  test('an App that does not run yet, or an older server: placeholders, no environment snippet', () => {
    const snippets = appConnectSnippets({ ...app, url: null, auth: undefined, instance: null });
    expect(snippets.some((s) => s.id === 'outside-verify-env')).toBe(false);
    expect(code('outside-query', snippets)).toContain('curl -s <url>/api/query');
    expect(code('outside-http-action', snippets)).toContain('<site_url>/hello');
  });
});
