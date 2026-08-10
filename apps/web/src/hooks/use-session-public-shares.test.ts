import { describe, expect, test } from 'bun:test';
import type { WorkspaceSessionPublicShare } from '@kortix/sdk';
import { isShareLive, publicSharesQueryKey, shareListState } from './use-session-public-shares';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function share(overrides: Partial<WorkspaceSessionPublicShare> = {}): WorkspaceSessionPublicShare {
  return {
    share_id: 'sh1',
    session_id: 's1',
    workspace_id: 'p1',
    resource_type: 'file',
    label: 'report.md',
    port: null,
    path: '/',
    file_path: '/workspace/report.md',
    mode: 'view',
    allow_websocket: false,
    expires_at: null,
    revoked_at: null,
    created_at: '2026-07-28T10:00:00.000Z',
    updated_at: '2026-07-28T10:00:00.000Z',
    ...overrides,
  };
}

describe('isShareLive', () => {
  test('a share with no expiry and no revocation is handing out access', () => {
    expect(isShareLive(share(), NOW)).toBe(true);
  });

  test('a revoked share is dead even if its expiry is still in the future', () => {
    const revoked = share({
      revoked_at: '2026-07-28T11:00:00.000Z',
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    expect(isShareLive(revoked, NOW)).toBe(false);
  });

  test('an expired share is dead without ever being revoked', () => {
    expect(isShareLive(share({ expires_at: '2026-07-28T11:59:59.000Z' }), NOW)).toBe(false);
  });

  test('a future expiry is still live', () => {
    expect(isShareLive(share({ expires_at: '2026-07-28T12:00:01.000Z' }), NOW)).toBe(true);
  });

  test('an unparseable expiry is treated as live, so a bad row is never a silent leak', () => {
    expect(isShareLive(share({ expires_at: 'not-a-date' }), NOW)).toBe(true);
  });
});

describe('publicSharesQueryKey', () => {
  test('is scoped to both workspace and session so two sessions never share a cache', () => {
    expect(publicSharesQueryKey('p1', 's1')).not.toEqual(publicSharesQueryKey('p1', 's2'));
    expect(publicSharesQueryKey('p1', 's1')).toEqual(publicSharesQueryKey('p1', 's1'));
  });
});

describe('shareListState', () => {
  test('loading wins while the request is in flight', () => {
    expect(shareListState({ isLoading: true, isError: false, count: 0 })).toBe('loading');
    expect(shareListState({ isLoading: true, isError: true, count: 5 })).toBe('loading');
  });

  test('a denied list reads as an error, never as "nothing shared"', () => {
    expect(shareListState({ isLoading: false, isError: true, count: 0 })).toBe('error');
  });

  test('empty only when the list genuinely came back empty', () => {
    expect(shareListState({ isLoading: false, isError: false, count: 0 })).toBe('empty');
  });

  test('any share renders the list', () => {
    expect(shareListState({ isLoading: false, isError: false, count: 1 })).toBe('list');
  });
});
