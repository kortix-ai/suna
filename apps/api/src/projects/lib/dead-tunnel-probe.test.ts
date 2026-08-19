import { beforeEach, describe, expect, test } from 'bun:test';
import { resetTunnelProbeCache, sandboxCallbackDeadTunnelReason } from './sessions';

/**
 * Incident 2026-08-14: the trycloudflare quick tunnel died server-side while
 * the local cloudflared process stayed up. Every sandbox created afterwards
 * booted into a callback URL that could never answer, never became ready, and
 * surfaced as a false "computer was lost". The static loopback check could not
 * catch it — the URL was public and well-formed, just dead. This probe fails
 * session create/restart fast, with a reason that names the tunnel.
 */
describe('sandboxCallbackDeadTunnelReason', () => {
  const DEAD = 'https://scheduling-tampa-development-patents.trycloudflare.com/v1';
  const failingFetch = (async () => {
    throw new Error('unreachable');
  }) as unknown as typeof fetch;
  const okFetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

  beforeEach(() => resetTunnelProbeCache());

  test('a stable (non-quick-tunnel) URL is never probed', async () => {
    const explodingFetch = (async () => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch;
    expect(
      await sandboxCallbackDeadTunnelReason(Date.now(), 'https://api.kortix.com/v1', explodingFetch),
    ).toBeNull();
  });

  test('a dead quick tunnel returns an actionable reason', async () => {
    const reason = await sandboxCallbackDeadTunnelReason(Date.now(), DEAD, failingFetch);
    expect(reason).toContain('not answering');
    expect(reason).toContain('pnpm dev');
  });

  test('a healthy quick tunnel returns null', async () => {
    expect(await sandboxCallbackDeadTunnelReason(Date.now(), DEAD, okFetch)).toBeNull();
  });

  test('a non-2xx health answer is reported with its status', async () => {
    const gatewayFetch = (async () =>
      new Response('offline', { status: 530 })) as unknown as typeof fetch;
    const reason = await sandboxCallbackDeadTunnelReason(Date.now(), DEAD, gatewayFetch);
    expect(reason).toContain('530');
  });

  test('the verdict is cached inside the TTL so hot paths pay one probe', async () => {
    const t0 = Date.now();
    expect(await sandboxCallbackDeadTunnelReason(t0, DEAD, failingFetch)).toContain('not answering');
    // Within the TTL a healthy fetch is not even consulted — the cache answers.
    expect(await sandboxCallbackDeadTunnelReason(t0 + 1_000, DEAD, okFetch)).toContain(
      'not answering',
    );
    // Past the TTL the probe runs again and observes recovery.
    expect(await sandboxCallbackDeadTunnelReason(t0 + 31_000, DEAD, okFetch)).toBeNull();
  });
});
