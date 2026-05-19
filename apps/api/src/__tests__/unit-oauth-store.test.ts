/**
 * Unit tests for the OAuth credential store + OPENCODE_AUTH_CONTENT builder.
 *
 * Exercises the storage round-trip (encrypt → persist → decrypt), refresh
 * behavior (skip-fresh / skip-copilot / actually-refresh-openai), and the
 * shape opencode expects to find in `OPENCODE_AUTH_CONTENT`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectOauthCredentials } from '@kortix/db';

const PROJECT_ID = '00000000-0000-4000-a000-000000000a01';

let credentialRows: Array<typeof projectOauthCredentials.$inferSelect>;
let lastUpsertValues: Record<string, unknown> | null = null;

function resetState() {
  credentialRows = [];
  lastUpsertValues = null;
}

mock.module('../config', () => ({
  config: {
    API_KEY_SECRET: 'unit-oauth-store-test-secret',
  },
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
            Promise.resolve(table === projectOauthCredentials ? credentialRows : []).then(resolve, reject);
          },
          limit: async () => {
            if (table !== projectOauthCredentials) return [];
            return credentialRows;
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            if (table !== projectOauthCredentials) return [];
            lastUpsertValues = { ...values, ...set };
            const now = new Date('2026-05-18T00:00:00Z');
            const existingIdx = credentialRows.findIndex(
              (r) => r.projectId === values.projectId && r.providerId === values.providerId,
            );
            const row: typeof projectOauthCredentials.$inferSelect = {
              credentialId: existingIdx >= 0
                ? credentialRows[existingIdx]!.credentialId
                : '00000000-0000-4000-a000-000000000c01',
              projectId: values.projectId as string,
              providerId: values.providerId as string,
              refreshEnc: (set.refreshEnc ?? values.refreshEnc) as string,
              accessEnc: (set.accessEnc ?? values.accessEnc) as string,
              expires: Number((set.expires ?? values.expires)),
              accountId: (set.accountId ?? values.accountId) as string | null,
              enterpriseUrl: (set.enterpriseUrl ?? values.enterpriseUrl) as string | null,
              createdBy: (values.createdBy as string | null) ?? null,
              createdAt: existingIdx >= 0 ? credentialRows[existingIdx]!.createdAt : now,
              updatedAt: (set.updatedAt as Date) ?? now,
            };
            if (existingIdx >= 0) credentialRows[existingIdx] = row;
            else credentialRows.push(row);
            return [row];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectOauthCredentials) credentialRows = [];
      },
    }),
  },
}));

// Track every fetch call so we can assert which refresh paths actually hit
// the network (and which short-circuit).
type FetchCall = { url: string; init: RequestInit | undefined };
const calls: FetchCall[] = [];
const responders: Array<(url: string, init?: RequestInit) => Response | null> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetState();
  calls.length = 0;
  responders.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const r of responders) {
      const out = r(url, init);
      if (out) return out;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Lazy-load: the module pulls in mocked db/config so it must be imported
// after the mock.module calls above.
const {
  buildOpencodeAuthContent,
  deleteOauthCredential,
  getOauthCredential,
  listOauthCredentials,
  refreshIfExpiring,
  summarizeCredential,
  upsertOauthCredential,
  isSupportedOauthProvider,
} = await import('../projects/oauth');

describe('isSupportedOauthProvider', () => {
  test('accepts openai and github-copilot only', () => {
    expect(isSupportedOauthProvider('openai')).toBe(true);
    expect(isSupportedOauthProvider('github-copilot')).toBe(true);
    expect(isSupportedOauthProvider('anthropic')).toBe(false);
    expect(isSupportedOauthProvider('')).toBe(false);
  });
});

describe('upsert + list + delete', () => {
  test('encrypts at rest — neither refresh nor access plaintext appears in the row', async () => {
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'refresh-secret-xyz',
      access: 'access-secret-abc',
      expires: Date.now() + 3600_000,
      accountId: 'org-1',
    });

    expect(credentialRows).toHaveLength(1);
    expect(credentialRows[0].refreshEnc).not.toContain('refresh-secret-xyz');
    expect(credentialRows[0].accessEnc).not.toContain('access-secret-abc');
    expect(credentialRows[0].accountId).toBe('org-1');
  });

  test('round-trips: list decrypts back to the original tokens', async () => {
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'refresh-1',
      access: 'access-1',
      expires: Date.now() + 3600_000,
    });
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'github-copilot',
      refresh: 'gho_copilot',
      access: 'gho_copilot',
      expires: 0,
      enterpriseUrl: 'company.ghe.com',
    });

    const all = await listOauthCredentials(PROJECT_ID);
    expect(all).toHaveLength(2);
    const openai = all.find((c) => c.providerId === 'openai');
    const copilot = all.find((c) => c.providerId === 'github-copilot');
    expect(openai?.refresh).toBe('refresh-1');
    expect(openai?.access).toBe('access-1');
    expect(copilot?.refresh).toBe('gho_copilot');
    expect(copilot?.enterpriseUrl).toBe('company.ghe.com');
  });

  test('upsert with same project + provider overwrites', async () => {
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r1',
      access: 'a1',
      expires: 100,
    });
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r2',
      access: 'a2',
      expires: 200,
      accountId: 'org-new',
    });
    expect(credentialRows).toHaveLength(1);
    const rec = await getOauthCredential(PROJECT_ID, 'openai');
    expect(rec?.refresh).toBe('r2');
    expect(rec?.access).toBe('a2');
    expect(rec?.accountId).toBe('org-new');
  });

  test('delete clears credentials', async () => {
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r',
      access: 'a',
      expires: 100,
    });
    await deleteOauthCredential(PROJECT_ID, 'openai');
    expect(credentialRows).toHaveLength(0);
  });
});

describe('summarizeCredential', () => {
  test('reports null expires_in_ms for non-expiring credentials', async () => {
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'github-copilot',
      refresh: 'gho_x',
      access: 'gho_x',
      expires: 0,
    });
    const summary = summarizeCredential(cred);
    expect(summary.expires_in_ms).toBeNull();
    expect(summary.provider_id).toBe('github-copilot');
  });

  test('reports time-to-expiry for OpenAI', async () => {
    const expiresAt = Date.now() + 60_000;
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r',
      access: 'a',
      expires: expiresAt,
    });
    const summary = summarizeCredential(cred);
    expect(summary.expires_in_ms).toBeGreaterThan(50_000);
    expect(summary.expires_in_ms).toBeLessThanOrEqual(60_000);
  });
});

describe('refreshIfExpiring', () => {
  test('skips github-copilot regardless of expiry', async () => {
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'github-copilot',
      refresh: 'gho_x',
      access: 'gho_x',
      expires: 0,
    });
    const result = await refreshIfExpiring(cred, PROJECT_ID);
    expect(result).toBe(cred);
    expect(calls).toHaveLength(0);
  });

  test('skips openai when access token is still fresh', async () => {
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r',
      access: 'a',
      // 1 hour out → comfortably past the 5-min refresh lead.
      expires: Date.now() + 3600_000,
    });
    const result = await refreshIfExpiring(cred, PROJECT_ID);
    expect(result).toBe(cred);
    expect(calls).toHaveLength(0);
  });

  test('refreshes openai when token expires inside the lead window', async () => {
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r-old',
      access: 'a-old',
      // 1 minute out → inside the 5-min refresh lead.
      expires: Date.now() + 60_000,
      accountId: 'org-1',
    });

    responders.push((url) => {
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'a-new',
            refresh_token: 'r-new',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return null;
    });

    const result = await refreshIfExpiring(cred, PROJECT_ID);
    expect(result.access).toBe('a-new');
    expect(result.refresh).toBe('r-new');
    expect(result.accountId).toBe('org-1'); // accountId is preserved across refresh
    expect(result.expires).toBeGreaterThan(Date.now() + 3000_000);

    // Verify the refresh body
    const body = new URLSearchParams(calls[0].init?.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('r-old');
  });

  test('returns the stale record when upstream refresh fails (sandbox surfaces the auth error)', async () => {
    const cred = await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r-stale',
      access: 'a-stale',
      expires: Date.now() + 60_000,
    });
    responders.push(() => new Response('', { status: 401 }));
    const result = await refreshIfExpiring(cred, PROJECT_ID);
    // Stale tokens are returned as-is — refusing here would make the entire
    // session-create flow fail; better to let opencode surface the real
    // upstream auth error.
    expect(result.access).toBe('a-stale');
    expect(result.refresh).toBe('r-stale');
  });
});

describe('buildOpencodeAuthContent', () => {
  test('returns null when the project has no OAuth credentials', async () => {
    const content = await buildOpencodeAuthContent(PROJECT_ID);
    expect(content).toBeNull();
  });

  test('emits the exact shape opencode\'s auth schema expects', async () => {
    const futureExpires = Date.now() + 3600_000;
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'openai-refresh',
      access: 'openai-access',
      expires: futureExpires,
      accountId: 'org-1',
    });
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'github-copilot',
      refresh: 'gho_pat',
      access: 'gho_pat',
      expires: 0,
    });

    const content = await buildOpencodeAuthContent(PROJECT_ID);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content!) as Record<string, Record<string, unknown>>;

    // OpenAI entry
    expect(parsed.openai).toEqual({
      type: 'oauth',
      refresh: 'openai-refresh',
      access: 'openai-access',
      expires: futureExpires,
      accountId: 'org-1',
    });

    // GitHub Copilot entry — no accountId, no enterpriseUrl
    expect(parsed['github-copilot']).toEqual({
      type: 'oauth',
      refresh: 'gho_pat',
      access: 'gho_pat',
      expires: 0,
    });
  });

  test('refreshes expiring tokens as a side-effect before emitting content', async () => {
    await upsertOauthCredential({
      projectId: PROJECT_ID,
      providerId: 'openai',
      refresh: 'r-old',
      access: 'a-old',
      expires: Date.now() + 60_000, // inside refresh lead
    });

    responders.push((url) => {
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(
          JSON.stringify({ access_token: 'a-new', refresh_token: 'r-new', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return null;
    });

    const content = await buildOpencodeAuthContent(PROJECT_ID);
    const parsed = JSON.parse(content!) as Record<string, Record<string, unknown>>;
    expect(parsed.openai.access).toBe('a-new');
    expect(parsed.openai.refresh).toBe('r-new');
    // ...and the new tokens are persisted (so the next boot doesn't have to
    // re-refresh).
    const stored = await getOauthCredential(PROJECT_ID, 'openai');
    expect(stored?.access).toBe('a-new');
  });
});
