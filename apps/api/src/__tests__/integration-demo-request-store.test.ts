/**
 * Integration test (real local DB): POST /v1/system/demo-request persists the
 * submission into public.contact_forms. Proves the row actually lands — the
 * hermetic unit test (src/lib/demo-request-store.test.ts) only asserts the
 * statement the store issues.
 *
 * Runs against the local Postgres (DATABASE_URL). Creates the table in
 * beforeAll: it ships in packages/db/drizzle/0000_bootstrap.sql and exists on
 * every hosted/self-host deployment, but a long-lived local DB may predate it.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { recordDemoRequestSubmission } from '../lib/demo-request-store';

const MARKER = `ke2e-store-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.execute(sql`create table if not exists public.contact_forms (
    id uuid default gen_random_uuid() not null primary key,
    created_at timestamp with time zone default now() not null,
    data jsonb default '{}'::jsonb not null
  )`);
});

afterAll(async () => {
  await db.execute(sql`delete from public.contact_forms where data->>'source' = ${MARKER}`);
});

describe('demo-request → public.contact_forms (real DB)', () => {
  test('stores the whole submission verbatim, unknown keys included', async () => {
    const ok = await recordDemoRequestSubmission({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company_name: 'Analytical Engines',
      company_size: '51-200',
      goal: 'automate inbound triage',
      qualified: true,
      source: MARKER,
      form: MARKER,
      user_agent: 'Mozilla/5.0 (integration probe)',
      // A key no column knows about — the careers form adds these.
      opening: 'Founding engineer',
    });
    expect(ok).toBe(true);

    const rows = (await db.execute(
      sql`select data from public.contact_forms where data->>'source' = ${MARKER}`,
    )) as unknown as Array<{ data: Record<string, unknown> }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company_name: 'Analytical Engines',
      company_size: '51-200',
      goal: 'automate inbound triage',
      qualified: true,
      source: MARKER,
      form: MARKER,
      user_agent: 'Mozilla/5.0 (integration probe)',
      opening: 'Founding engineer',
    });
  });
});
