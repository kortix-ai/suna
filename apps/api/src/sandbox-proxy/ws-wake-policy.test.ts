import { describe, expect, test } from 'bun:test';
import { shouldWakeStoppedSandboxForWsAttach } from './routes/preview';

const PTY = '/kortix/pty/kpty_1/connect';

describe('shouldWakeStoppedSandboxForWsAttach', () => {
  // The whole incident: a terminal attach to a parked box was refused 503,
  // the browser saw only close 1006, and nothing in the retry loop could ever
  // wake the sandbox. A user-initiated attach must resume it.
  test('a user-initiated pty attach wakes a stopped box', () => {
    expect(shouldWakeStoppedSandboxForWsAttach('stopped', PTY, { wakeRequested: true })).toBe(true);
  });

  test('an automatic retry (no wake marker) never wakes a box', () => {
    expect(shouldWakeStoppedSandboxForWsAttach('stopped', PTY, { wakeRequested: false })).toBe(false);
  });

  test('an active box needs no wake', () => {
    expect(shouldWakeStoppedSandboxForWsAttach('active', PTY, { wakeRequested: true })).toBe(false);
  });

  test('a non-resumable status is never woken here', () => {
    for (const status of ['archived', 'deleted', 'provisioning', 'error']) {
      expect(shouldWakeStoppedSandboxForWsAttach(status, PTY, { wakeRequested: true })).toBe(false);
    }
  });

  test('opencode-hosted pty attaches count too', () => {
    expect(shouldWakeStoppedSandboxForWsAttach('stopped', '/pty/abc/connect', { wakeRequested: true })).toBe(true);
  });

  test('a non-pty websocket (app preview, hmr) never wakes a box', () => {
    expect(shouldWakeStoppedSandboxForWsAttach('stopped', '/_next/webpack-hmr', { wakeRequested: true })).toBe(false);
    expect(shouldWakeStoppedSandboxForWsAttach('stopped', '/socket.io/', { wakeRequested: true })).toBe(false);
  });

  test('only a real principal may wake a box', () => {
    expect(
      shouldWakeStoppedSandboxForWsAttach('stopped', PTY, { wakeRequested: true, accessKind: 'public_share' }),
    ).toBe(false);
  });
});
