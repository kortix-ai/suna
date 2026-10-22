#!/usr/bin/env node
// Builds dist/styles.css: Tailwind preflight + tokens.css + theme.css + every
// utility class used under src/, minified. For hosts that do not run Tailwind.
// dist/styles.css is committed, so a fresh checkout resolves '@kortix/ui/styles.css'.
//   pnpm --filter @kortix/ui build:styles             write
//   pnpm --filter @kortix/ui build:styles -- --check  exit 1 when the committed file drifts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const target = join(PKG_DIR, 'dist', 'styles.css');
const check = process.argv.includes('--check');
const tmp = check ? mkdtempSync(join(tmpdir(), 'kortix-ui-styles-')) : null;
const out = check ? join(tmp, 'styles.css') : target;
const run = spawnSync(
  join(PKG_DIR, 'node_modules', '.bin', 'tailwindcss'),
  ['-i', join(PKG_DIR, 'scripts', 'styles-entry.css'), '-o', out, '--minify'],
  { cwd: PKG_DIR, stdio: check ? 'pipe' : 'inherit' },
);
if (run.status !== 0) {
  if (check) process.stderr.write(run.stderr ?? '');
  process.exit(run.status ?? 1);
}
if (check) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  const drift = current !== readFileSync(out, 'utf8');
  rmSync(tmp, { recursive: true, force: true });
  if (drift) {
    console.error('build-styles: dist/styles.css drifts from src. Run: pnpm --filter @kortix/ui build:styles');
    process.exit(1);
  }
  console.log('build-styles: no drift');
} else {
  console.log(`build-styles: dist/styles.css ${(statSync(out).size / 1024).toFixed(1)} KiB`);
}
