import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { readJsonBody } from './http-body';

async function read(body: string | undefined): Promise<unknown> {
  const app = new Hono();
  app.post('/', async (c) => c.json({ body: await readJsonBody<unknown>(c, 'fallback') }));
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return ((await res.json()) as { body: unknown }).body;
}

describe('readJsonBody', () => {
  test('returns the parsed body', async () => {
    expect(await read('{"a":1}')).toEqual({ a: 1 });
    expect(await read('[1,2]')).toEqual([1, 2]);
  });

  test('returns the fallback for a missing or malformed body', async () => {
    expect(await read(undefined)).toBe('fallback');
    expect(await read('')).toBe('fallback');
    expect(await read('{not json')).toBe('fallback');
  });

  test('returns a JSON null body as null, not the fallback', async () => {
    expect(await read('null')).toBeNull();
  });
});
