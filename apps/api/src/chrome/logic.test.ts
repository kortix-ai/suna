import { describe, expect, test } from 'bun:test';
import {
  ChromeError,
  chromeErrorBody,
  decideConsent,
  isOnline,
  isStopReason,
  ONLINE_WINDOW_MS,
  pickChrome,
  toChromeDto,
  type ChromeRow,
} from './logic';

const NOW = Date.parse('2026-10-12T12:00:00Z');

function row(over: Partial<ChromeRow> & { chromeId: string }): ChromeRow {
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
    if (err instanceof ChromeError) return err.code;
    throw err;
  }
  return 'none';
}

describe('isOnline', () => {
  test('online inside the 75 s window', () => {
    expect(isOnline(row({ chromeId: 'a', lastSeenAt: new Date(NOW - ONLINE_WINDOW_MS + 1) }), NOW)).toBe(true);
  });
  test('offline at 75 s, when never seen, and when revoked', () => {
    expect(isOnline(row({ chromeId: 'a', lastSeenAt: new Date(NOW - ONLINE_WINDOW_MS) }), NOW)).toBe(false);
    expect(isOnline(row({ chromeId: 'a', lastSeenAt: null }), NOW)).toBe(false);
    expect(isOnline(row({ chromeId: 'a', revokedAt: new Date(NOW) }), NOW)).toBe(false);
    // The control socket closed (sign-out): offline at once, though the last ping is fresh.
    expect(isOnline(row({ chromeId: 'a', lastSeenAt: new Date(NOW), relayOwnerId: null }), NOW)).toBe(false);
  });
});

describe('toChromeDto', () => {
  test('maps the protocol Browser shape', () => {
    const dto = toChromeDto(row({ chromeId: 'b1', profileLabel: 'Work' }), [], NOW);
    expect(dto).toMatchObject({ id: 'b1', online: true, profileLabel: 'Work', accessMode: 'always', activeSessions: [] });
    expect(dto.lastSeenAt).toBe(new Date(NOW - 5_000).toISOString());
  });
});

describe('pickChrome', () => {
  const work = row({ chromeId: 'id-work', name: 'Work', lastSeenAt: new Date(NOW - 30_000) });
  const home = row({ chromeId: 'id-home', name: 'Home', lastSeenAt: new Date(NOW - 2_000) });
  const stale = row({ chromeId: 'id-stale', name: 'Stale', lastSeenAt: new Date(NOW - 600_000) });
  const gone = row({ chromeId: 'id-gone', name: 'Gone', revokedAt: new Date(NOW) });

  test('no rows, or only revoked rows: not connected', () => {
    expect(codeOf(() => pickChrome([], undefined, NOW))).toBe('chrome_not_connected');
    expect(codeOf(() => pickChrome([gone], undefined, NOW))).toBe('chrome_not_connected');
  });
  test('without a name: the online browser with the newest last_seen_at', () => {
    expect(pickChrome([work, stale, home], undefined, NOW).chromeId).toBe('id-home');
  });
  test('without a name and nothing online: offline', () => {
    expect(codeOf(() => pickChrome([stale], undefined, NOW))).toBe('chrome_offline');
  });
  test('matches by id or by name, case-insensitive', () => {
    expect(pickChrome([work, home], 'WORK', NOW).chromeId).toBe('id-work');
    expect(pickChrome([work, home], 'id-home', NOW).chromeId).toBe('id-home');
  });
  test('a name that matches nothing, a revoked browser, an offline browser', () => {
    expect(codeOf(() => pickChrome([work], 'nope', NOW))).toBe('chrome_not_found');
    expect(codeOf(() => pickChrome([work, gone], 'Gone', NOW))).toBe('chrome_not_found');
    expect(codeOf(() => pickChrome([work, stale], 'Stale', NOW))).toBe('chrome_offline');
  });
});

describe('decideConsent', () => {
  const base = { sessionId: 's1', projectId: 'p1', ask: false };
  test('mode off refuses, even with ask=true', () => {
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'off', grants: [] }))).toBe('chrome_access_off');
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'off', grants: [], ask: true }))).toBe('chrome_access_off');
  });
  test('a deny grant for this session refuses; for another session it does not', () => {
    const deny = [{ projectId: 'p1', sessionId: 's1', decision: 'deny' }];
    expect(codeOf(() => decideConsent({ ...base, accessMode: 'always', grants: deny }))).toBe('chrome_denied');
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
    const status = (code: ConstructorParameters<typeof ChromeError>[0]) => new ChromeError(code).status;
    expect(status('chrome_not_connected')).toBe(404);
    expect(status('chrome_not_found')).toBe(404);
    expect(status('chrome_offline')).toBe(409);
    expect(status('chrome_access_off')).toBe(403);
    expect(status('chrome_denied')).toBe(403);
    expect(status('chrome_consent_timeout')).toBe(408);
  });
  test('the body names the code and the connect URL', () => {
    const body = chromeErrorBody('chrome_offline', 'https://kortix.com/');
    expect(body.code).toBe('chrome_offline');
    expect(body.connectUrl).toBe('https://kortix.com/settings/chrome');
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
