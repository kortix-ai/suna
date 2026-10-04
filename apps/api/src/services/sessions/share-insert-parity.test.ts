import { expect, mock, test } from 'bun:test';
import type { PublicShareRow, PublicShareInput } from './session-public-shares';
type Insert = typeof import('@kortix/db').projectSessionPublicShares.$inferInsert;
const inserted: Insert[] = [];
const rows: PublicShareRow[] = [];
let locks = 0;
const collaborator = {
  execute: async () => {
    locks++;
  },
  select: (fields?: unknown) => ({
    from: () => ({
      where: () => ({ orderBy: () => ({ limit: async () => (fields ? [] : rows) }) }),
    }),
  }),
  insert: () => ({
    values: (value: Insert) => ({
      returning: async () => {
        if (!value.shareId) throw new Error('Missing shareId');
        inserted.push(value);
        const row: PublicShareRow = {
          shareId: value.shareId,
          tokenHash: value.tokenHash,
          sessionId: value.sessionId,
          projectId: value.projectId,
          accountId: value.accountId,
          createdBy: value.createdBy ?? null,
          resourceType: value.resourceType ?? 'preview',
          label: value.label ?? 'App preview',
          port: value.port ?? null,
          path: value.path ?? '/',
          filePath: value.filePath ?? null,
          mode: value.mode ?? 'view',
          allowWebsocket: value.allowWebsocket ?? false,
          expiresAt: value.expiresAt ?? null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        rows.push(row);
        return [row];
      },
    }),
  }),
};
mock.module('../../lib/db', () => ({
  db: {
    ...collaborator,
    transaction: async <T>(run: (tx: typeof collaborator) => Promise<T>) => run(collaborator),
  },
}));
const { createPublicShare, publicShareToken, publicShareTokenHash } = await import(
  './session-public-shares'
);
const ctx = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  accountId: '44444444-4444-4444-8444-444444444444',
  userId: '55555555-5555-4555-8555-555555555555',
};
const cases: {
  input: PublicShareInput;
  resourceType: string;
  port: number | null;
  filePath: string | null;
  mode: string;
  allowWebsocket: boolean;
}[] = [
  {
    input: { preview: { port: 5173, path: '/app' }, mode: 'interactive' },
    resourceType: 'preview',
    port: 5173,
    filePath: null,
    mode: 'interactive',
    allowWebsocket: true,
  },
  {
    input: { file: { path: '/workspace/plan.md' } },
    resourceType: 'file',
    port: null,
    filePath: '/workspace/plan.md',
    mode: 'view',
    allowWebsocket: false,
  },
  {
    input: { transcript: true },
    resourceType: 'transcript',
    port: null,
    filePath: null,
    mode: 'view',
    allowWebsocket: false,
  },
];
for (const item of cases)
  test(`${item.resourceType}: exact insert projection and token`, async () => {
    rows.length = 0;
    inserted.length = 0;
    locks = 0;
    const result = await createPublicShare(
      { ...item.input, label: 'Synthetic label', expires_at: '2030-01-01T00:00:00.000Z' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const shareId = result.share.share_id;
    expect(inserted).toEqual([
      {
        shareId,
        tokenHash: publicShareTokenHash(publicShareToken(shareId)),
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        accountId: ctx.accountId,
        createdBy: ctx.userId,
        resourceType: item.resourceType,
        label: 'Synthetic label',
        port: item.port,
        path: item.resourceType === 'preview' ? '/app' : '/',
        filePath: item.filePath,
        mode: item.mode,
        allowWebsocket: item.allowWebsocket,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
    expect(result.share.public_token).toBe(publicShareToken(shareId));
    expect(locks).toBe(item.resourceType === 'transcript' ? 1 : 0);
    if (item.resourceType === 'transcript') {
      const repeat = await createPublicShare({ transcript: true }, ctx);
      expect(repeat.ok).toBe(true);
      if (!repeat.ok) throw new Error(repeat.error);
      expect(repeat.created).toBe(false);
      expect(repeat.share.public_token).toBe(result.share.public_token);
      expect(inserted).toHaveLength(1);
      expect(locks).toBe(2);
    }
  });
