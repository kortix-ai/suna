/**
 * The 401 for a bad `Authorization` header must say WHICH kind of bad it is.
 * Until KRTX-2168 one message served both a missing header and a non-Bearer
 * scheme (`Authorization: Basic`), so an edge that dropped the header and a
 * browser answering an HTTP auth challenge were indistinguishable in logs —
 * a diagnosis was filed from a shape a `Basic` header reproduces exactly.
 * `Bearer <junk>` keeps its own "invalid token" shape: received, failed
 * verification — a different failure again.
 */
import { describe, expect, test } from 'bun:test';
import { app } from '../index';

type Shape = { status: number; message: string };

async function shape(headers: Record<string, string>): Promise<Shape> {
  const res = await app.request('/v1/accounts', { headers });
  const body = (await res.json()) as { message?: string };
  return { status: res.status, message: body?.message ?? JSON.stringify(body) };
}

describe('Authorization header 401 shapes', () => {
  test('absent header says the header is missing', async () => {
    const s = await shape({});
    expect(s.status).toBe(401);
    expect(s.message.toLowerCase()).toContain('missing');
    expect(s.message.toLowerCase()).toContain('authorization');
    expect(s.message.toLowerCase()).not.toContain('scheme');
  });

  test('non-Bearer scheme (Basic) names the scheme, not a missing header', async () => {
    const s = await shape({ Authorization: 'Basic a29ydGl4OnBhc3N3b3Jk' });
    expect(s.status).toBe(401);
    expect(s.message.toLowerCase()).toContain('scheme');
  });

  test('the absent-header and non-Bearer-scheme shapes are distinct strings', async () => {
    const absent = await shape({});
    const basic = await shape({ Authorization: 'Basic a29ydGl4OnBhc3N3b3Jk' });
    expect(absent.status).toBe(401);
    expect(basic.status).toBe(401);
    expect(absent.message).not.toBe(basic.message);
  });

  test('Bearer with a junk token keeps the invalid-token shape', async () => {
    const s = await shape({ Authorization: 'Bearer not-a-real-jwt' });
    expect(s.status).toBe(401);
    expect(s.message.toLowerCase()).toContain('invalid');
    expect(s.message.toLowerCase()).not.toContain('missing authorization header');
  });
});
