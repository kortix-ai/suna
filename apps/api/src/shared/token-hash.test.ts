import { afterEach, describe, expect, test } from 'bun:test';
import { candidateSecretKeyHashes, hashSecretKey } from './crypto';
import {
  candidateSecretKeyHashesAsync,
  hashSecretKeyAsync,
  isTokenHashCached,
  isTokenValidated,
  markTokenValidated,
  resetTokenHashCache,
  tokenHashCacheSizes,
} from './token-hash';

afterEach(() => resetTokenHashCache());

describe('token-hash — presented-token hashing off the event loop', () => {
  test('produces exactly the stored format of the synchronous hash (no migration)', async () => {
    const token = 'kortix_pat_compat_check_0123456789';
    expect(await candidateSecretKeyHashesAsync(token)).toEqual(candidateSecretKeyHashes(token));
    expect(await hashSecretKeyAsync(token)).toBe(hashSecretKey(token));
  });

  test('the event loop keeps turning while an unknown token is hashed', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => candidateSecretKeyHashesAsync(`kortix_pat_loop_${i}`)),
      );
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  test('a token is hashed once; the next validation reuses the hash', async () => {
    const token = 'kortix_pat_memo_check';
    expect(isTokenHashCached(token)).toBe(false);
    const first = await candidateSecretKeyHashesAsync(token);
    expect(isTokenHashCached(token)).toBe(true);
    const started = performance.now();
    const second = await candidateSecretKeyHashesAsync(token);
    expect(performance.now() - started).toBeLessThan(5);
    expect(second).toEqual(first);
  });

  test('concurrent validations of one token share one computation', async () => {
    const token = 'kortix_pat_inflight_check';
    const results = await Promise.all(
      Array.from({ length: 5 }, () => candidateSecretKeyHashesAsync(token)),
    );
    for (const result of results) expect(result).toEqual(results[0]!);
    expect(tokenHashCacheSizes().negative).toBe(1);
  });

  test('unknown tokens cannot evict a token that validated (separate bounded maps)', async () => {
    resetTokenHashCache(4);
    const real = 'kortix_pat_real_caller';
    await candidateSecretKeyHashesAsync(real);
    markTokenValidated(real);
    expect(isTokenValidated(real)).toBe(true);

    for (let i = 0; i < 12; i++) await candidateSecretKeyHashesAsync(`kortix_pat_flood_${i}`);

    const sizes = tokenHashCacheSizes();
    expect(sizes.negative).toBeLessThanOrEqual(4);
    expect(sizes.positive).toBe(1);
    expect(isTokenHashCached(real)).toBe(true);
    expect(isTokenHashCached('kortix_pat_flood_0')).toBe(false);
  });
});
