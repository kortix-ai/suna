import { describe, expect, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { qualifiedColumn } from './sql-qualified-column';

const db = drizzle({} as never);

describe('qualifiedColumn', () => {
  test('renders schema, table and column even inside a single-table selection', () => {
    const sessionCount = sql<number>`(
      select count(*)::int from ${projectSessions} ps where ps.project_id = ${qualifiedColumn(projects.projectId)})`;
    const rendered = db
      .select({ projectId: projects.projectId, sessionCount })
      .from(projects)
      .toSQL().sql;

    expect(rendered).toContain('ps.project_id = "kortix"."projects"."project_id"');
  });

  test('the bare column in the same position is what collapses — the bug this helper exists for', () => {
    const sessionCount = sql<number>`(
      select count(*)::int from ${projectSessions} ps where ps.project_id = ${projects.projectId})`;
    const rendered = db
      .select({ projectId: projects.projectId, sessionCount })
      .from(projects)
      .toSQL().sql;

    expect(rendered).toContain('ps.project_id = "project_id"');
  });
});
