import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requestWorkspaceParams } from './auth-scope';

/**
 * The fence judges the ids a `reach: 'param'` request names. It must read the
 * same body the handler reads: billing handlers call `c.req.json()`, which
 * Hono parses whatever the Content-Type says.
 */
const B = '22222222-2222-4222-8222-222222222222';

function app() {
  const hono = new Hono();
  hono.post('/v1/billing/auto-topup/configure', async (c) => {
    const ids = await requestWorkspaceParams(c);
    const handlerSaw = await c.req.json().catch(() => null);
    return c.json({ ids, handlerSaw });
  });
  return hono;
}

async function post(body: string, contentType?: string) {
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  const res = await app().request('/v1/billing/auto-topup/configure', { method: 'POST', body, headers });
  return (await res.json()) as { ids: string[]; handlerSaw: unknown };
}

describe('requestWorkspaceParams', () => {
  const json = JSON.stringify({ account_id: B, enabled: false });

  for (const contentType of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', undefined]) {
    test(`a JSON body names B with Content-Type ${contentType ?? '(none)'}: the fence sees B, and the handler still reads the body`, async () => {
      const out = await post(json, contentType);
      expect(out.ids).toContain(B);
      expect(out.handlerSaw).toEqual({ account_id: B, enabled: false });
    });
  }

  test('a form-encoded body names B: the fence sees B', async () => {
    const out = await post(`workspace_id=${B}&enabled=false`, 'application/x-www-form-urlencoded');
    expect(out.ids).toContain(B);
  });

  test('the query string names B', async () => {
    const res = await app().request(`/v1/billing/auto-topup/configure?project_id=${B}`, { method: 'POST', body: '{}' });
    expect(((await res.json()) as { ids: string[] }).ids).toContain(B);
  });

  test('an empty body names nothing', async () => {
    expect((await post('', 'text/plain')).ids).toEqual([]);
  });
});
