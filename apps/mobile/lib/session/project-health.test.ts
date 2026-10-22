import { expect, test } from 'bun:test';
import { mapSandboxHealth } from './project-health';
import type { SessionHealthResult } from '@kortix/sdk';

const result = (status: number, health: SessionHealthResult['health'] = null): SessionHealthResult => ({
  status, ok: status === 200, health, body: '', hop: null, upstreamStatus: null,
});

test('maps the existing sandbox readiness and boot failure signals', () => {
  expect(mapSandboxHealth(result(503))).toEqual({ status: 'starting' });
  expect(mapSandboxHealth(result(502))).toEqual({ status: 'unreachable' });
  expect(mapSandboxHealth(result(200, { boot_error: 'failed' }))).toEqual({ status: 'starting', bootError: 'failed' });
  for (const health of [{ runtimeReady: true }, { opencode: 'ok' }, { status: 'up' }]) {
    expect(mapSandboxHealth(result(200, health))).toEqual({ status: 'ready' });
  }
  expect(mapSandboxHealth(result(200, {}))).toEqual({ status: 'starting', bootError: null });
});
