import { describe, expect, test } from 'bun:test';

import { createInstallationTokenCache } from './github-installation-token-cache';

const MINUTE = 60_000;

function mintStub(now: () => number) {
  const calls: string[] = [];
  let n = 0;
  const mint = async (installationId: string, repositories: string[]) => {
    calls.push(`${installationId}:${repositories.join(',')}`);
    n += 1;
    return { token: `tok-${n}`, expires_at: new Date(now() + 60 * MINUTE).toISOString() };
  };
  return { mint, calls };
}

describe('installation token cache', () => {
  test('reuses a token while at least 45 minutes of its life remain', async () => {
    let t = 1_000_000;
    const now = () => t;
    const { mint, calls } = mintStub(now);
    const cache = createInstallationTokenCache({ now });

    const a = await cache.get('app1', '42', ['repo'], mint);
    t += 14 * MINUTE;
    const b = await cache.get('app1', '42', ['repo'], mint);

    expect(a.token).toBe('tok-1');
    expect(b.token).toBe('tok-1');
    expect(calls).toEqual(['42:repo']);
  });

  test('mints again once less than 45 minutes remain', async () => {
    let t = 1_000_000;
    const now = () => t;
    const { mint, calls } = mintStub(now);
    const cache = createInstallationTokenCache({ now });

    await cache.get('app1', '42', ['repo'], mint);
    t += 16 * MINUTE;
    const b = await cache.get('app1', '42', ['repo'], mint);

    expect(b.token).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  test('keys by app, installation, and the sorted repository scope', async () => {
    const now = () => 1_000_000;
    const { mint, calls } = mintStub(now);
    const cache = createInstallationTokenCache({ now });

    await cache.get('app1', '42', ['b', 'a'], mint);
    await cache.get('app1', '42', ['a', 'b'], mint);
    await cache.get('app1', '42', [], mint);
    await cache.get('app1', '43', ['a', 'b'], mint);
    await cache.get('app2', '42', ['a', 'b'], mint);

    expect(calls).toEqual(['42:b,a', '42:', '43:a,b', '42:a,b']);
  });

  test('shares one in-flight mint between concurrent callers', async () => {
    const now = () => 1_000_000;
    const { mint, calls } = mintStub(now);
    const cache = createInstallationTokenCache({ now });

    const [a, b, c] = await Promise.all([
      cache.get('app1', '42', ['repo'], mint),
      cache.get('app1', '42', ['repo'], mint),
      cache.get('app1', '42', ['repo'], mint),
    ]);

    expect(calls).toHaveLength(1);
    expect(new Set([a.token, b.token, c.token])).toEqual(new Set(['tok-1']));
  });

  test('never caches a failed mint', async () => {
    const now = () => 1_000_000;
    const cache = createInstallationTokenCache({ now });
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('GitHub 404');
      return { token: 'tok-ok', expires_at: new Date(now() + 60 * MINUTE).toISOString() };
    };

    await expect(cache.get('app1', '42', [], flaky)).rejects.toThrow('GitHub 404');
    const second = await cache.get('app1', '42', [], flaky);

    expect(second.token).toBe('tok-ok');
    expect(attempts).toBe(2);
  });

  test('does not cache a token with an unparseable expiry', async () => {
    const now = () => 1_000_000;
    const cache = createInstallationTokenCache({ now });
    let attempts = 0;
    const mint = async () => {
      attempts += 1;
      return { token: `tok-${attempts}`, expires_at: 'not-a-date' };
    };

    await cache.get('app1', '42', [], mint);
    const second = await cache.get('app1', '42', [], mint);

    expect(second.token).toBe('tok-2');
  });

  test('invalidate drops every scope of one installation', async () => {
    const now = () => 1_000_000;
    const { mint, calls } = mintStub(now);
    const cache = createInstallationTokenCache({ now });

    await cache.get('app1', '42', ['a'], mint);
    await cache.get('app1', '42', [], mint);
    await cache.get('app1', '43', [], mint);
    cache.invalidate('42');
    await cache.get('app1', '42', ['a'], mint);
    await cache.get('app1', '42', [], mint);
    await cache.get('app1', '43', [], mint);

    expect(calls).toEqual(['42:a', '42:', '43:', '42:a', '42:']);
  });
});
