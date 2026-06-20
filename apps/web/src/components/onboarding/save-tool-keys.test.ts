import { describe, expect, test } from 'bun:test';
import { saveToolKeys } from './save-tool-keys';

describe('saveToolKeys', () => {
  test('reports every key as saved when all puts succeed', async () => {
    const res = await saveToolKeys(
      [
        ['A', '1'],
        ['B', '2'],
      ],
      async () => ({ ok: true }),
    );
    expect(res.succeeded).toEqual(['A', 'B']);
    expect(res.failed).toEqual([]);
  });

  test('separates non-ok responses into failed', async () => {
    const res = await saveToolKeys(
      [
        ['A', '1'],
        ['B', '2'],
      ],
      async (key) => ({ ok: key === 'A' }),
    );
    expect(res.succeeded).toEqual(['A']);
    expect(res.failed).toEqual(['B']);
  });

  test('counts thrown errors (e.g. network failure) as failed', async () => {
    const res = await saveToolKeys(
      [
        ['A', '1'],
        ['B', '2'],
      ],
      async (key) => {
        if (key === 'B') throw new Error('network down');
        return { ok: true };
      },
    );
    expect(res.succeeded).toEqual(['A']);
    expect(res.failed).toEqual(['B']);
  });

  test('reports all failed when every put fails (the bug this fixes)', async () => {
    const res = await saveToolKeys(
      [
        ['A', '1'],
        ['B', '2'],
      ],
      async () => ({ ok: false }),
    );
    expect(res.succeeded).toEqual([]);
    expect(res.failed).toEqual(['A', 'B']);
  });

  test('passes the value through to put unchanged', async () => {
    const seen: Record<string, string> = {};
    await saveToolKeys([['A', '  spaced  ']], async (key, value) => {
      seen[key] = value;
      return { ok: true };
    });
    expect(seen.A).toBe('  spaced  ');
  });
});
