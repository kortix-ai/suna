/**
 * The pin decides whether a stolen session token still works.
 *
 * These test the DECISION function directly, without a DB, because the two
 * things that matter are pure: which x-forwarded-for hop is the client, and
 * which verdicts allow versus block. The DB paths are exercised on dev.
 */
import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { requestEgressIp } from './sandbox-egress-pin';

const ctx = (headers: Record<string, string>) =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] } }) as unknown as Context;

describe('which address counts as the caller', () => {
  test('the FIRST x-forwarded-for hop is the client, not the last', () => {
    // Cloudflare fronts this API and appends. Taking the last hop would pin
    // Cloudflare's own address — identical for every sandbox on earth, which
    // would make the check pass for everyone and protect no one.
    expect(requestEgressIp(ctx({ 'x-forwarded-for': '67.213.121.131, 172.68.1.1' }))).toBe(
      '67.213.121.131',
    );
  });

  test('whitespace around a hop is tolerated', () => {
    expect(requestEgressIp(ctx({ 'x-forwarded-for': '  67.213.121.131 , 172.68.1.1' }))).toBe(
      '67.213.121.131',
    );
  });

  test('x-real-ip is the fallback', () => {
    expect(requestEgressIp(ctx({ 'x-real-ip': '67.213.113.135' }))).toBe('67.213.113.135');
  });

  test('an empty forwarded-for does not become an empty-string pin', () => {
    // '' is falsy but IS a string — pinning it would then "match" every later
    // request that also had no address, quietly disabling the check.
    expect(requestEgressIp(ctx({ 'x-forwarded-for': '' }))).toBeNull();
    expect(requestEgressIp(ctx({ 'x-forwarded-for': '   ' }))).toBeNull();
    expect(requestEgressIp(ctx({}))).toBeNull();
  });
});
