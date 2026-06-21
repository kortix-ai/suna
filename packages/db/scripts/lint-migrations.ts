#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'migrations');
const NAME_RE = /^\d{17}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
const DOWN_MARKER = /^\s*--[\s-]*down\s+migration/im;

export interface LintResult {
  errors: string[];
  warnings: string[];
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
    .join('\n')
    .trim();
}

export function lintMigration(filename: string, raw: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!NAME_RE.test(filename)) {
    errors.push(
      `${filename}: invalid filename. Must be <17-digit-UTC-timestamp>_<slug>.sql — use \`pnpm migrate:create <slug>\` or \`pnpm migrate:generate <slug>\`. A bad prefix makes node-pg-migrate mis-order or skip the migration.`,
    );
  }

  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    errors.push(
      `${filename}: contains an unresolved merge-conflict marker (<<<<<<< / ======= / >>>>>>>).`,
    );
  }

  if (stripComments(raw).length === 0) {
    errors.push(
      `${filename}: contains no SQL (empty, or only comments / an unfilled template). Write the migration or delete the file.`,
    );
  }

  const hasPlaceholder = raw
    .split('\n')
    .some((l) => l.trim().startsWith('--') && /\b(TODO|FIXME|XXX)\b/i.test(l));
  if (hasPlaceholder) {
    errors.push(
      `${filename}: has a leftover TODO/FIXME/XXX placeholder. Finish the migration before committing.`,
    );
  }

  // Destructive/data checks consider only the UP portion — a Down Migration
  // section is expected to be destructive (it reverses the up).
  const up = stripComments(raw.split(DOWN_MARKER)[0] ?? raw);
  if (/\b(drop\s+table|drop\s+column|truncate\b|drop\s+not\s+null)\b/i.test(up)) {
    warnings.push(
      `${filename}: destructive operation (DROP/TRUNCATE). Confirm the code reference was removed in a PRIOR deploy (expand→contract — see MIGRATIONS.md).`,
    );
  }
  if (/\bdelete\s+from\b/i.test(up) && !/\bdelete\s+from\b[\s\S]*?\bwhere\b/i.test(up)) {
    warnings.push(`${filename}: DELETE without a WHERE clause wipes the whole table. Intentional?`);
  }

  return { errors, warnings };
}

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) errors.push('No migration files found in packages/db/migrations/.');

  for (const f of files) {
    const { errors: e, warnings: w } = lintMigration(f, readFileSync(join(DIR, f), 'utf8'));
    errors.push(...e);
    warnings.push(...w);
  }

  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.error(`::error::${e}`);

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} migration lint error(s) — fix before merging.`);
    process.exit(1);
  }
  console.log(
    `✓ ${files.length} migration file(s) pass lint${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`,
  );
}

if (import.meta.main) main();
