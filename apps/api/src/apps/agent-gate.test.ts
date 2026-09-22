/**
 * Apps as an agent resource — the pure half of the App gate for an
 * agent-session credential (spec docs/specs/2026-09-22-agents-as-principals.md
 * §2.5): the decision table, the connector → App assertion, and header carriage.
 *
 * No module mocks: everything here is pure or HMAC.
 */
import { describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';

const {
  agentAppAccessDecision,
  createAppAgentAssertion,
  verifyAppAgentAssertion,
  APP_AGENT_ASSERTION_TTL_SECONDS,
} = await import('./access');
const { appUpstreamHeaders, appCredentialFromRequest, APP_AUTHORIZATION_HEADER } = await import('./public-proxy');

const APP_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_APP = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'test-app-access-secret';

const grant = (apps?: string[] | 'all') => ({
  agent: 'reporter',
  permissions: ['project.app.read'],
  connectors: [],
  ...(apps !== undefined ? { apps } : {}),
});

describe('§2.5 decision table for an agent-session credential', () => {
  const decide = (mode: string, apps: string[] | 'all' | undefined, appReadAllowed: boolean, slug = 'dashboards') =>
    agentAppAccessDecision({ mode: mode as never, slug, grant: grant(apps), appReadAllowed });

  test('public → always, even without project.app.read and without apps', () => {
    expect(decide('public', undefined, false)).toBe(true);
  });

  test('project → project.app.read effective; apps is not consulted', () => {
    expect(decide('project', undefined, true)).toBe(true);
    expect(decide('project', ['dashboards'], false)).toBe(false);
  });

  for (const mode of ['restricted', 'private']) {
    test(`${mode} → slug ∈ apps AND project.app.read`, () => {
      expect(decide(mode, ['dashboards'], true)).toBe(true);
      expect(decide(mode, 'all', true)).toBe(true);
      expect(decide(mode, ['dashboards'], false)).toBe(false);
      expect(decide(mode, ['other-app'], true)).toBe(false);
      expect(decide(mode, [], true)).toBe(false);
      expect(decide(mode, undefined, true)).toBe(false);
    });
  }

  test('password → never, whatever the grant says', () => {
    expect(decide('password', 'all', true)).toBe(false);
  });

  test('an unknown mode is refused', () => {
    expect(decide('something-new', 'all', true)).toBe(false);
  });
});

describe('connector → App assertion (short-lived, HMAC, App + project bound)', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const mint = (over: Partial<{ appId: string; projectId: string; tokenId: string; expiresAt: Date }> = {}) =>
    createAppAgentAssertion(
      {
        appId: APP_ID,
        projectId: PROJECT_ID,
        tokenId: TOKEN_ID,
        expiresAt: new Date(now.getTime() + 60_000),
        ...over,
      },
      SECRET,
    );

  test('the TTL is at most 60 s', () => {
    expect(APP_AGENT_ASSERTION_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  test('a fresh assertion verifies and names the session token', () => {
    expect(verifyAppAgentAssertion(mint(), { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toEqual({
      tokenId: TOKEN_ID,
    });
  });

  test('expired → null', () => {
    const later = new Date(now.getTime() + 61_000);
    expect(verifyAppAgentAssertion(mint(), { appId: APP_ID, projectId: PROJECT_ID }, SECRET, later)).toBeNull();
  });

  test('an expiry further out than the TTL is refused (no long-lived assertions)', () => {
    const long = mint({ expiresAt: new Date(now.getTime() + 10 * 60_000) });
    expect(verifyAppAgentAssertion(long, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
  });

  test('wrong App → null', () => {
    expect(verifyAppAgentAssertion(mint(), { appId: OTHER_APP, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
  });

  test('wrong project → null', () => {
    expect(verifyAppAgentAssertion(mint(), { appId: APP_ID, projectId: OTHER_PROJECT }, SECRET, now)).toBeNull();
  });

  test('forged: another secret, a tampered body, or a truncated MAC → null', () => {
    const forged = createAppAgentAssertion(
      { appId: APP_ID, projectId: PROJECT_ID, tokenId: TOKEN_ID, expiresAt: new Date(now.getTime() + 60_000) },
      'attacker-secret',
    );
    expect(verifyAppAgentAssertion(forged, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();

    const real = mint();
    const [prefix, body, mac] = real.split('.');
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), tokenId: 'someone-else' }),
    ).toString('base64url');
    expect(verifyAppAgentAssertion(`${prefix}.${tamperedBody}.${mac}`, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
    expect(verifyAppAgentAssertion(`${prefix}.${body}.${mac!.slice(0, 10)}`, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
    expect(verifyAppAgentAssertion('garbage', { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
  });

  test('an App access cookie token is not an assertion (distinct MAC domain)', async () => {
    const { createAppAccessToken } = await import('./access');
    const cookie = createAppAccessToken(
      { appId: APP_ID, kind: 'kortix', userId: TOKEN_ID, expiresAt: new Date(now.getTime() + 60_000) },
      SECRET,
    );
    expect(verifyAppAgentAssertion(cookie, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
    expect(verifyAppAgentAssertion(`kortix_app_assertion.${cookie}`, { appId: APP_ID, projectId: PROJECT_ID }, SECRET, now)).toBeNull();
  });
});

describe('header carriage', () => {
  const host = 'dev-dash-cccccccccccccccc.apps.kortix.com';

  test('the header name is X-Kortix-App-Authorization', () => {
    expect(APP_AUTHORIZATION_HEADER).toBe('x-kortix-app-authorization');
  });

  test('upstream never receives X-Kortix-App-Authorization; the App keeps its own Authorization', () => {
    const request = new Request(`https://${host}/api/things`, {
      headers: {
        authorization: 'Bearer app-own-write-key',
        'x-kortix-app-authorization': 'Bearer kortix_pat_session',
      },
    });
    const headers = appUpstreamHeaders(request, {}, host);
    expect(headers.get('x-kortix-app-authorization')).toBeNull();
    expect(headers.get('authorization')).toBe('Bearer app-own-write-key');
  });

  test('the Kortix credential is read from X-Kortix-App-Authorization first, then Authorization', () => {
    const both = new Request(`https://${host}/`, {
      headers: { authorization: 'Bearer app-own-write-key', 'x-kortix-app-authorization': 'Bearer kortix_pat_a' },
    });
    const on = { agentPrincipal: true };
    expect(appCredentialFromRequest(both, on)).toEqual([
      { token: 'kortix_pat_a', via: 'x-kortix-app-authorization' },
      { token: 'app-own-write-key', via: 'authorization' },
    ]);
    const onlyAuth = new Request(`https://${host}/`, { headers: { authorization: 'Bearer kortix_pat_b' } });
    expect(appCredentialFromRequest(onlyAuth, on)).toEqual([{ token: 'kortix_pat_b', via: 'authorization' }]);
    const basic = new Request(`https://${host}/`, { headers: { authorization: 'Basic abc' } });
    expect(appCredentialFromRequest(basic, on)).toEqual([]);
  });

  test('flag OFF: X-Kortix-App-Authorization is not read at all (today’s gate)', () => {
    const both = new Request(`https://${host}/`, {
      headers: { authorization: 'Bearer app-own-write-key', 'x-kortix-app-authorization': 'Bearer kortix_pat_a' },
    });
    expect(appCredentialFromRequest(both, { agentPrincipal: false })).toEqual([
      { token: 'app-own-write-key', via: 'authorization' },
    ]);
  });

  test('flag OFF: the header is still deleted upstream', () => {
    const request = new Request(`https://${host}/`, { headers: { 'x-kortix-app-authorization': 'Bearer x' } });
    expect(appUpstreamHeaders(request, {}, host).get('x-kortix-app-authorization')).toBeNull();
  });

  test('an unknown flag key (L2 not registered yet) reads as OFF', async () => {
    const { agentPrincipalEnabled } = await import('./access');
    expect(agentPrincipalEnabled({ experimental: { agent_principal: true } })).toBe(false);
    expect(agentPrincipalEnabled(null)).toBe(false);
  });
});
