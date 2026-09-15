import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { UNKNOWN_DAEMON_ROUTE_ERROR, shareUpstreamResult } from './share-upstream';

describe('shareUpstreamResult', () => {
  test('a daemon without share routes answers 502, not a sandbox-not-found 404', () => {
    expect(shareUpstreamResult(404, { error: UNKNOWN_DAEMON_ROUTE_ERROR })).toEqual({
      status: 502,
      body: { error: 'This sandbox does not support share links' },
    });
  });

  test('any other daemon answer passes through unchanged', () => {
    expect(shareUpstreamResult(404, { error: 'share token not found' })).toEqual({
      status: 404,
      body: { error: 'share token not found' },
    });
    expect(shareUpstreamResult(200, { token: 't1' })).toEqual({ status: 200, body: { token: 't1' } });
  });

  // The marker is the daemon's catch-all body. A rename there must fail here.
  test('the marker matches the daemon /kortix catch-all', () => {
    const proxy = readFileSync(
      new URL('../../../kortix-sandbox-agent-server/src/proxy.ts', import.meta.url),
      'utf8',
    );
    expect(proxy).toContain(`c.json({ error: '${UNKNOWN_DAEMON_ROUTE_ERROR}' }, 404)`);
  });
});
