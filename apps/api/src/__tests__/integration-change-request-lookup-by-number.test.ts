/**
 * getCrById accepted the canonical UUID only. Any caller that passed the CR's
 * per-project display number — the number the web panel and the CLI print
 * ("CR #233") — reached Postgres with a non-UUID against the uuid column and
 * died on `invalid input syntax for type uuid: "233"`: a 500 + a Better Stack
 * page on the merge route (prod, 2026-10-18 05:20, POST
 * /v1/projects/.../change-requests/233/merge, twice 13 s apart). Every CR
 * route resolves its path param through this one function, so the fix (and
 * this suite) lives here, not per-route.
 *
 * Real-Postgres tenant contract — mirrors
 * integration-change-requests-list-filters.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, changeRequests, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { getCrById } from '../projects/change-requests';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'cr-lookup-by-number-test' });
  await db.insert(projects).values([
    {
      projectId: PROJECT,
      accountId: ACCOUNT,
      name: 'cr-lookup-by-number-test',
      repoUrl: 'https://example.test/cr-lookup.git',
    },
    {
      projectId: OTHER_PROJECT,
      accountId: ACCOUNT,
      name: 'cr-lookup-other-project-test',
      repoUrl: 'https://example.test/cr-lookup-other.git',
    },
  ]);
  await db.insert(changeRequests).values([
    {
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 233,
      title: 'The one with the number',
      baseRef: 'main',
      headRef: 'feature/by-number',
      status: 'open',
      createdBy: USER,
    },
  ]);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('getCrById resolves a uuid, a per-project number, or nothing', () => {
  test('the canonical uuid resolves', async () => {
    const [row] = await db
      .select({ crId: changeRequests.crId })
      .from(changeRequests)
      .where(eq(changeRequests.projectId, PROJECT));
    expect((await getCrById(row.crId, PROJECT))?.number).toBe(233);
  });

  test('the bare per-project number resolves (prod regression: it 500-ed)', async () => {
    expect((await getCrById('233', PROJECT))?.title).toBe('The one with the number');
  });

  test('the display form "#233" resolves too', async () => {
    expect((await getCrById('#233', PROJECT))?.number).toBe(233);
  });

  test('a number from another project resolves to nothing', async () => {
    expect(await getCrById('233', OTHER_PROJECT)).toBeNull();
  });

  test('a non-uuid, non-number id is a clean null (was the same uuid-cast 500)', async () => {
    expect(await getCrById('not-a-cr-id', PROJECT)).toBeNull();
    expect(await getCrById('233-extra', PROJECT)).toBeNull();
  });

  test('an unknown number is a clean null', async () => {
    expect(await getCrById('9999', PROJECT)).toBeNull();
  });
});
