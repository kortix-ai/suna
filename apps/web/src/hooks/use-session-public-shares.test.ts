import type { SessionPublicShare } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  findLiveShareFor,
  findLiveSharesFor,
  isShareLive,
  publicSharesQueryKey,
  publicShareUrl,
  shareListState,
} from './use-session-public-shares';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function share(overrides: Partial<SessionPublicShare> = {}): SessionPublicShare {
  return {
    share_id: 'sh1',
    session_id: 's1',
    project_id: 'p1',
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
  test('is scoped to both project and session so two sessions never share a cache', () => {
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

describe('publicShareUrl', () => {
  test('joins the web origin and the share page path', () => {
    expect(publicShareUrl('/share/session/kps_abc', 'https://app.example.test')).toBe(
      'https://app.example.test/share/session/kps_abc',
    );
  });

  test('is null without a path or an origin', () => {
    expect(publicShareUrl(null, 'https://app.example.test')).toBeNull();
    expect(publicShareUrl('', 'https://app.example.test')).toBeNull();
    expect(publicShareUrl('/share/session/kps_abc', null)).toBeNull();
  });

  test('defaults to no origin outside a browser, so a server render never builds a link', () => {
    expect(typeof window).toBe('undefined');
    expect(publicShareUrl('/share/session/kps_abc')).toBeNull();
  });
});

describe('findLiveShareFor — reuse the link that already exists', () => {
  const file = (path: string) => ({ mode: 'view' as const, file: { label: 'x', path } });

  test('a live file share matches by its stored /workspace path', () => {
    const live = share({ share_id: 'f1', resource_type: 'file', file_path: '/workspace/src/a.md' });
    expect(findLiveShareFor([live], file('/workspace/src/a.md'), NOW)?.share_id).toBe('f1');
    expect(findLiveShareFor([live], file('src/a.md'), NOW)?.share_id).toBe('f1');
  });

  test('a revoked or expired share is not reused', () => {
    const revoked = share({ file_path: '/workspace/a.md', revoked_at: '2026-07-01T00:00:00.000Z' });
    const expired = share({ file_path: '/workspace/a.md', expires_at: '2026-07-01T00:00:00.000Z' });
    expect(findLiveShareFor([revoked, expired], file('/workspace/a.md'), NOW)).toBeNull();
  });

  test('another file does not match', () => {
    const live = share({ file_path: '/workspace/a.md' });
    expect(findLiveShareFor([live], file('/workspace/b.md'), NOW)).toBeNull();
  });

  test('a preview matches on port and path', () => {
    const live = share({ share_id: 'p1', resource_type: 'preview', file_path: null, port: 3000, path: '/app' });
    const input = (port: number, path: string) => ({
      mode: 'view' as const,
      preview: { label: 'x', url: '', port, path },
    });
    expect(findLiveShareFor([live], input(3000, '/app'), NOW)?.share_id).toBe('p1');
    expect(findLiveShareFor([live], input(3000, '/'), NOW)).toBeNull();
    expect(findLiveShareFor([live], input(5000, '/app'), NOW)).toBeNull();
  });

  test('no input, no match', () => {
    expect(findLiveShareFor([share()], null, NOW)).toBeNull();
  });
});

describe('findLiveSharesFor — every live link to one target', () => {
  test('returns all live links to the file, newest first, skipping revoked ones', () => {
    const shares = [
      share({ share_id: 'new', file_path: '/workspace/a.png', created_at: '2026-07-28T10:00:00.000Z' }),
      share({ share_id: 'mid', file_path: '/workspace/a.png', created_at: '2026-07-28T09:00:00.000Z' }),
      share({ share_id: 'gone', file_path: '/workspace/a.png', revoked_at: '2026-07-28T09:30:00.000Z' }),
      share({ share_id: 'other', file_path: '/workspace/b.png' }),
    ];
    const input = { mode: 'view' as const, file: { label: 'a', path: '/workspace/a.png' } };
    expect(findLiveSharesFor(shares, input, NOW).map((s) => s.share_id)).toEqual(['new', 'mid']);
    expect(findLiveShareFor(shares, input, NOW)?.share_id).toBe('new');
  });
});
