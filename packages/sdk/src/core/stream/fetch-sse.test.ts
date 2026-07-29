import { expect, test } from 'bun:test';
import { buildTunnelEventStreamUrl } from './fetch-sse';

test('buildTunnelEventStreamUrl owns the permission-request stream route', () => {
  expect(buildTunnelEventStreamUrl('https://api.example.test/v1/')).toBe(
    'https://api.example.test/v1/tunnel/permission-requests/stream',
  );
});
