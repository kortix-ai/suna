import { describe, expect, mock, test } from 'bun:test';

// The helpers under test never query except `existsPublicShare`, which gets a
// `db` stub of its own below.
mock.module('./db', () => ({ hasDatabase: true, db: {} }));

const {
  buildPublicShareInsert,
  existsPublicShare,
  isViewOnlyShare,
  publicShareToken,
  publicShareTokenHash,
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

  test('truthy legacy transcript fields cannot become preview shares', () => {
    for (const transcript of ['true', 1, {}, []]) {
      expect(buildPublicShareInsert({ transcript, preview: { port: 3000 } }, CTX)).toEqual({
        ok: false, status: 400, error: 'Transcript sharing is no longer available',
      });
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
        messageId: null,
        snapshot: null,
        snapshotAt: null,
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

describe('existsPublicShare', () => {
  test('answers the share id of a stored token, asks once per token, and null for a token of no row', async () => {
    const db: { select?: unknown } = await import('./db').then((module) => module.db as { select?: unknown });
    const known: Record<string, string> = { [publicShareTokenHash(TOKEN)]: SHARE_ID };
    const asked: string[] = [];
    // The chain the helper uses: select().from().where(cond).limit(1).
    db.select = () => ({
      from: () => ({
        where: (cond: { queryChunks: Array<{ value?: unknown }> }) => {
          // The token hash is the `Param` chunk of the `token_hash` equality.
          const tokenHash = cond.queryChunks.map((chunk) => chunk.value).find((value) => typeof value === 'string');
          asked.push(String(tokenHash));
          const shareId = known[String(tokenHash)];
          return { limit: async () => (shareId ? [{ shareId }] : []) };
        },
      }),
    });

    expect(await existsPublicShare(TOKEN)).toBe(SHARE_ID);
    expect(await existsPublicShare(TOKEN)).toBe(SHARE_ID);
    expect(await existsPublicShare(TOKEN)).toBe(SHARE_ID);
    // A verified token is cached: a popular link asks once for three views.
    expect(asked).toHaveLength(1);

    const invented = publicShareToken('99999999-9999-4999-8999-999999999999');
    expect(await existsPublicShare(invented)).toBeNull();
    expect(await existsPublicShare(invented)).toBeNull();
    expect(asked).toHaveLength(3);
  });
});
