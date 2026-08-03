import { describe, expect, test } from 'bun:test';

import { agentConfigEtag } from './compile-agent-config';
import { isConfigStale } from './session-reload';

describe('agentConfigEtag', () => {
  test('the same config hashes the same, a changed one does not', () => {
    const a = '{"agent":{"support":{"prompt":"v1"}}}';
    expect(agentConfigEtag(a)).toBe(agentConfigEtag(a));
    expect(agentConfigEtag(a)).not.toBe(agentConfigEtag('{"agent":{"support":{"prompt":"v2"}}}'));
  });

  test('no compiled config has no etag — not the hash of "null"', () => {
    // A v1 project has nothing to compare. Hashing the absence would give every
    // v1 project the same non-null etag and make "stale" answerable when it
    // is not.
    expect(agentConfigEtag(null)).toBeNull();
    expect(agentConfigEtag(undefined)).toBeNull();
    expect(agentConfigEtag('')).toBeNull();
  });

  test('it is short enough to read and long enough to compare', () => {
    expect(agentConfigEtag('{"agent":{}}')).toHaveLength(16);
    expect(agentConfigEtag('{"agent":{}}')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('isConfigStale', () => {
  test('different hashes are stale, identical ones are not', () => {
    expect(isConfigStale('aaaa', 'bbbb')).toBe(true);
    expect(isConfigStale('aaaa', 'aaaa')).toBe(false);
  });

  test('an unknown side is null, NEVER false', () => {
    // "Up to date" and "could not ask" are different answers, and collapsing
    // them is exactly how a stale session goes unnoticed: an unreachable box
    // would report itself current. The CLI prints a warning for null rather
    // than a green tick.
    expect(isConfigStale(null, 'bbbb')).toBeNull();
    expect(isConfigStale('aaaa', null)).toBeNull();
    expect(isConfigStale(null, null)).toBeNull();
  });

  test('a project with no compiled config is unanswerable, not "current"', () => {
    // v1 projects compile to null on both sides.
    expect(isConfigStale(agentConfigEtag(null), agentConfigEtag(null))).toBeNull();
  });
});
