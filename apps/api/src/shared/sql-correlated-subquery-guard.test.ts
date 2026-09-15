import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as schema from '@kortix/db';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

/**
 * TRIPWIRE — INC-2026-09-15.
 *
 * A raw `sql` subquery that references an OUTER-table column as `${table.col}`
 * renders that column UNQUALIFIED whenever it sits in the selection of a
 * single-table Drizzle select. Postgres then binds it to the INNER table and the
 * correlation becomes a tautology. Whether a template is safe depends on where a
 * caller later places it, so the rule is structural: inside a raw subquery,
 * every column of a table the subquery does not itself select from goes through
 * `qualifiedColumn(...)` (`shared/sql-qualified-column.ts`).
 *
 * The scan is textual on purpose: it needs no database and runs in the unit
 * lane. A template counts as a subquery when it contains `select … from`.
 */

const API_SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Every Drizzle table exported by `@kortix/db`, by its export name. */
const TABLE_NAMES = new Set(
  Object.entries(schema)
    .filter(([, value]) => is(value, PgTable))
    .map(([name]) => name),
);

const TEMPLATE = /\bsql(?:<[^>`]*>)?`((?:[^`\\]|\\.)*)`/gs;

/** Violations in one source text: `${Table.column}` outer references. */
function correlatedSubqueryViolations(
  source: string,
  tableNames: ReadonlySet<string> = TABLE_NAMES,
): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(TEMPLATE)) {
    const body = match[1] ?? '';
    if (!/\bselect\b[\s\S]*\bfrom\b/i.test(body)) continue;
    const innerTables = new Set(
      [...body.matchAll(/\b(?:from|join)\s+\$\{\s*(\w+)\s*\}/gi)].map((m) => m[1]),
    );
    for (const ref of body.matchAll(/\$\{\s*(\w+)\.(\w+)\s*\}/g)) {
      const [, table, column] = ref;
      if (!tableNames.has(table) || innerTables.has(table)) continue;
      violations.push(`\${${table}.${column}}`);
    }
  }
  return violations;
}

describe('raw SQL subqueries qualify every outer column', () => {
  test('the detector flags the exact incident shape and accepts the fixed one', () => {
    const incident =
      'sql`(select ${projectSessions.agentName} from ${projectSessions} where ${projectSessions.sessionId} = ${sessionSandboxes.sessionId} limit 1)`';
    const fixed =
      'sql`(select count(*) from ${projectSessions} ps where ps.project_id = ${qualifiedColumn(projects.projectId)})`';
    const notASubquery = 'sql`lower(${sessionSandboxes.externalId}) = lower(${externalId})`';

    expect(correlatedSubqueryViolations(incident)).toEqual(['${sessionSandboxes.sessionId}']);
    expect(correlatedSubqueryViolations(fixed)).toEqual([]);
    expect(correlatedSubqueryViolations(notASubquery)).toEqual([]);
  });

  test('no file in apps/api/src references an outer column without qualifiedColumn()', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      for (const violation of correlatedSubqueryViolations(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(API_SRC, file)}: ${violation}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
