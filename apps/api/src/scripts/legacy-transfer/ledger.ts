import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { JsonRow } from './source';

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Preserve source identity across reruns, independent of titles and account remapping. */
export function mappedId(sourceRef: string, kind: string, sourceId: string): string {
  const hex = digest(JSON.stringify(['legacy-suna-v1', sourceRef, kind, sourceId])).slice(0, 32).split('');
  hex[12] = '8'; hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export class Ledger {
  readonly db: Database;
  constructor(directory: string) {
    const out = resolve(directory);
    // Keep private source records in an explicitly ignored directory, never beside code.
    if (!out.split(sep).includes('.legacy-transfer')) throw new Error('Output must be inside a .legacy-transfer directory');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    if (lstatSync(out).isSymbolicLink() || !realpathSync(out).split(sep).includes('.legacy-transfer')) throw new Error('Output symlinks are not allowed');
    chmodSync(out, 0o700);
    const file = join(out, 'ledger.sqlite');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Ledger symlinks are not allowed');
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS records (
        source_ref TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
        json TEXT NOT NULL, sha256 TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(source_ref, source_table, source_id)
      );
      CREATE TABLE IF NOT EXISTS export_records (
        source_ref TEXT NOT NULL, source_table TEXT NOT NULL, scope TEXT NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY(source_ref, source_table, scope, source_id)
      );
      CREATE TABLE IF NOT EXISTS exports (
        source_ref TEXT NOT NULL, source_table TEXT NOT NULL, scope TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, expected INTEGER, actual INTEGER,
        status TEXT NOT NULL, PRIMARY KEY(source_ref, source_table, scope)
      );
    `);
  }
  begin(ref: string, table: string, scope: string, expected: number): void {
    this.db.query('DELETE FROM export_records WHERE source_ref=? AND source_table=? AND scope=?').run(ref, table, scope);
    this.db.query(`INSERT INTO exports VALUES (?, ?, ?, ?, NULL, ?, 0, 'running')
      ON CONFLICT(source_ref,source_table,scope) DO UPDATE SET started_at=excluded.started_at,
      finished_at=NULL, expected=excluded.expected, actual=0, status='running'`).run(ref, table, scope, new Date().toISOString(), expected);
  }
  save(ref: string, table: string, pk: string, rows: JsonRow[], scope = '{}'): void {
    const insert = this.db.query(`INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_ref,source_table,source_id) DO UPDATE SET json=excluded.json, sha256=excluded.sha256, observed_at=excluded.observed_at`);
    this.db.transaction(() => {
      for (const row of rows) {
        if (typeof row[pk] !== 'string') throw new Error(`Missing ${pk}`);
        const json = JSON.stringify(row);
        insert.run(ref, table, row[pk] as string, json, digest(json), new Date().toISOString());
        this.db.query('INSERT OR IGNORE INTO export_records VALUES (?, ?, ?, ?)').run(ref, table, scope, row[pk] as string);
      }
    })();
  }
  finish(ref: string, table: string, scope: string, actual: number, expected: number, after = expected): void {
    this.db.query(`UPDATE exports SET actual=?, finished_at=?, status=? WHERE source_ref=? AND source_table=? AND scope=?`)
      .run(actual, new Date().toISOString(), after !== expected ? 'source-changed' : actual === expected ? 'count-matched' : 'count-mismatch', ref, table, scope);
    if (after !== expected) throw new Error(`Source count changed during export: ${expected} -> ${after}`);
    if (actual !== expected) throw new Error(`Source changed or export incomplete: expected ${expected}, read ${actual}`);
  }
  close(): void { this.db.close(); }
}
