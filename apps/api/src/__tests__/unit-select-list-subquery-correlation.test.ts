/**
 * Tripwire: no select-list subquery may correlate through Drizzle column
 * interpolation.
 *
 * In a single-table `db.select({...}).from(t)` Drizzle renders every column in
 * the SELECT LIST without a table prefix. A field like
 *
 *   agentName: sql`(select ${a.agentName} from ${a} where ${a.sessionId} = ${b.sessionId})`
 *
 * therefore reaches Postgres as `where "session_id" = "session_id"`. Both names
 * bind to the inner table, the predicate is always true, and the subquery
 * answers an arbitrary row. (WHERE clauses are rendered qualified; only the
 * select list has this hazard.)
 *
 * This shipped twice: `repositories/iam.ts` (group counts came back as table
 * totals, fixed by hand-writing the outer reference) and
 * `sandbox-proxy/backend.ts` (INC-2026-09-15-CROSS-TENANT-AGENT-GRANT: session
 * tokens re-minted to another tenant's agent). Use a JOIN instead, or write
 * the outer reference as literal qualified SQL.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

const SELECT_LIST_SUBQUERY = /(\w+)\s*:\s*sql(?:<[^`]*?>)?`\s*\(\s*select\b([\s\S]*?)`/gi;
const COLUMN_INTERPOLATION = /\$\{(\w+)\.(\w+)\}/g;

export interface CorrelationViolation {
  file: string;
  line: number;
  field: string;
  tables: string[];
}

/** Every select-list subquery that interpolates columns of two or more tables. */
export function findInterpolatedCorrelations(file: string, source: string): CorrelationViolation[] {
  const violations: CorrelationViolation[] = [];
  for (const match of source.matchAll(SELECT_LIST_SUBQUERY)) {
    const body = match[2] ?? '';
    const tables = new Set<string>();
    for (const ref of body.matchAll(COLUMN_INTERPOLATION)) tables.add(ref[1]!);
    if (tables.size < 2) continue;
    violations.push({
      file,
      line: source.slice(0, match.index ?? 0).split('\n').length,
      field: match[1]!,
      tables: [...tables].sort(),
    });
  }
  return violations;
}

function sourceFiles(): string[] {
  const glob = new Bun.Glob('{apps,packages}/*/src/**/*.ts');
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: repoRoot })) {
    if (path.includes('node_modules') || path.includes('/dist/')) continue;
    if (path.endsWith('.test.ts') || path.includes('/__tests__/')) continue;
    files.push(path);
  }
  return files;
}

describe('select-list subquery correlation tripwire', () => {
  test('the detector flags the incident shape and ignores safe shapes', () => {
    const incident = [
      'const columns = {',
      '  agentName: sql<string | null>`(',
      '    select ${projectSessions.agentName}',
      '    from ${projectSessions}',
      '    where ${projectSessions.sessionId} = ${sessionSandboxes.sessionId}',
      '    limit 1',
      '  )`,',
      '};',
    ].join('\n');
    expect(findInterpolatedCorrelations('incident.ts', incident)).toEqual([
      { file: 'incident.ts', line: 2, field: 'agentName', tables: ['projectSessions', 'sessionSandboxes'] },
    ]);

    const literalOuter = [
      'memberCount: sql<number>`(',
      '  SELECT COUNT(*)::int FROM kortix.account_group_members agm',
      '  WHERE agm.group_id = kortix.account_groups.group_id',
      ')`,',
    ].join('\n');
    expect(findInterpolatedCorrelations('iam.ts', literalOuter)).toEqual([]);

    const uncorrelated = 'totalAccounts: sql<number>`(select count(*) from ${accounts})::int`,';
    expect(findInterpolatedCorrelations('analytics.ts', uncorrelated)).toEqual([]);
  });

  test('no source file correlates a select-list subquery through column interpolation', () => {
    const files = sourceFiles();
    // A glob that silently matches nothing would pass this gate while checking nothing.
    expect(files.length).toBeGreaterThan(500);

    const violations = files.flatMap((path) =>
      findInterpolatedCorrelations(
        relative(repoRoot, join(repoRoot, path)),
        readFileSync(join(repoRoot, path), 'utf8'),
      ),
    );
    expect(violations).toEqual([]);
  });
});
