import { describe, expect, test } from 'bun:test';

import {
  EMPTY_PORTS,
  forwardedToast,
  forwardsStatusHint,
  newlyDetected,
  sortedRows,
  withDetected,
  withError,
  withForwarding,
  withStopped,
} from './ports-state.ts';

describe('withDetected', () => {
  test('adds a new port in the stopped state', () => {
    const rows = withDetected(EMPTY_PORTS, 3000, 'terminal');
    expect(rows.get(3000)).toEqual({
      sandboxPort: 3000,
      localPort: null,
      url: null,
      source: 'terminal',
      state: 'stopped',
    });
  });

  test('is a no-op when the port is already tracked', () => {
    const forwarding = withForwarding(EMPTY_PORTS, 3000, 'terminal', 3000, 'http://127.0.0.1:3000');
    const after = withDetected(forwarding, 3000, 'manual');
    expect(after).toBe(forwarding);
    expect(after.get(3000)?.state).toBe('forwarding');
  });
});

describe('withForwarding / withStopped / withError', () => {
  test('withForwarding records the bound local port and url', () => {
    const rows = withForwarding(EMPTY_PORTS, 3000, 'transcript', 3001, 'http://127.0.0.1:3001');
    expect(rows.get(3000)).toEqual({
      sandboxPort: 3000,
      localPort: 3001,
      url: 'http://127.0.0.1:3001',
      source: 'transcript',
      state: 'forwarding',
    });
  });

  test('withStopped clears the local port/url but keeps the source', () => {
    const forwarding = withForwarding(EMPTY_PORTS, 3000, 'manual', 3000, 'http://127.0.0.1:3000');
    const stopped = withStopped(forwarding, 3000);
    expect(stopped.get(3000)).toEqual({
      sandboxPort: 3000,
      localPort: null,
      url: null,
      source: 'manual',
      state: 'stopped',
    });
  });

  test('withStopped on an unknown port defaults its source to manual', () => {
    const rows = withStopped(EMPTY_PORTS, 4000);
    expect(rows.get(4000)?.source).toBe('manual');
  });

  test('withError records the failure message', () => {
    const rows = withError(EMPTY_PORTS, 3000, 'terminal', 'EADDRINUSE');
    expect(rows.get(3000)).toMatchObject({ state: 'error', error: 'EADDRINUSE' });
  });
});

describe('newlyDetected', () => {
  test('filters out ports already tracked in any state', () => {
    const rows = withForwarding(
      withDetected(EMPTY_PORTS, 5173, 'terminal'),
      3000,
      'transcript',
      3000,
      'http://127.0.0.1:3000',
    );
    expect(newlyDetected(rows, [3000, 5173, 8080])).toEqual([8080]);
  });

  test('everything is new against an empty map', () => {
    expect(newlyDetected(EMPTY_PORTS, [3000, 5173])).toEqual([3000, 5173]);
  });
});

describe('sortedRows', () => {
  test('ascending by sandbox port, regardless of insertion order', () => {
    let rows = withDetected(EMPTY_PORTS, 8080, 'terminal');
    rows = withDetected(rows, 3000, 'manual');
    rows = withDetected(rows, 5173, 'transcript');
    expect(sortedRows(rows).map((row) => row.sandboxPort)).toEqual([3000, 5173, 8080]);
  });
});

describe('forwardedToast', () => {
  test('names the local and sandbox ports', () => {
    expect(forwardedToast({ sandboxPort: 3000, localPort: 3000 })).toBe(
      'Forwarded localhost:3000 → sandbox:3000',
    );
  });

  test('a different local port shows both numbers', () => {
    expect(forwardedToast({ sandboxPort: 3000, localPort: 4000 })).toBe(
      'Forwarded localhost:4000 → sandbox:3000',
    );
  });
});

describe('forwardsStatusHint', () => {
  test('empty when nothing is forwarding', () => {
    expect(forwardsStatusHint(EMPTY_PORTS)).toBe('');
    expect(forwardsStatusHint(withDetected(EMPTY_PORTS, 3000, 'terminal'))).toBe('');
  });

  test('lists forwarding ports ascending, ignoring stopped/error rows', () => {
    let rows = withForwarding(EMPTY_PORTS, 5173, 'transcript', 5173, 'http://127.0.0.1:5173');
    rows = withForwarding(rows, 3000, 'terminal', 3000, 'http://127.0.0.1:3000');
    rows = withError(rows, 9000, 'manual', 'boom');
    expect(forwardsStatusHint(rows)).toBe('⇄ 3000, 5173');
  });
});
