import { describe, expect, mock, test } from 'bun:test';

// The pure helpers under test never query; the module only needs `db` to load.
mock.module('./db', () => ({ hasDatabase: true, db: {} }));

const {
  buildPublicShareInsert,
  isViewOnlyShare,
  publicShareToken,
  serializePublicShare,
  shareIdFromPublicRef,
  shareUnlocksTranscript,
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

describe('transcript share kind', () => {
  test('{ transcript: true } builds a view-only transcript share with no port or file', () => {
    const built = buildPublicShareInsert({ transcript: true }, CTX);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.values).toMatchObject({
      resourceType: 'transcript',
      label: 'Conversation',
      port: null,
      path: '/',
      filePath: null,
      mode: 'view',
      allowWebsocket: false,
      expiresAt: null,
    });
  });

  test('a transcript share keeps a caller label and expiry, and never becomes interactive', () => {
    const built = buildPublicShareInsert(
      { transcript: true, label: '  Launch plan  ', mode: 'interactive', expires_at: '2030-01-01T00:00:00.000Z' },
      CTX,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.values.label).toBe('Launch plan');
    expect(built.values.mode).toBe('view');
    expect(built.values.allowWebsocket).toBe(false);
    expect(built.values.expiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  test('a transcript share with an invalid expiry → 400', () => {
    const built = buildPublicShareInsert({ transcript: true, expires_at: 'not-a-date' }, CTX);
    expect(built).toEqual({ ok: false, status: 400, error: 'expires_at must be an ISO timestamp' });
  });

  test('a share names one resource: transcript plus a file or a preview → 400', () => {
    for (const extra of [{ file: { path: '/workspace/a.md' } }, { preview: { port: 3000 } }, { preview_id: 'web' }]) {
      const built = buildPublicShareInsert({ transcript: true, ...extra }, CTX);
      expect(built).toEqual({ ok: false, status: 400, error: 'A public share names one resource' });
    }
  });

  test('only the transcript kind unlocks the conversation', () => {
    expect(shareUnlocksTranscript({ resourceType: 'transcript' })).toBe(true);
    expect(shareUnlocksTranscript({ resourceType: 'preview' })).toBe(false);
    expect(shareUnlocksTranscript({ resourceType: 'file' })).toBe(false);
    expect(shareUnlocksTranscript({ resourceType: null })).toBe(false);
  });

  test('a transcript share is view-only whatever its stored mode says', () => {
    expect(isViewOnlyShare({ resourceType: 'transcript', mode: 'interactive' })).toBe(true);
  });

  test('a serialized transcript share opens at the web viewer and reads through the public messages route', () => {
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
