import { expect, test } from 'bun:test';
import { accounts, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { adminProjectsSearchCondition } from './projects-search';

test('project email search scans users once instead of probing users per membership', async () => {
  await db.execute(sql`
    insert into auth.users (id, email)
    select md5('project-search-user-' || g)::uuid, 'project-search-' || g || '@example.test'
    from generate_series(1, 50000) g`);
  await db.execute(sql`
    insert into kortix.accounts (account_id, name)
    values ('b0000000-0000-4000-8000-000000000001', 'synthetic account')`);
  await db.execute(sql`
    insert into kortix.account_memberships (user_id, account_id)
    select md5('project-search-user-' || g)::uuid, 'b0000000-0000-4000-8000-000000000001'::uuid
    from generate_series(1, 5000) g`);
  await db.insert(projects).values({
    projectId: 'c0000000-0000-4000-8000-000000000001',
    accountId: 'b0000000-0000-4000-8000-000000000001',
    name: 'synthetic project', repoUrl: 'https://example.test/synthetic.git',
  });
  await db.execute(sql`analyze auth.users`);
  await db.execute(sql`analyze kortix.account_memberships`);
  await db.execute(sql`analyze kortix.accounts`);
  await db.execute(sql`analyze kortix.projects`);

  const condition = adminProjectsSearchCondition('a');
  const plan = await db.execute(sql`
    EXPLAIN SELECT ${projects.projectId} FROM ${projects}
    JOIN ${accounts} ON ${accounts.accountId} = ${projects.accountId}
    WHERE ${condition}`);
  const text = Array.from(plan, row => Object.values(row).join(' ')).join('\n');
  expect(text).toContain('Seq Scan on users');
  expect(text).toMatch(/Index Cond: \(user_id = /);
  expect(text).not.toContain('Index Cond: (id = ');

  for (const [search, expected] of [
    ['project-search-42@', 1], ['synthetic project', 1], ['synthetic account', 1],
    ['no-match', 0], ['%', 0], ['_', 0],
  ] as const) {
    const rows = await db.select({ id: projects.projectId }).from(projects)
      .innerJoin(accounts, eq(accounts.accountId, projects.accountId))
      .where(adminProjectsSearchCondition(search));
    expect(rows).toHaveLength(expected);
  }
});
