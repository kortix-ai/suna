/**
 * `GET /v1/projects/:projectId/starter-suggestions` — HTTP-level test against
 * the REAL in-process `app` (real local Postgres + real local Supabase auth),
 * no `mock.module`.
 *
 * Contract (task-5 brief):
 *   - unauthenticated → 401 (the global `supabaseAuth` middleware, not this route)
 *   - fresh project (no cache) → `source: 'static'`, the 6 `STARTER_PROMPT_FALLBACKS`
 *   - a valid cache in `projects.metadata.starter_suggestions` → `source: 'personalized'`,
 *     echoing back its `generated_at` and `items` verbatim
 *   - a cache older than the 24h TTL still answers from the SAME cached items —
 *     staleness only decides whether a regeneration is fired in the background,
 *     never what the route answers with.
 *   - v1.3: a cached connector item whose app is already connected is dropped
 *     from the response — the serve-time connected filter.
 *
 * Harness: the `describeWithDb` real-Postgres gate from
 * `../lib/project-registration.icon.integration.test.ts` /
 * `../../__tests__/e2e-stuck-session-reconcile.test.ts`, combined with the
 * real-`app` + real-Supabase-JWT HTTP flow from
 * `../../__tests__/integration-approvals.test.ts`. Skipped unless
 * TEST_DATABASE_URL + KORTIX_TEST_DB_CONFIRM are explicitly set (never runs
 * against a hermetic/CI default env) — it writes and deletes real rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';
import {
  type Database,
  accountMembers,
  accounts,
  connectorConnections,
  connectors,
  createDb,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === TEST_DB_CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
let userId = '';
let token = '';

let testDb: Database | null = null;
function db(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!testDb) testDb = createDb(url, { max: 4 });
  return testDb;
}

async function seedCache(
  items: Array<{
    id: string;
    label: string;
    prompt: string;
    action?: string;
    connector?: { slug: string; name: string; img_src: string | null };
  }>,
  generatedAt: string,
) {
  const { metadataMergeSubtree } = await import('../lib/metadata-merge');
  await db()
    .update(projects)
    .set({
      metadata: metadataMergeSubtree('starter_suggestions', {
        generated_at: generatedAt,
        model: 'test-model',
        items,
      }),
    })
    .where(eq(projects.projectId, PROJECT_ID));
}

/** Seeds one active `provider_type = 'pipedream'` connector connection for
 *  `PROJECT_ID`, with `config.app = appSlug` — the real column the route's
 *  `readConnectedConnectors` reads to identify a connected app by slug (see
 *  `signals.ts`'s `connectorAppSlug`). Returns a cleanup callback. */
async function seedConnectedConnector(appSlug: string, name: string): Promise<() => Promise<void>> {
  const [connector] = await db()
    .insert(connectors)
    .values({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: appSlug,
      name,
      providerType: 'pipedream',
      config: { app: appSlug },
    })
    .returning({ connectorId: connectors.connectorId });
  const connectorId = connector!.connectorId;
  await db().insert(connectorConnections).values({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    connectorId,
    label: 'default',
    status: 'active',
  });
  return async () => {
    await db().delete(connectorConnections).where(eq(connectorConnections.connectorId, connectorId));
    await db().delete(connectors).where(eq(connectors.connectorId, connectorId));
  };
}

describeWithDb('GET /v1/projects/:projectId/starter-suggestions — real Postgres + real Supabase auth', () => {
  beforeAll(async () => {
    const { config } = await import('../../config');
    await db().insert(accounts).values({ accountId: ACCOUNT_ID, name: 'starter-suggestions-test' });
    await db().insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'starter-suggestions-test',
      repoUrl: 'https://example.test/starter-suggestions-test.git',
    });

    const email = `starter-suggestions-${crypto.randomUUID()}@example.test`;
    const password = `Starter-${crypto.randomUUID()}-aA1!`;
    const created = await fetch(`${config.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { id?: string; user?: { id?: string } };
    userId = createdBody.user?.id ?? createdBody.id ?? '';
    expect(userId).not.toBe('');

    await db().insert(accountMembers).values({ accountId: ACCOUNT_ID, userId, accountRole: 'owner' });

    const signedIn = await fetch(`${config.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: config.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(signedIn.status).toBe(200);
    token = ((await signedIn.json()) as { access_token?: string }).access_token ?? '';
    expect(token).not.toBe('');
  }, 30_000);

  afterAll(async () => {
    const { config } = await import('../../config');
    await db().delete(accountMembers).where(eq(accountMembers.accountId, ACCOUNT_ID));
    await db().delete(projects).where(eq(projects.projectId, PROJECT_ID));
    await db().delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
    if (userId) {
      await fetch(`${config.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: config.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
    }
  }, 30_000);

  async function get(bearer?: string) {
    const { app } = await import('../../index');
    return app.request(`/v1/projects/${PROJECT_ID}/starter-suggestions`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
  }

  test('unauthenticated request is rejected before it reaches the route', async () => {
    const r = await get();
    expect(r.status).toBe(401);
  });

  test('fresh project (no cache) answers with the static fallback pool', async () => {
    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('static');
    expect(body.generated_at).toBeNull();
    expect(body.items).toHaveLength(6);
    expect(body.items).toEqual(
      STARTER_PROMPT_FALLBACKS.map(({ id, label, prompt }) => ({ id, label, prompt })),
    );
    for (const item of body.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('action');
      expect(item).not.toHaveProperty('connector');
    }
  });

  test('a fresh cache answers personalized, echoing generated_at and items', async () => {
    const generatedAt = new Date().toISOString();
    const items = [{ id: 'x', label: 'Do X', prompt: 'Please do X for me in detail.' }];
    await seedCache(items, generatedAt);

    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('personalized');
    expect(body.generated_at).toBe(generatedAt);
    expect(body.items).toEqual(items);
  });

  test('a cached item carrying an action round-trips it verbatim', async () => {
    const generatedAt = new Date().toISOString();
    const items = [
      { id: 'z', label: 'Connect Slack', prompt: 'Connect Slack to post daily updates.', action: 'connectors' },
    ];
    await seedCache(items, generatedAt);

    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('personalized');
    expect(body.generated_at).toBe(generatedAt);
    expect(body.items).toEqual(items);
  });

  test('a cached item carrying an enriched connector round-trips it verbatim', async () => {
    const generatedAt = new Date().toISOString();
    const items = [
      {
        id: 'w',
        label: 'Connect Slack',
        prompt: 'Connect Slack to post daily standup updates.',
        action: 'connectors',
        connector: { slug: 'slack', name: 'Slack', img_src: 'https://example.test/slack.png' },
      },
    ];
    await seedCache(items, generatedAt);

    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('personalized');
    expect(body.generated_at).toBe(generatedAt);
    expect(body.items).toEqual(items);
  });

  test('a 25h-stale cache still answers from the same cached items, instantly', async () => {
    const staleGeneratedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const items = [{ id: 'y', label: 'Do Y', prompt: 'Please do Y for me in detail.' }];
    await seedCache(items, staleGeneratedAt);

    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('personalized');
    expect(body.generated_at).toBe(staleGeneratedAt);
    expect(body.items).toEqual(items);
  });

  test('a cached connector item whose app is already connected is dropped from the response', async () => {
    const cleanup = await seedConnectedConnector('slack', 'Slack');
    try {
      const generatedAt = new Date().toISOString();
      const items = [
        {
          id: 'slack-item',
          label: 'Connect Slack',
          prompt: 'Connect Slack to post daily updates.',
          action: 'connectors',
          connector: { slug: 'slack', name: 'Slack', img_src: null },
        },
        {
          id: 'notion-item',
          label: 'Connect Notion',
          prompt: 'Connect Notion to sync your docs.',
          action: 'connectors',
          connector: { slug: 'notion', name: 'Notion', img_src: null },
        },
      ];
      await seedCache(items, generatedAt);

      const r = await get(token);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
      expect(body.source).toBe('personalized');
      expect(body.items).toEqual([items[1]]);
    } finally {
      await cleanup();
    }
  });

  test('a cached connector item survives unfiltered when nothing is connected', async () => {
    const generatedAt = new Date().toISOString();
    const items = [
      {
        id: 'linear-item',
        label: 'Connect Linear',
        prompt: 'Connect Linear to triage issues.',
        action: 'connectors',
        connector: { slug: 'linear', name: 'Linear', img_src: null },
      },
    ];
    await seedCache(items, generatedAt);

    const r = await get(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: string; generated_at: string | null; items: unknown[] };
    expect(body.source).toBe('personalized');
    expect(body.items).toEqual(items);
  });
});
