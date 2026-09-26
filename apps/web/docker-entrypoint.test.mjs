import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(import.meta.dir, 'docker-entrypoint.sh');
const PLACEHOLDER = 'https://placeholder.supabase.co';
const RUNTIME = 'https://example.supabase.co';

/**
 * Extract the live rewrite pipeline out of the shipped entrypoint instead of
 * restating it here. A change to the shipped `find | xargs sed` is what these
 * tests run, so they cannot drift away from the script.
 */
function extractRewritePipeline() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const start = lines.findIndex(
    (line) => line.includes('find "$BUNDLE_DIR"') && line.includes('-print0'),
  );
  if (start === -1) throw new Error('rewrite pipeline not found in docker-entrypoint.sh');
  const end = lines.findIndex((line, i) => i >= start && line.includes('xargs -0'));
  if (end === -1) throw new Error('xargs batching not found in docker-entrypoint.sh');
  return lines
    .slice(start, end + 1)
    .map((line) => line.trim())
    .join(' ');
}

/** Bundle-shaped tree: nested .js/.html targets plus .txt/.css decoys. */
function makeBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-entrypoint-'));
  mkdirSync(join(dir, 'static', 'chunks'), { recursive: true });
  mkdirSync(join(dir, 'server', 'app'), { recursive: true });
  const targets = [
    'static/chunks/main.js',
    'static/chunks/framework.js',
    'server/app/page.js',
    'index.html',
    'server/app/404.html',
  ];
  const decoys = ['static/chunks/main.js.map.txt', 'static/style.css'];
  for (const rel of [...targets, ...decoys]) {
    writeFileSync(join(dir, rel), `const u = "${PLACEHOLDER}";\n`);
  }
  return { dir, targets, decoys };
}

/**
 * The image is Debian (node:22-slim) with GNU sed, where `sed -i` takes no
 * suffix. BSD sed on darwin reads the next argument as the backup suffix, so a
 * macOS dev box cannot run the shipped pipeline verbatim. Shim `sed` on PATH
 * there instead of rewriting the pipeline: the tests then exercise the exact
 * text that ships. Linux (CI) uses the real GNU sed and no shim.
 */
function shimBinDir() {
  if (process.platform !== 'darwin') return null;
  const bin = mkdtempSync(join(tmpdir(), 'kortix-shim-'));
  const sed = join(bin, 'sed');
  writeFileSync(
    sed,
    [
      '#!/bin/sh',
      "# Test-only: translate GNU `sed -i` into BSD `sed -i ''`.",
      'n=$#',
      'while [ "$n" -gt 0 ]; do',
      '  a=$1; shift',
      '  if [ "$a" = "-i" ]; then set -- "$@" -i ""; else set -- "$@" "$a"; fi',
      '  n=$((n - 1))',
      'done',
      'exec /usr/bin/sed "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(sed, 0o755);
  return bin;
}

function runRewrite(pipeline, bundleDir) {
  const sedScript = join(mkdtempSync(join(tmpdir(), 'kortix-sed-')), 'rewrite.sed');
  writeFileSync(sedScript, `s|${PLACEHOLDER}|${RUNTIME}|g\n`);
  const bin = shimBinDir();
  const result = spawnSync('/bin/sh', ['-c', pipeline], {
    env: {
      ...process.env,
      PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
      BUNDLE_DIR: bundleDir,
      SED_SCRIPT: sedScript,
    },
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

describe('docker-entrypoint.sh bundle rewrite', () => {
  test('rewrites every .js and .html file and leaves decoys untouched', () => {
    const { dir, targets, decoys } = makeBundle();
    runRewrite(extractRewritePipeline(), dir);

    for (const rel of targets) {
      expect(read(dir, rel)).toContain(RUNTIME);
      expect(read(dir, rel)).not.toContain(PLACEHOLDER);
    }
    for (const rel of decoys) {
      expect(read(dir, rel)).toContain(PLACEHOLDER);
      expect(read(dir, rel)).not.toContain(RUNTIME);
    }
  });

  test('regression: dropping the find \\( … \\) grouping silently skips every .js file', () => {
    // Without the parens, `-print0` binds only to the `-name '*.html'` branch,
    // so find emits the .html files alone and every .js chunk keeps its
    // build-time placeholder. This asserts the grouping is load-bearing.
    const ungrouped = extractRewritePipeline().replace('\\( ', '').replace(' \\)', '');
    expect(ungrouped).not.toContain('\\(');

    const { dir } = makeBundle();
    runRewrite(ungrouped, dir);

    expect(read(dir, 'static/chunks/main.js')).toContain(PLACEHOLDER);
    expect(read(dir, 'server/app/page.js')).toContain(PLACEHOLDER);
    expect(read(dir, 'index.html')).toContain(RUNTIME);
  });

  test('batches the rewrite through xargs instead of one sed per file', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    expect(source).toContain(`find "$BUNDLE_DIR" \\( -name '*.js' -o -name '*.html' \\) -print0`);
    expect(source).toContain('xargs -0 -r sed -i -f "$SED_SCRIPT"');
    // The per-file loop this replaced must not come back.
    expect(source).not.toMatch(/while read -r file; do\s*\n\s*sed -i -f/);
  });

  test('empty file list is a no-op: xargs -r keeps set -e from killing startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kortix-empty-'));
    const result = runRewrite(extractRewritePipeline(), dir);
    expect(result.stderr).toBe('');
  });
});
