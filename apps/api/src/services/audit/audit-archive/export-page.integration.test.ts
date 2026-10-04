import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auditEventsAll } from '@kortix/db';
import { and, asc } from 'drizzle-orm';
import pg from 'pg';
import { type AuditFilterInput, buildFilters } from '../../../accounts/audit-filters';
import { parseAuditCursor } from '../audit-query';
import { db } from '../../../lib/db';
import { type ArchiveStore, runArchivePass } from './archive';
import { readExportPage } from './export-page';
import { weekStartOf } from './format';

const databaseUrl = process.env.TEST_DATABASE_URL;
const A = 'b9300000-0000-4000-a000-000000000001';
const B = 'b9300000-0000-4000-a000-000000000002';
const P1 = 'b9300000-0000-4000-a000-0000000000c1';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function fakeStore() {
  const objects = new Map<string, Buffer>();
  const store: ArchiveStore & { objects: Map<string, Buffer>; list(prefix: string): Promise<Array<{ key: string }>>; getBytes(key: string): Promise<Uint8Array | null> } = {
    objects,
    async putLocked(input) {
      if (objects.has(input.key)) return 'exists';
      objects.set(input.key, input.body);
      return 'created';
    },
    async checksum(key) {
      const body = objects.get(key);
      return body ? createHash('sha256').update(body).digest('base64') : null;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
    },
    async getBytes(key) {
      return objects.get(key) ?? null;
    },
  };
  return store;
}

let client: pg.Client | null = null;
const q = (text: string, values?: unknown[]) => client!.query(text, values);
const none: AuditFilterInput = { actor: null, actionPrefix: null, resourceType: null, sinceRaw: null, untilRaw: null, q: null };

async function pgIds(filters: Partial<AuditFilterInput>): Promise<string[]> {
  const rows = await db
    .select({ id: auditEventsAll.eventId })
    .from(auditEventsAll)
    .where(and(...buildFilters(A, { ...none, ...filters })))
    .orderBy(asc(auditEventsAll.occurredAt), asc(auditEventsAll.eventId));
  return rows.map((r) => r.id);
}

async function allPages(store: ReturnType<typeof fakeStore> | null, filters: Partial<AuditFilterInput>, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: ReturnType<typeof parseAuditCursor> = null;
  for (let page = 0; page < 100; page += 1) {
    const result = await readExportPage({ db, store }, { accountId: A, filters: { ...none, ...filters }, cursor, limit });
    ids.push(...result.rows.map((row) => row.eventId));
    if (!result.nextCursor) return ids;
    cursor = parseAuditCursor(result.nextCursor);
  }
  throw new Error('export did not terminate');
}

describe.skipIf(!databaseUrl)('export across the archive and PostgreSQL — real database, in-memory store', () => {
  const wOld1 = weekStartOf(new Date(Date.now() - 130 * DAY));
  const wOld2 = weekStartOf(new Date(Date.now() - 110 * DAY));
  const wKept = weekStartOf(new Date(Date.now() - 60 * DAY));
  const store = fakeStore();
  const FILTERS: Array<[string, Partial<AuditFilterInput>]> = [
    ['no filter', {}],
    ['action prefix', { actionPrefix: 'iam.group' }],
    ['plain action prefix', { actionPrefix: 'iam' }],
    ['connector. also matches computer.', { actionPrefix: 'connector.' }],
    ['project', { projectId: P1 }],
    ['outcome', { outcome: 'failure' }],
    ['resource type prefix', { resourceType: 'project' }],
    ['q wildcard', { q: 'res_%1' }],
    ['since inside the archive', { sinceRaw: daysAgo(125) }],
    ['until inside the archive', { untilRaw: daysAgo(112) }],
    ['since and until across the boundary', { sinceRaw: daysAgo(120), untilRaw: daysAgo(1.5) }],
  ];
  const expected = new Map<string, string[]>();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 140, 8)`);
    const ins = (account: string, action: string, at: string, extra: { project?: string; outcome?: string; resource?: string; type?: string } = {}) =>
      q(
        `INSERT INTO kortix.audit_events(account_id, action, resource_type, resource_id, project_id, outcome, authoritative_source, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'system', $7)`,
        [account, action, extra.type ?? 'test', extra.resource ?? null, extra.project ?? null, extra.outcome ?? 'success', at],
      );
    // Two rows in the same millisecond, microseconds apart: event ids need not follow microsecond order.
    await q(
      `INSERT INTO kortix.audit_events(event_id, account_id, action, resource_type, authoritative_source, occurred_at) VALUES
         ('00000000-0000-4000-8000-0000000000f9', $1, 'micro.second', 'test', 'system', $2::timestamptz + interval '900 microseconds'),
         ('00000000-0000-4000-8000-0000000000f1', $1, 'micro.first', 'test', 'system', $2::timestamptz + interval '100 microseconds')`,
      [A, daysAgo(130)],
    );
    for (let i = 0; i < 6; i += 1) await ins(A, i % 2 ? 'iam.group.create' : 'iam.role.update', daysAgo(129 - i / 10), { project: i % 3 ? P1 : undefined, outcome: i === 4 ? 'failure' : 'success', resource: `Res_ID-${i}`, type: 'project_session' });
    await ins(B, 'iam.group.create', daysAgo(129)); // another account: never exported to A
    for (let i = 0; i < 5; i += 1) await ins(A, i === 2 ? 'computer.shell' : 'connector.call', daysAgo(109 - i / 10));
    for (let i = 0; i < 4; i += 1) await ins(A, 'session.created', daysAgo(2 - i / 100), { project: P1 });
    await ins(A, 'iam.group.delete', daysAgo(1));
    // A week inside the hot window: PostgreSQL serves it.
    for (let i = 0; i < 3; i += 1) await ins(A, 'kept.in.postgres', daysAgo(60 - i / 10));
    for (const [name, filters] of FILTERS) expected.set(name, await pgIds(filters));
    expected.set('micro', await pgIds({ actionPrefix: 'micro.' }));
    expect(expected.get('no filter')!.length).toBe(2 + 6 + 5 + 4 + 1 + 3);
    // Archive and drop every week older than 90 days.
    const result = await runArchivePass({ db, store, mode: 'COMPLIANCE', rowsPerSecond: 1_000_000, batchRows: 4 }, Date.now() + 120_000);
    expect(result.archived).toEqual(expect.arrayContaining([wOld1, wOld2]));
    const removed = await q(`SELECT week_start::text AS w FROM kortix.audit_archive_chunks WHERE status = 'removed'`);
    expect(removed.rows.map((r) => r.w)).toEqual(expect.arrayContaining([wOld1, wOld2]));
    // A chunk marked archived whose partition is still attached (the state between export and
    // removal, or while the legacy table exists): its object must NOT be served, PostgreSQL is.
    await q(`INSERT INTO kortix.audit_archive_chunks(week_start, status) VALUES ($1, 'archived')`, [wKept]);
    const bogus = Buffer.from(`${JSON.stringify({ event_id: '00000000-0000-4000-8000-00000000bad1', account_id: A, action: 'kept.bogus', resource_type: 'test', occurred_at: `${wKept}T01:00:00.000000Z` })}\n`);
    store.objects.set(`audit/${A}/${wKept.slice(0, 4)}/${wKept}.000.jsonl.gz`, gzipSync(bogus));
  });

  afterAll(async () => {
    if (!client) return;
    await q(`SET kortix.audit_maintenance = 'on'`);
    await q(`DELETE FROM kortix.audit_events WHERE account_id = ANY($1::uuid[])`, [[A, B]]);
    await q(`DELETE FROM kortix.audit_archive_chunks`);
    await client.end();
  });

  test('the archived weeks are gone from PostgreSQL', async () => {
    const left = await q(`SELECT count(*)::int AS n FROM kortix.audit_events WHERE account_id = $1 AND occurred_at < now() - interval '105 days'`, [A]);
    expect(left.rows[0].n).toBe(0);
  });

  test.each(FILTERS)('%s: the export equals what PostgreSQL returned before the archive, in the same order', async (name, filters) => {
    expect(await allPages(store, filters, 1000)).toEqual(expected.get(name)!);
  });

  test('paging across the archive/PostgreSQL boundary at every page size has no gap and no repeat', async () => {
    for (const limit of [1, 2, 3, 5, 7]) expect(await allPages(store, {}, limit)).toEqual(expected.get('no filter')!);
  });

  test('two rows in one millisecond keep their microsecond order, one per page', async () => {
    const ids = await allPages(store, { actionPrefix: 'micro.' }, 1);
    expect(ids).toEqual(expected.get('micro')!);
    expect(ids).toEqual(['00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f9']);
  });

  test('a week still in PostgreSQL is served from PostgreSQL even when an archive object exists', async () => {
    const ids = await allPages(store, { actionPrefix: 'kept.' }, 1000);
    expect(ids).toHaveLength(3); // the three PostgreSQL rows; the bogus archive object is ignored
    expect(ids).not.toContain('00000000-0000-4000-8000-00000000bad1');
  });

  test('without a store the export is PostgreSQL only', async () => {
    const ids = await allPages(null, {}, 1000);
    expect(ids).toEqual(expected.get('no filter')!.slice(-8)); // 3 + 4 + 1 hot rows
  });
});
