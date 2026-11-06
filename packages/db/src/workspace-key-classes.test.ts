/**
 * Every kortix table with `account_id` or `project_id` is in exactly one
 * workspace key class, and its columns agree with the class. A new table
 * fails here until it is classified (design.md §6.2).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import * as kortix from './schema/kortix';
import { WORKSPACE_KEY_CLASSES, workspaceKeyClassOf, type WorkspaceKeyClass } from './workspace-key-classes';

interface Shape {
  account: boolean;
  project: boolean;
  projectNotNull: boolean;
  workspaceId: boolean;
}

const shapes = new Map<string, Shape>();
for (const value of Object.values(kortix)) {
  if (!is(value, PgTable)) continue;
  const config = getTableConfig(value as PgTable);
  if (config.schema !== 'kortix') continue;
  const columns = new Map(config.columns.map((column) => [column.name, column]));
  shapes.set(config.name, {
    account: columns.has('account_id'),
    project: columns.has('project_id'),
    projectNotNull: Boolean(columns.get('project_id')?.notNull),
    workspaceId: columns.has('workspace_id'),
  });
}

const keyed = [...shapes].filter(([, s]) => s.account || s.project).map(([name]) => name).sort();

describe('workspace key classes', () => {
  test('every table with account_id or project_id is classified', () => {
    expect(keyed.filter((name) => workspaceKeyClassOf(name) === null)).toEqual([]);
  });

  test('no table is in two classes, and every classified table exists', () => {
    const all = Object.values(WORKSPACE_KEY_CLASSES).flat() as string[];
    expect(all.filter((name, i) => all.indexOf(name) !== i)).toEqual([]);
    expect(all.filter((name) => !shapes.has(name))).toEqual([]);
  });

  test("each table's columns agree with its class", () => {
    const wrong: string[] = [];
    const rule: Record<Exclude<WorkspaceKeyClass, 'core' | 'ledger'>, (s: Shape) => boolean> = {
      expand: (s) => s.account && !s.project && s.workspaceId,
      excluded: (s) => s.account && !s.project,
      workspace_owned: (s) => s.account && s.project && s.projectNotNull,
      workspace_owned_nullable: (s) => s.account && s.project && !s.projectNotNull,
      project_only: (s) => !s.account && s.project,
    };
    for (const [klass, check] of Object.entries(rule)) {
      for (const name of WORKSPACE_KEY_CLASSES[klass as keyof typeof rule]) {
        if (!check(shapes.get(name)!)) wrong.push(`${klass}:${name}`);
      }
    }
    for (const name of WORKSPACE_KEY_CLASSES.ledger) if (!shapes.get(name)!.account) wrong.push(`ledger:${name}`);
    expect(wrong).toEqual([]);
  });

  test('the expand class is the list kortix.workspace_expand_tables() returns (M4) and M7 alters', () => {
    const migrations = resolve(import.meta.dir, '..', 'migrations');
    const m4 = readFileSync(resolve(migrations, '20261106153100000_workspaces_table.sql'), 'utf8');
    const start = m4.indexOf('FUNCTION kortix.workspace_expand_tables()');
    const body = m4.slice(start, m4.indexOf(']::text[]', start));
    const listed = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...WORKSPACE_KEY_CLASSES.expand].sort());
  });
});
