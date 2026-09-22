/**
 * Which connector base URLs get a Kortix App assertion (spec 2026-09-22 §2.5):
 * only an App host of THIS deployment, only in the caller's own project.
 * A foreign host never receives one — it would hand a stranger a credential.
 */
import { describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';

const { appAuthorizationForConnectorCall } = await import('./connector-assertion');
const { verifyAppAgentAssertion } = await import('./access');

const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a0000000-0000-4000-8000-000000000001';
const ROUTE_KEY = 'cccccccccccccccc';
const HOST = `https://dev-dashboards-${ROUTE_KEY}.apps.kortix.com`;

const loader = (projectId: string | null, agentPrincipal = true) => {
  const seen: string[] = [];
  const load = async (routeKey: string) => {
    seen.push(routeKey);
    return projectId ? { appId: APP_ID, projectId, agentPrincipal } : null;
  };
  return { load, seen };
};

const call = (baseUrl: string, load: (k: string) => Promise<{ appId: string; projectId: string; agentPrincipal: boolean } | null>, localMode = false) =>
  appAuthorizationForConnectorCall({ projectId: PROJECT, baseUrl, sessionId: 'sess', tokenId: TOKEN }, { loadAppByRouteKey: load, localMode });

describe('appAuthorizationForConnectorCall', () => {
  test('an App of this deployment in the same project → Bearer <assertion> that the gate verifies', async () => {
    const { load, seen } = loader(PROJECT);
    const value = await call(`${HOST}/api`, load);
    expect(seen).toEqual([ROUTE_KEY]);
    expect(value?.startsWith('Bearer kortix_app_assertion.')).toBe(true);
    expect(verifyAppAgentAssertion(value!.slice(7), { appId: APP_ID, projectId: PROJECT })).toEqual({ tokenId: TOKEN });
  });

  test('flag OFF on the calling project → null (today’s behaviour, no assertion)', async () => {
    const { load, seen } = loader(PROJECT, false);
    expect(await call(`${HOST}/api`, load)).toBeNull();
    expect(seen).toEqual([ROUTE_KEY]);
  });

  test('an App of ANOTHER project → null', async () => {
    expect(await call(HOST, loader(OTHER_PROJECT).load)).toBeNull();
  });

  test('an unknown route key → null', async () => {
    expect(await call(HOST, loader(null).load)).toBeNull();
  });

  test('a foreign host never reaches the lookup', async () => {
    for (const url of [
      'https://api.stripe.com',
      'https://dev-dashboards-cccccccccccccccc.apps.evil.example',
      'https://prod-dashboards-cccccccccccccccc.apps.kortix.com', // another environment
      'https://dev-dashboards-cccccccccccccccc.apps.kortix.com.evil.example',
      'not a url',
    ]) {
      const { load, seen } = loader(PROJECT);
      expect(await call(url, load)).toBeNull();
      expect(seen).toEqual([]);
    }
  });

  test('plain http to a real App domain → null (never send a credential in clear text)', async () => {
    const { load, seen } = loader(PROJECT);
    expect(await call(HOST.replace('https:', 'http:'), load)).toBeNull();
    expect(seen).toEqual([]);
  });

  test('a local *.apps.localhost host only in local mode', async () => {
    const local = `http://${ROUTE_KEY}.apps.localhost:8008`;
    const off = loader(PROJECT);
    expect(await call(local, off.load, false)).toBeNull();
    expect(off.seen).toEqual([]);
    const on = loader(PROJECT);
    expect((await call(local, on.load, true))?.startsWith('Bearer kortix_app_assertion.')).toBe(true);
  });
});
