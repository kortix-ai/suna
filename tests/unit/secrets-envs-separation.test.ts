import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/secrets-envs-separation.py');

// A stub `dotenvx` that decrypts each `name=encrypted:<value>` line to `<value>`, so a
// case is decided by the check's own logic and not by a real private key.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const out = {};
for (const line of fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8').split(String.fromCharCode(10))) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
  if (m) out[m[1]] = m[2].replace(/^encrypted:/, '');
}
console.log(JSON.stringify(out));
`;

type Profiles = { prod: Record<string, string>; nonProd: Record<string, Record<string, string>> };

// The script resolves ROOT from its own path, so a temp dir holding scripts/ and
// apps/api/.env* is a whole workspace for a black-box run of the real file.
function run({ prod, nonProd }: Profiles, allowlist = ''): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-separation-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    copyFileSync(script, join(dir, 'scripts', 'secrets-envs-separation.py'));
    writeFileSync(join(dir, 'scripts', 'secrets-shared-with-prod.allowlist'), allowlist);
    const stub = join(dir, 'dotenvx-stub');
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const lines = (vars: Record<string, string>) =>
      Object.entries(vars)
        .map(([k, v]) => `${k}=encrypted:${v}`)
        .join('\n') + '\n';
    writeFileSync(join(dir, 'apps', 'api', '.env.prod'), lines(prod));
    for (const [file, vars] of Object.entries(nonProd)) writeFileSync(join(dir, 'apps', 'api', file), lines(vars));
    const r = spawnSync('python3', [join(dir, 'scripts', 'secrets-envs-separation.py'), stub], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const nonProd = (vars: Record<string, string>) => ({ '.env': vars, '.env.dev': {}, '.env.staging': {} });

describe('scripts/secrets-envs-separation.py', () => {
  it('fails a prod-identical key whose name has no KEY/SECRET/TOKEN (KRTX-4108)', () => {
    const r = run({
      prod: { DATABASE_URL: 'postgres://prod-db:5432/kortix', SUPABASE_URL: 'https://prod.supabase.co' },
      nonProd: nonProd({ DATABASE_URL: 'postgres://prod-db:5432/kortix', SUPABASE_URL: 'https://prod.supabase.co' }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +== prod value/);
    expect(r.out).toMatch(/✗ local +SUPABASE_URL +== prod value/);
  });

  it('passes distinct values', () => {
    const r = run({
      prod: { DATABASE_URL: 'postgres://prod-db:5432/kortix', API_KEY_SECRET: 'prod-key' },
      nonProd: nonProd({ DATABASE_URL: 'postgres://local-db:5432/kortix', API_KEY_SECRET: 'local-key' }),
    });
    expect(r.code, r.out).toBe(0);
  });

  it('fails a prod-identical value under a secret name too', () => {
    const r = run({ prod: { API_KEY_SECRET: 'shared' }, nonProd: nonProd({ API_KEY_SECRET: 'shared' }) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +API_KEY_SECRET +== prod value/);
  });

  it('fails a value naming a prod origin even when prod does not define the key', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({ KORTIX_URL: 'https://api.kortix.com', LANGFUSE_HOST: 'https://dev.langfuse.example' }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +KORTIX_URL +names api\.kortix\.com/);
    expect(r.out).not.toMatch(/LANGFUSE_HOST/);
  });

  it('names the prod host for a URL, a DSN and a host list alike', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        FRONTEND_URL: 'https://kortix.com/pricing',
        DATABASE_URL: 'postgres://user:pw@api.kortix.com:5432/kortix',
        CORS_ORIGINS: 'https://kortix.ai, https://api.kortix.com',
        DEV_DB: 'postgres://user:pw@dev-db.kortix.internal:5432/kortix',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +FRONTEND_URL +names kortix\.com/);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +names api\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +CORS_ORIGINS +names api\.kortix\.com/);
    expect(r.out).not.toMatch(/DEV_DB/);
  });

  it('reads dev.kortix.com as the dev stack, not prod', () => {
    const r = run({ prod: {}, nonProd: nonProd({ KORTIX_URL: 'https://dev-api.kortix.com', FRONTEND_URL: 'https://dev.kortix.com' }) });
    expect(r.code, r.out).toBe(0);
  });

  it('fails a LIVE Stripe key in a non-prod profile', () => {
    const r = run({ prod: {}, nonProd: nonProd({ STRIPE_API: 'sk_live_abc', STRIPE_TEST_API: 'sk_test_abc' }) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +STRIPE_API +names a LIVE Stripe key/);
    expect(r.out).not.toMatch(/STRIPE_TEST_API/);
  });

  it('reports an allowlisted shared key as debt without failing', () => {
    const r = run(
      { prod: { DAYTONA_API_KEY: 'shared' }, nonProd: nonProd({ DAYTONA_API_KEY: 'shared' }) },
      'DAYTONA_API_KEY prod Daytona org\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/~ local +DAYTONA_API_KEY +== prod value \(allowlisted: prod Daytona org\)/);
  });

  it('never matches an empty prod value against a populated non-prod one', () => {
    const r = run({ prod: { UNUSED: '' }, nonProd: nonProd({ UNUSED: 'local-only' }) });
    expect(r.code, r.out).toBe(0);
  });
});
