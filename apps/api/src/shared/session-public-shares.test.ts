import { describe, expect, mock, test } from 'bun:test';

// The pure helpers under test never query; the module only needs `db` to load.
mock.module('./db', () => ({ hasDatabase: true, db: {} }));

const {
  buildPublicShareInsert,
  isViewOnlyShare,
  publicShareToken,
  serializePublicShare,
  shareIdFromPublicRef,
} = await import('./session-public-shares');
const { config } = await import('../config');

const CTX = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  accountId: '44444444-4444-4444-8444-444444444444',
  userId: '55555555-5555-4555-8555-555555555555',
};
const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'kps_11111111111141118111111111111111';

describe('transcript shares are removed (KRTX-2358)', () => {
  test('{ transcript: true } is refused with a named 400, whatever else the body carries', () => {
    for (const extra of [
      {},
      { label: '  Launch plan  ', mode: 'interactive', expires_at: '2030-01-01T00:00:00.000Z' },
      { file: { path: '/workspace/a.md' } },
      { preview: { port: 3000 } },
      { preview_id: 'web' },
    ]) {
      const built = buildPublicShareInsert({ transcript: true, ...extra }, CTX);
      expect(built).toEqual({ ok: false, status: 400, error: 'Transcript sharing is no longer available' });
    }
  });

  test('a legacy transcript share is view-only whatever its stored mode says', () => {
    expect(isViewOnlyShare({ resourceType: 'transcript', mode: 'interactive' })).toBe(true);
  });

  test('a serialized legacy transcript share keeps its historical viewer URL and messages path', () => {
    const now = new Date('2026-09-26T00:00:00.000Z');
    const share = serializePublicShare(
      {
        shareId: SHARE_ID,
        tokenHash: 'hash',
        sessionId: CTX.sessionId,
        projectId: CTX.projectId,
        accountId: CTX.accountId,
        createdBy: CTX.userId,
        resourceType: 'transcript',
        label: 'Conversation',
        port: null,
        path: '/',
        filePath: null,
        mode: 'view',
        allowWebsocket: false,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      undefined,
      null,
    );
    const frontend = config.FRONTEND_URL.replace(/\/+$/, '');
    expect(share.resource_type).toBe('transcript');
    expect(share.public_token).toBe(TOKEN);
    expect(share.public_path).toBe(`/share/session/${TOKEN}`);
    expect(share.public_url).toBe(`${frontend}/share/session/${TOKEN}`);
    expect(share.proxy_path).toBe(`/v1/public/session-shares/${TOKEN}/messages`);
  });
});

describe('shareIdFromPublicRef', () => {
  test('accepts the raw share id', () => {
    expect(shareIdFromPublicRef(SHARE_ID)).toBe(SHARE_ID);
  });

  test('accepts the kps_ public token and returns the share id it encodes', () => {
    expect(shareIdFromPublicRef(TOKEN)).toBe(SHARE_ID);
    expect(publicShareToken(shareIdFromPublicRef(TOKEN)!)).toBe(TOKEN);
  });

  test('rejects anything else', () => {
    for (const ref of ['', 'not-a-uuid', 'kps_', 'kps_xyz', `${TOKEN}0`, 'KPS_11111111111141118111111111111111']) {
      expect(shareIdFromPublicRef(ref)).toBeNull();
    }
  });
});
