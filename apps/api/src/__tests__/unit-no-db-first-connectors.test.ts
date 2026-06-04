/**
 * Guardrail: connectors and triggers are config-first. Their definitions live
 * in kortix.toml; the DB is only ever a derived cache (connectors) or absent
 * (triggers — read live from the manifest). This test fails the build if any
 * code path writes an entity definition straight to the DB, which would
 * reintroduce the "lands in the DB before it's in config" race.
 *
 * Allowed writers:
 *   - executor/sync.ts        — THE connector materializer (toml → DB)
 *   - __tests__/*             — fixtures / seeds
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

// `.insert(<table>` with optional whitespace — matches `db.insert(executorConnectors`,
// `tx.insert( executorConnectors`, etc.
const insertOf = (table: string) => new RegExp(`\\.insert\\(\\s*${table}\\b`);

function offenders(table: string, allow: (rel: string) => boolean): string[] {
  const hits: string[] = [];
  const re = insertOf(table);
  for (const file of tsFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel.startsWith('__tests__/')) continue;
    if (allow(rel)) continue;
    if (re.test(readFileSync(file, 'utf8'))) hits.push(rel);
  }
  return hits;
}

describe('config-first invariant (no DB-first creation)', () => {
  test('executorConnectors is inserted ONLY by the toml→DB materializer', () => {
    // executor/sync.ts is the single sanctioned writer.
    expect(offenders('executorConnectors', (rel) => rel === 'executor/sync.ts')).toEqual([]);
  });

  test('connector actions/policies are inserted ONLY by the materializer', () => {
    expect(offenders('executorConnectorActions', (rel) => rel === 'executor/sync.ts')).toEqual([]);
    expect(offenders('executorConnectorPolicies', (rel) => rel === 'executor/sync.ts')).toEqual([]);
  });

});
