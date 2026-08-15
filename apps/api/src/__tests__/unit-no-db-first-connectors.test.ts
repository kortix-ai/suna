/**
 * Guardrail: connectors and triggers are config-first. Their definitions live
 * in kortix.yaml; the DB is only ever a derived cache (connectors) or absent
 * (triggers — read live from the manifest). This test fails the build if any
 * code path writes an entity definition straight to the DB, which would
 * reintroduce the "lands in the DB before it's in config" race.
 *
 * Allowed writers:
 *   - connectors/sync.ts       — THE connector materializer (manifest → DB)
 *   - __tests__/* and any *.test.ts — fixtures / seeds, wherever the test lives
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

// `.insert(<table>` with optional whitespace — matches `db.insert(connectors`,
// `tx.insert( connectors`, etc.
const insertOf = (table: string) => new RegExp(`\\.insert\\(\\s*${table}\\b`);

function offenders(table: string, allow: (rel: string) => boolean): string[] {
  const hits: string[] = [];
  const re = insertOf(table);
  for (const file of tsFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    // Any test file is a fixture/seed writer, not a production code path —
    // `__tests__/*` by directory (e.g. `e2e-connector-mcp-live.ts`, no
    // `.test.ts` suffix) and `*.test.ts` anywhere else in the tree (e.g.
    // route-level DB-integration suites under `projects/routes/`).
    // The exemption is filename-based, not reachability-based; it is still
    // sound because nothing in `src/index.ts`'s import graph ever imports a
    // `*.test.ts` file, so a guarded insert in one can never run in
    // production. A production module NAMED `*.test.ts` would bypass this
    // guard — do not name production files that way.
    if (rel.startsWith('__tests__/') || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    if (allow(rel)) continue;
    if (re.test(readFileSync(file, 'utf8'))) hits.push(rel);
  }
  return hits;
}

describe('config-first invariant (no DB-first creation)', () => {
  test('connectors is inserted ONLY by the toml→DB materializer', () => {
    // connectors/sync.ts is the single sanctioned writer.
    expect(offenders('connectors', (rel) => rel === 'connectors/sync.ts')).toEqual([]);
  });

  test('connector actions/policies are inserted ONLY by the materializer', () => {
    expect(offenders('connectorActions', (rel) => rel === 'connectors/sync.ts')).toEqual([]);
    expect(offenders('connectorPolicies', (rel) => rel === 'connectors/sync.ts')).toEqual([]);
  });

  test('projectTriggers (legacy definition table) is never inserted — triggers are file-defined', () => {
    // No allowance: trigger definitions live in kortix.yaml, period.
    expect(offenders('projectTriggers', () => false)).toEqual([]);
  });
});
