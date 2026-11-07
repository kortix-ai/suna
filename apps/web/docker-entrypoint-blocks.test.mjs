import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Characterizes the per-placeholder rewrite BLOCKS of docker-entrypoint.sh (the
// section that builds $SED_SCRIPT), which the shipped docker-entrypoint.test.mjs
// does not cover — it only exercises the final `find | xargs sed` apply step.
// This pins that each baked placeholder is turned into its runtime value and
// that the shared `rewrite()` helper logs each one (except the backend host,
// which by design logs nothing and is covered by the backend URL line).

const ENTRYPOINT = join(import.meta.dir, 'docker-entrypoint.sh');

const BAKED = {
  supabase: 'https://placeholder.supabase.co',
  anon: 'local-build-placeholder-anon-key',
  backend: 'http://localhost:8008/v1',
  backendHost: 'http://localhost:8008',
  app: 'http://localhost:3000',
};
const RUNTIME = {
  supabase: 'https://real.supabase.co',
  anon: 'real-anon-key',
  backend: 'https://api.real.com/v1',
  backendHost: 'https://api.real.com',
  app: 'https://app.real.com',
};

/**
 * GNU `sed -i` takes no suffix; BSD sed (darwin) reads the next arg as the
 * backup suffix. Shim sed on PATH there so the test runs the shipped pipeline
 * verbatim (same approach as docker-entrypoint.test.mjs). Linux/CI uses GNU sed.
 */
function shimBinDir() {
  if (process.platform !== 'darwin') return null;
  const bin = mkdtempSync(join(tmpdir(), 'kortix-shim-'));
  const sed = join(bin, 'sed');
  writeFileSync(
    sed,
    [
      '#!/bin/sh',
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

/** The shipped script, patched only to point at a test bundle and skip the exec. */
function runnableScript(bundleDir) {
  const source = readFileSync(ENTRYPOINT, 'utf8');
  const patched = source
    .replace('BUNDLE_DIR="/app/apps/web/.next"', `BUNDLE_DIR="${bundleDir}"`)
    .replace('exec node apps/web/server.js', 'exit 0');
  if (patched === source) throw new Error('could not patch docker-entrypoint.sh for the test');
  const path = join(mkdtempSync(join(tmpdir(), 'kortix-entrypoint-run-')), 'entrypoint.sh');
  writeFileSync(path, patched);
  return path;
}

function makeBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-entrypoint-blocks-'));
  mkdirSync(join(dir, 'static'), { recursive: true });
  const body = [
    `const supabase = "${BAKED.supabase}";`,
    `const anon = "${BAKED.anon}";`,
    `const backend = "${BAKED.backend}";`,
    `const backendHost = "${BAKED.backendHost}";`,
    `const app = "${BAKED.app}";`,
    `const cfg = { BILLING_ENABLED:!0 };`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'static', 'main.js'), body);
  writeFileSync(join(dir, 'index.html'), body);
  return dir;
}

describe('docker-entrypoint.sh placeholder blocks', () => {
  test('rewrites every baked placeholder to its runtime value and logs each (not the backend host)', () => {
    const bundle = makeBundle();
    const bin = shimBinDir();
    const result = spawnSync('/bin/sh', [runnableScript(bundle)], {
      env: {
        ...process.env,
        PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
        NEXT_PUBLIC_SUPABASE_URL: RUNTIME.supabase,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: RUNTIME.anon,
        NEXT_PUBLIC_BACKEND_URL: RUNTIME.backend,
        NEXT_PUBLIC_APP_URL: RUNTIME.app,
        // NEXT_PUBLIC_BILLING_ENABLED unset -> defaults to false -> baked !0 -> !1
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    for (const rel of ['static/main.js', 'index.html']) {
      const text = readFileSync(join(bundle, rel), 'utf8');
      expect(text).toContain(`const supabase = "${RUNTIME.supabase}";`);
      expect(text).toContain(`const anon = "${RUNTIME.anon}";`);
      expect(text).toContain(`const backend = "${RUNTIME.backend}";`);
      expect(text).toContain(`const backendHost = "${RUNTIME.backendHost}";`);
      expect(text).toContain(`const app = "${RUNTIME.app}";`);
      expect(text).not.toContain(BAKED.supabase);
      expect(text).not.toContain(BAKED.anon);
    }
    // The billing flag rewrite is .js-only (a separate block, unchanged here).
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).toContain('BILLING_ENABLED:!1');
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).not.toContain('BILLING_ENABLED:!0');

    // rewrite() logs each replacement; the backend-host block logs nothing.
    expect(result.stdout).toContain('[entrypoint] Supabase URL:');
    expect(result.stdout).toContain('[entrypoint] Supabase anon key:');
    expect(result.stdout).toContain('[entrypoint] Backend:');
    expect(result.stdout).toContain('[entrypoint] App URL:');
    expect(result.stdout).toContain('[entrypoint] Billing:');
    expect(result.stdout).not.toContain('[entrypoint] Backend host');
  });
});
