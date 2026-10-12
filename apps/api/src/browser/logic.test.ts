import { describe, expect, test } from 'bun:test';
import {
  BrowserError,
  browserErrorBody,
  decideConsent,
  isOnline,
  isStopReason,
  ONLINE_WINDOW_MS,
  pickBrowser,
  toBrowserDto,
  type BrowserRow,
} from './logic';

const NOW = Date.parse('2026-10-12T12:00:00Z');

function row(over: Partial<BrowserRow> & { browserId: string }): BrowserRow {
  return {
    name: 'Chrome (macOS)',
    brand: 'Chrome',
    os: 'macOS',
    profileLabel: null,
    extensionVersion: '1.0.0',
    accessMode: 'always',
    tabScope: 'own',
    lastSeenAt: new Date(NOW - 5_000),
    relayOwnerId: 'replica-1',
    revokedAt: null,
    createdAt: new Date(NOW - 86_400_000),
    ...over,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BrowserError) return err.code;
    throw err;
  }
  return 'none';
}

describe('isOnline', () => {
  test('online inside the 75 s window', () => {
    expect(isOnline(row({ browserId: 'a', lastSeenAt: new Date(NOW - ONLINE_WINDOW_MS + 1) }), NOW)).toBe(true);
  });
  test('offline at 75 s, when never seen, and when revoked', () => {
    expect(isOnline(row({ browserId: 'a', lastSeenAt: new Date(NOW - ONLINE_WINDOW_MS) }), NOW)).toBe(false);
    expect(isOnline(row({ browserId: 'a', lastSeenAt: null }), NOW)).toBe(false);
    expect(isOnline(row({ browserId: 'a', revokedAt: new Date(NOW) }), NOW)).toBe(false);
    // The control socket closed (sign-out): offline at once, though the last ping is fresh.
    expect(isOnline(row({ browserId: 'a', lastSeenAt: new Date(NOW), relayOwnerId: null }), NOW)).toBe(false);
  });
});

describe('toBrowserDto', () => {
  test('maps the protocol Browser shape', () => {
    const dto = toBrowserDto(row({ browserId: 'b1', profileLabel: 'Work' }), [], NOW);
    expect(dto).toMatchObject({ id: 'b1', online: true, profileLabel: 'Work', accessMode: 'always', activeSessions: [] });
    expect(dto.lastSeenAt).toBe(new Date(NOW - 5_000).toISOString());
  });
});

describe('pickBrowser', () => {
  const work = row({ browserId: 'id-work', name: 'Work', lastSeenAt: new Date(NOW - 30_000) });
  const home = row({ browserId: 'id-home', name: 'Home', lastSeenAt: new Date(NOW - 2_000) });
  const stale = row({ browserId: 'id-stale', name: 'Stale', lastSeenAt: new Date(NOW - 600_000) });
  const gone = row({ browserId: 'id-gone', name: 'Gone', revokedAt: new Date(NOW) });

  test('no rows, or only revoked rows: not connected', () => {
    expect(codeOf(() => pickBrowser([], undefined, NOW))).toBe('browser_not_connected');
    expect(codeOf(() => pickBrowser([gone], undefined, NOW))).toBe('browser_not_connected');
  });
  test('without a name: the online browser with the newest last_seen_at', () => {
    expect(pickBrowser([work, stale, home], undefined, NOW).browserId).toBe('id-home');
  });
  test('without a name and nothing online: offline', () => {
    expect(codeOf(() => pickBrowser([stale], undefined, NOW))).toBe('browser_offline');
  });
  test('matches by id or by name, case-insensitive', () => {
    expect(pickBrowser([work, home], 'WORK', NOW).browserId).toBe('id-work');
    expect(pickBrowser([work, home], 'id-home', NOW).browserId).toBe('id-home');
  });
  test('a name that matches nothing, a revoked browser, an offline browser', () => {
    expect(codeOf(() => pickBrowser([work], 'nope', NOW))).toBe('browser_not_found');
    expect(codeOf(() => pickBrowser([work, gone], 'Gone', NOW))).toBe('browser_not_found');
    expect(codeOf(() => pickBrowser([work, stale], 'Stale', NOW))).toBe('browser_offline');
  });
});

describe('decideConsent', () => {
  const base = { sessionId: 's1', projectId: 'p1', ask: false };
  test('mode off refuses, even with ask=true', () => {
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'off', grants: [] }))).toBe('browser_access_off');
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'off', grants: [], ask: true }))).toBe('browser_access_off');
  });
  test('a deny grant for this session refuses; for another session it does not', () => {
    const deny = [{ projectId: 'p1', sessionId: 's1', decision: 'deny' }];
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'always', grants: deny }))).toBe('browser_denied');
    const other = [{ projectId: 'p1', sessionId: 's2', decision: 'deny' }];
    expect(decideConsent({ ...base, accessMode: 'always', grants: other })).toBe('granted');
  });
  test('ask=true prompts, and overrides an earlier deny', () => {
    const deny = [{ projectId: 'p1', sessionId: 's1', decision: 'deny' }];
    expect(decideConsent({ ...base, accessMode: 'always', grants: deny, ask: true })).toBe('ask');
  });
  test('always with ask=false is granted', () => {
    expect(decideConsent({ ...base, accessMode: 'always', grants: [] })).toBe('granted');
  });
  test('mode ask prompts unless a session or project allow exists', () => {
    expect(decideConsent({ ...base, accessMode: 'ask', grants: [] })).toBe('ask');
    expect(
      decideConsent({ ...base, accessMode: 'ask', grants: [{ projectId: 'p1', sessionId: 's1', decision: 'allow' }] }),
    ).toBe('granted');
    expect(
      decideConsent({ ...base, accessMode: 'ask', grants: [{ projectId: 'p1', sessionId: null, decision: 'allow' }] }),
    ).toBe('granted');
    expect(
      decideConsent({ ...base, accessMode: 'ask', grants: [{ projectId: 'p2', sessionId: null, decision: 'allow' }] }),
    ).toBe('ask');
  });
});

describe('errors', () => {
  test('every code carries the protocol HTTP status', () => {
    const status = (code: ConstructorParameters<typeof BrowserError>[0]) => new BrowserError(code).status;
    expect(status('browser_not_connected')).toBe(404);
    expect(status('browser_not_found')).toBe(404);
    expect(status('browser_offline')).toBe(409);
    expect(status('browser_access_off')).toBe(403);
    expect(status('browser_denied')).toBe(403);
    expect(status('browser_consent_timeout')).toBe(408);
  });
  test('the body names the code and the connect URL', () => {
    const body = browserErrorBody('browser_offline', 'https://kortix.com/');
    expect(body.code).toBe('browser_offline');
    expect(body.connectUrl).toBe('https://kortix.com/settings/browsers');
    expect(body.error.length).toBeGreaterThan(10);
  });
});

describe('isStopReason', () => {
  test('stopped and canceled_by_user deny the session; closed and error do not', () => {
    expect(isStopReason('stopped')).toBe(true);
    expect(isStopReason('canceled_by_user')).toBe(true);
    expect(isStopReason('closed')).toBe(false);
    expect(isStopReason('error')).toBe(false);
  });
});
