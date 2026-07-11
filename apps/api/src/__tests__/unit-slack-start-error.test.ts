import { describe, expect, test } from 'bun:test';

import { startErrorMessage } from '../channels/slack/start-error';

// Honest, actionable copy for EVERY create-path failure a Slack turn can hit.
// Before this, only 402/429/404 were mapped; every other status (and the
// deleted-agent case) collapsed into the same "give it a moment and try again"
// line — which is actively wrong when retrying can never succeed.
describe('startErrorMessage', () => {
  test('402 → out of credits, points to top-up', () => {
    const m = startErrorMessage(402, { error: 'insufficient credits' });
    expect(m.toLowerCase()).toContain('out of credits');
    expect(m).toContain('Top up');
  });

  test('429 → concurrent-session limit', () => {
    const m = startErrorMessage(429, {});
    expect(m.toLowerCase()).toContain('concurrent-session limit');
  });

  test('404 → project moved/deleted, points to /kortix switch', () => {
    const m = startErrorMessage(404, {});
    expect(m).toContain('/kortix switch');
  });

  test('409 → no owning account, points to /kortix login', () => {
    const m = startErrorMessage(409, {});
    expect(m).toContain('/kortix login');
  });

  test('403 → permission, ask an admin', () => {
    const m = startErrorMessage(403, {});
    expect(m.toLowerCase()).toContain('permission');
    expect(m.toLowerCase()).toContain('admin');
  });

  test('UNKNOWN_SANDBOX_TEMPLATE code → template-specific copy (beats the 400 status)', () => {
    const m = startErrorMessage(400, { code: 'UNKNOWN_SANDBOX_TEMPLATE', error: 'no such template' });
    expect(m.toLowerCase()).toContain('sandbox template');
  });

  test('KORTIX_URL_UNREACHABLE code → runtime-unreachable copy', () => {
    const m = startErrorMessage(503, { code: 'KORTIX_URL_UNREACHABLE', error: 'unreachable' });
    expect(m.toLowerCase()).toContain('sandbox runtime');
  });

  test('400 with a short human detail surfaces it verbatim', () => {
    const m = startErrorMessage(400, { error: 'Unknown or disabled sandbox provider: platinum' });
    expect(m).toContain('platinum');
    expect(m).toContain('/kortix');
  });

  test('400 with a long/internal detail drops the noise', () => {
    const long = 'x'.repeat(400);
    const m = startErrorMessage(400, { error: long });
    expect(m).not.toContain(long);
  });

  test('5xx → temporary error, retry guidance', () => {
    for (const s of [500, 502, 503, 504]) {
      const m = startErrorMessage(s, {});
      expect(m.toLowerCase()).toContain('temporary error');
    }
  });

  test('unknown status still yields a sensible next-step line (never blank)', () => {
    const m = startErrorMessage(418, {});
    expect(m.length).toBeGreaterThan(0);
    expect(m.toLowerCase()).toContain('send your message again');
  });

  test('undefined body never throws', () => {
    expect(() => startErrorMessage(undefined, undefined)).not.toThrow();
  });
});
