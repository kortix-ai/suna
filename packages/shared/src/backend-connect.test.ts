import { describe, expect, test } from 'bun:test';
import { BACKEND_CONNECT_TABS, backendConnectSnippets } from './backend-connect';

const backend = {
  backend_id: '99999999-8888-4777-8666-555555555555',
  project_id: '11111111-2222-4333-8444-555555555555',
  name: 'crm',
  url: 'https://crm.backends.example.test',
  site_url: 'https://crm-site.backends.example.test',
  auth_env: {
    KORTIX_AUTH_ISSUER: 'https://kortix.example.test/backends/99999999-8888-4777-8666-555555555555',
    KORTIX_AUTH_AUDIENCE: '99999999-8888-4777-8666-555555555555',
    KORTIX_AUTH_JWKS: 'data:text/plain;charset=utf-8;base64,e30=',
  },
};

const code = (id: string, snippets = backendConnectSnippets(backend)) =>
  snippets.find((snippet) => snippet.id === id)?.code ?? '';

describe('backendConnectSnippets', () => {
  test('every tab has snippets and every id is unique', () => {
    const snippets = backendConnectSnippets(backend);
    for (const tab of BACKEND_CONNECT_TABS) expect(snippets.some((s) => s.tab === tab)).toBe(true);
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
  });

  test('the App wires the backend URL and the token fetcher by name', () => {
    expect(code('app-env')).toBe('VITE_CONVEX_URL=https://crm.backends.example.test');
    expect(code('app-client')).toContain('convex.setAuth(kortixAppBackendToken("crm"));');
  });

  test('outside callers send a bearer to /api/query, /api/mutation and the HTTP actions origin', () => {
    expect(code('outside-token-cli')).toBe('TOKEN=$(kortix backends token crm)');
    expect(code('outside-token-sdk')).toContain(
      'kortix.project("11111111-2222-4333-8444-555555555555").backends.token("99999999-8888-4777-8666-555555555555")',
    );
    expect(code('outside-query')).toContain('curl -s https://crm.backends.example.test/api/query');
    expect(code('outside-query')).toContain('"path":"members:me"');
    expect(code('outside-mutation')).toContain('https://crm.backends.example.test/api/mutation');
    expect(code('outside-http-action')).toBe(
      'curl -s https://crm-site.backends.example.test/hello -H "Authorization: Bearer $TOKEN"',
    );
    expect(code('outside-verify')).toContain('await verifyKortixMemberToken(bearer)');
    expect(code('outside-verify-env')).toBe(
      Object.entries(backend.auth_env).map(([k, v]) => `${k}=${v}`).join('\n'),
    );
  });

  test('admin is the CLI: deploy, env, Convex commands, dashboard; never a key', () => {
    const admin = code('admin-cli');
    expect(admin).toContain('kortix backends deploy crm --dir backends/crm');
    expect(admin).toContain('eval "$(kortix backends env crm)"');
    expect(admin).toContain('kortix backends dashboard crm --open');
    expect(JSON.stringify(backendConnectSnippets(backend))).not.toMatch(/ADMIN_KEY|admin_key/);
  });

  test('a backend without sign-in values has no environment snippet; a missing URL is a placeholder', () => {
    const snippets = backendConnectSnippets({ ...backend, url: null, site_url: null, auth_env: null });
    expect(snippets.some((s) => s.id === 'outside-verify-env')).toBe(false);
    expect(code('app-env', snippets)).toBe('VITE_CONVEX_URL=<url>');
  });
});
