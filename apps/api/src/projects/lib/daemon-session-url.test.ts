// A DAEMON CALL THAT NAMES NO SESSION REACHES NO SESSION.
import { describe, expect, test } from 'bun:test';
import { daemonSessionUrl } from './daemon-session-url';

const base = 'https://8080-abc.sbx-dev.example';

describe('the daemon call URL', () => {
  test('names the session, because a cell box holds several', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/state', 's1')).toBe(
      `${base}/kortix/opencode/state?c=s1`,
    );
  });

  test('carries the stream cursor alongside it', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/events', 's1', { since: 7, epoch: 'e1' })).toBe(
      `${base}/kortix/opencode/events?c=s1&since=7&epoch=e1`,
    );
  });

  test('drops a cursor that has no value rather than sending "null"', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/events', 's1', { since: null, epoch: undefined })).toBe(
      `${base}/kortix/opencode/events?c=s1`,
    );
  });

  test('keeps since=0 — a full replay is a real cursor, not an absent one', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/events', 's1', { since: 0 })).toBe(
      `${base}/kortix/opencode/events?c=s1&since=0`,
    );
  });

  test('omits `c` entirely when there is no session, rather than sending a blank', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/state', null)).toBe(
      `${base}/kortix/opencode/state`,
    );
    expect(daemonSessionUrl(base, '/kortix/opencode/state', '  ')).toBe(
      `${base}/kortix/opencode/state`,
    );
  });

  test('tolerates a base with a trailing slash', () => {
    expect(daemonSessionUrl(`${base}/`, '/kortix/opencode/state', 's1')).toBe(
      `${base}/kortix/opencode/state?c=s1`,
    );
  });

  test('escapes a session id rather than splicing it in raw', () => {
    expect(daemonSessionUrl(base, '/kortix/opencode/state', 'a b&c')).toBe(
      `${base}/kortix/opencode/state?c=a+b%26c`,
    );
  });
});
