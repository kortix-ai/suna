#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'migrations');
const NAME_RE = /^\d{17}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;

const errors: string[] = [];
const warnings: string[] = [];

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) errors.push('No migration files found in packages/db/migrations/.');

for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8');

  if (!NAME_RE.test(f)) {
    errors.push(`${f}: invalid filename. Must be <17-digit-UTC-timestamp>_<slug>.sql — use \`pnpm migrate:create <slug>\` or \`pnpm migrate:generate <slug>\`. A bad prefix makes node-pg-migrate mis-order or skip the migration.`);
  }

  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    errors.push(`${f}: contains an unresolved merge-conflict marker (<<<<<<< / ======= / >>>>>>>).`);
  }

  const sql = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
    .join('\n')
    .trim();
  if (sql.length === 0) {
    errors.push(`${f}: contains no SQL (empty, or only comments / an unfilled template). Write the migration or delete the file.`);
  }

  const placeholderComment = raw
    .split('\n')
    .some((l) => l.trim().startsWith('--') && /\b(TODO|FIXME|XXX)\b/i.test(l));
  if (placeholderComment) {
    errors.push(`${f}: has a leftover TODO/FIXME/XXX placeholder. Finish the migration before committing.`);
  }

  if (/\b(drop\s+table|drop\s+column|truncate\b|drop\s+not\s+null)\b/i.test(sql)) {
    warnings.push(`${f}: destructive operation (DROP/TRUNCATE). Confirm the code reference was removed in a PRIOR deploy (expand→contract — see MIGRATIONS.md).`);
  }
  if (/\bdelete\s+from\b/i.test(sql) && !/\bdelete\s+from\b[\s\S]*?\bwhere\b/i.test(sql)) {
    warnings.push(`${f}: DELETE without a WHERE clause wipes the whole table. Intentional?`);
  }
}

for (const w of warnings) console.log(`::warning::${w}`);
for (const e of errors) console.error(`::error::${e}`);

if (errors.length > 0) {
  console.error(`\n✗ ${errors.length} migration lint error(s) — fix before merging.`);
  process.exit(1);
}
console.log(`✓ ${files.length} migration file(s) pass lint${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
