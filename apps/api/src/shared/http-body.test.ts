import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { readJsonObject } from './http-body';

async function read(body: string | undefined): Promise<unknown> {
  const app = new Hono();
  app.post('/', async (c) => c.json({ body: await readJsonObject(c) }));
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return ((await res.json()) as { body: unknown }).body;
}

describe('readJsonObject', () => {
  test('returns a parsed JSON object', async () => {
    expect(await read('{"a":1,"b":{"c":null}}')).toEqual({ a: 1, b: { c: null } });
  });

  test('returns {} for a missing or malformed body', async () => {
    expect(await read(undefined)).toEqual({});
    expect(await read('')).toEqual({});
    expect(await read('{not json')).toEqual({});
  });

  test('returns {} for a JSON null body', async () => {
    expect(await read('null')).toEqual({});
  });

  test('returns {} for a JSON array body', async () => {
    expect(await read('[1,2]')).toEqual({});
    expect(await read('[{"a":1}]')).toEqual({});
  });

  test('returns {} for a JSON scalar body', async () => {
    expect(await read('"text"')).toEqual({});
    expect(await read('42')).toEqual({});
    expect(await read('true')).toEqual({});
  });
});
