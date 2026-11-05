import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/secrets-envs-separation.py');

// A stub `dotenvx` that decrypts each `name=encrypted:<value>` line to `<value>`, so a
// case is decided by the check's own logic and not by a real private key.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.argv[process.argv.indexOf('-f') + 1];
if (fs.existsSync(file + '.nokey')) { console.log(JSON.stringify({ DOTENV_PUBLIC_KEY_PROD: 'encrypted:still-ciphertext' })); process.exit(0); }
const out = {};
for (const line of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
  if (m) out[m[1]] = m[2].replace(/^encrypted:/, '');
}
console.log(JSON.stringify(out));
`;

type Profiles = {
  prod: Record<string, string>;
  nonProd: Record<string, Record<string, string>>;
  rawProd?: string;
  rawDev?: string;
};

// The script resolves ROOT from its own path, so a temp dir holding scripts/ and
// apps/api/.env* is a whole workspace for a black-box run of the real file.
// `rawProd` writes apps/api/.env.prod verbatim; its stub then fails to decrypt it, the way
// a missing DOTENV_PRIVATE_KEY_PROD leaves every value as ciphertext. `rawDev` is its
// non-prod twin for apps/api/.env.dev.
function run(
  { prod, nonProd, rawProd, rawDev }: Profiles,
  allowlist = '',
): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-separation-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    copyFileSync(script, join(dir, 'scripts', 'secrets-envs-separation.py'));
    writeFileSync(join(dir, 'scripts', 'secrets-shared-with-prod.allowlist'), allowlist);
    const stub = join(dir, 'dotenvx-stub');
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    // An empty profile holds only its dotenvx public-key line, which every reader skips:
    // `DOTENV_PUBLIC_KEY_<ENV>=` leaves the profile legitimately empty, as a fresh env is.
    const lines = (vars: Record<string, string>) =>
      `${
        Object.entries(vars)
          .map(([k, v]) => `${k}=encrypted:${v}`)
          .join('\n') || 'DOTENV_PUBLIC_KEY_EMPTY=encrypted:pkey'
      }\n`;
    writeFileSync(join(dir, 'apps', 'api', '.env.prod'), rawProd ?? lines(prod));
    if (rawProd) writeFileSync(join(dir, 'apps', 'api', '.env.prod.nokey'), '');
    if (rawDev) {
      writeFileSync(join(dir, 'apps', 'api', '.env.dev'), rawDev);
      writeFileSync(join(dir, 'apps', 'api', '.env.dev.nokey'), '');
    }
    for (const [file, vars] of Object.entries(nonProd)) {
      if (rawDev && file === '.env.dev') continue;
      writeFileSync(join(dir, 'apps', 'api', file), lines(vars));
    }
    const r = spawnSync('python3', [join(dir, 'scripts', 'secrets-envs-separation.py'), stub], {
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

const nonProd = (vars: Record<string, string>) => ({
  '.env': vars,
  '.env.dev': {},
  '.env.staging': {},
});

describe('scripts/secrets-envs-separation.py', () => {
  it('fails a prod-identical key whose name has no KEY/SECRET/TOKEN (KRTX-4108)', () => {
    const r = run({
      prod: {
        DATABASE_URL: 'postgres://prod-db:5432/kortix',
        SUPABASE_URL: 'https://prod.supabase.co',
      },
      nonProd: nonProd({
        DATABASE_URL: 'postgres://prod-db:5432/kortix',
        SUPABASE_URL: 'https://prod.supabase.co',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +== prod value/);
    expect(r.out).toMatch(/✗ local +SUPABASE_URL +== prod value/);
  });

  it('passes distinct values', () => {
    const r = run({
      prod: { DATABASE_URL: 'postgres://prod-db:5432/kortix', API_KEY_SECRET: 'prod-key' },
      nonProd: nonProd({
        DATABASE_URL: 'postgres://local-db:5432/kortix',
        API_KEY_SECRET: 'local-key',
      }),
    });
    expect(r.code, r.out).toBe(0);
  });

  it('fails a prod-identical value under a secret name too', () => {
    const r = run({
      prod: { API_KEY_SECRET: 'shared' },
      nonProd: nonProd({ API_KEY_SECRET: 'shared' }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +API_KEY_SECRET +== prod value/);
  });

  it('fails a credential DSN naming a prod host even when prod does not define the key', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        DATABASE_URL: 'postgres://user:pw@api.kortix.com:5432/kortix',
        LANGFUSE_HOST: 'postgres://user:pw@dev.langfuse.example:5432/traces',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +names api\.kortix\.com/);
    expect(r.out).not.toMatch(/LANGFUSE_HOST/);
  });

  it('reads a uppercase-scheme DSN, one past 2048 chars, quoted and comma-listed (self-review B)', () => {
    const long = `x=${'p'.repeat(2100)};`;
    const r = run({
      prod: {},
      nonProd: nonProd({
        A: 'POSTGRES://user:pw@api.kortix.com:5432/kortix',
        B: `${long}postgres://user:pw@gateway.kortix.com:5432/k`,
        C: '"postgres://user:pw@supa.kortix.com:5432/k"',
        D: 'postgres://user:pw@dev-db.kortix.internal:5432/k,POSTGRES://user:pw@api-ecs-fargate.kortix.com:5432/k',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(
      /A +names api\.kortix\.com[^\n]*\n[^\n]*B +names gateway\.kortix\.com[^\n]*\n[^\n]*C +names supa\.kortix\.com/,
    );
    expect(r.out).toMatch(/D +names api-ecs-fargate\.kortix\.com/);
    expect(r.out).not.toMatch(/dev-db\.kortix\.internal/);
  });

  it('never matches a bare boolean against a prod one (self-review B)', () => {
    const r = run({
      prod: { KORTIX_X_ENABLED: 'true', KORTIX_Y_ENABLED: 'false' },
      nonProd: nonProd({
        KORTIX_X_ENABLED: 'true',
        KORTIX_Y_ENABLED: 'false',
        DATABASE_URL: 'postgres://local-db/main',
      }),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/KORTIX_X_ENABLED|KORTIX_Y_ENABLED/);
  });

  it('names the prod host for a credential DSN and keeps a plain URL out of it', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        FRONTEND_URL: 'https://kortix.com/pricing',
        DATABASE_URL: 'postgres://user:pw@api.kortix.com:5432/kortix',
        DEV_DB: 'postgres://user:pw@dev-db.kortix.internal:5432/kortix',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +names api\.kortix\.com/);
    expect(r.out).not.toMatch(/FRONTEND_URL|DEV_DB/);
  });

  it('reads dev.kortix.com as the dev stack, not prod', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        DATABASE_URL: 'postgres://user:pw@dev-api.kortix.com:5432/kortix',
        REDIS_URL: 'redis://:secret@dev.kortix.com:6379',
      }),
    });
    expect(r.code, r.out).toBe(0);
  });

  it('fails a LIVE Stripe key in a non-prod profile', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({ STRIPE_API: 'sk_live_abc', STRIPE_TEST_API: 'sk_test_abc' }),
    });
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
    expect(r.out).toMatch(
      /~ local +DAYTONA_API_KEY +== prod value \(allowlisted: prod Daytona org\)/,
    );
  });

  it('never matches an empty prod value against a populated non-prod one', () => {
    const r = run({ prod: { UNUSED: '' }, nonProd: nonProd({ UNUSED: 'local-only' }) });
    expect(r.code, r.out).toBe(0);
  });

  // KRTX-4108 review item 1: a public host name is not a reach into prod. Only a
  // credential DSN (scheme://user:pass@host) carries the deployment it points at.
  it('keeps a bare host, a sender address and an origin list allowed (KRTX-4108 item 1)', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        CLOUDFLARE_ZONE_NAME: 'kortix.com',
        MAILTRAP_FROM_EMAIL: 'hi@kortix.com',
        CORS_ALLOWED_ORIGINS: 'https://dev.kortix.com,https://kortix.com,https://www.kortix.com',
      }),
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/CLOUDFLARE_ZONE_NAME|MAILTRAP_FROM_EMAIL|CORS_ALLOWED_ORIGINS/);
  });

  // KRTX-4108 review item 1, the case that actually fails a real profile: the brand values
  // dev and staging hold are the SAME strings prod holds, so the == prod value track fires.
  // One public name serves every environment, so these are allowlisted as brand values.
  it('passes the real dev brand values even though they equal prod (KRTX-4108 item 1)', () => {
    const brand = {
      CLOUDFLARE_ZONE_NAME: 'kortix.com',
      MAILTRAP_FROM_EMAIL: 'hi@kortix.com',
      RESEND_FROM_EMAIL: 'noreply@kortix.cloud',
      RESEND_MANAGED_DOMAIN: 'kortixmail.com',
      KORTIX_PREVIEW_BASE_DOMAIN: 'p.kortix.com',
    };
    const r = run(
      {
        prod: brand,
        nonProd: nonProd({ ...brand, DATABASE_URL: 'postgres://dev-db:5432/kortix' }),
      },
      'CLOUDFLARE_ZONE_NAME one DNS zone\nMAILTRAP_FROM_EMAIL one mail domain\n' +
        'RESEND_FROM_EMAIL one mail domain\nRESEND_MANAGED_DOMAIN one sending domain\n' +
        'KORTIX_PREVIEW_BASE_DOMAIN one preview domain\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/~ local +CLOUDFLARE_ZONE_NAME +== prod value \(allowlisted/);
    expect(r.out).toMatch(/~ local +KORTIX_PREVIEW_BASE_DOMAIN +== prod value \(allowlisted/);
    expect(r.out).toMatch(/✓ local +0 unallowed, 5 allowlisted/);
    expect(r.out).not.toMatch(/DATABASE_URL/);
  });

  // The brand allowlist must not launder a credential: the same key fails on a prod host
  // or a LIVE key, because an entry waives the shared-value class only.
  it('a brand allowlist entry still fails a prod host (KRTX-4108 item 1)', () => {
    const r = run(
      {
        prod: {},
        nonProd: nonProd({ CLOUDFLARE_ZONE_NAME: 'postgres://u:p@api.kortix.com:5432/x' }),
      },
      'CLOUDFLARE_ZONE_NAME one DNS zone\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(
      /✗ local +CLOUDFLARE_ZONE_NAME +names api\.kortix\.com \u2014 split it$/m,
    );
  });

  it('still fails a credential DSN that points at a prod host (KRTX-4108 item 1)', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        DATABASE_URL: 'postgres://user:pw@api.kortix.com:5432/kortix',
        REDIS_URL: 'redis://:secret@kortix.com:6379',
        DEV_DB: 'postgres://user:pw@dev-db.kortix.internal:5432/kortix',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +names api\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +REDIS_URL +names kortix\.com/);
    expect(r.out).not.toMatch(/DEV_DB/);
  });

  // Strix finding af9fd5cc: an entry was audited for "equals a prod value", so it must not
  // waive a prod host or a LIVE key it was never reviewed for.
  it('an allowlisted key still fails a prod host and a LIVE key (KRTX-4108 item 3)', () => {
    const r = run(
      {
        prod: { BETTERSTACK_CLICKHOUSE_HOST: 'shared' },
        nonProd: nonProd({
          BETTERSTACK_CLICKHOUSE_HOST: 'postgres://u:p@api.kortix.com:5432/x',
          BETTERSTACK_MCP_URL: 'sk_live_abc',
        }),
      },
      'BETTERSTACK_CLICKHOUSE_HOST same Better Stack source\nBETTERSTACK_MCP_URL one MCP endpoint\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(
      /✗ local +BETTERSTACK_CLICKHOUSE_HOST +names api\.kortix\.com — split it$/m,
    );
    expect(r.out).toMatch(/✗ local +BETTERSTACK_MCP_URL +names a LIVE Stripe key/);
  });

  // KRTX-4108 review item [B]: a user-only DSN (scheme://token@host, no password) is the
  // shape of BETTERSTACK_API_SENTRY_DSN in the real dev and staging profiles, and its token
  // alone authenticates against the deployment it points at. The host rule must judge it.
  it('fails a user-only DSN naming a prod host, and the real SENTRY_DSN shape (KRTX-4108 [B])', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        SUPABASE_TOKEN_URL: 'https://token@api.kortix.com/rest/v1',
        BETTERSTACK_API_SENTRY_DSN: 'https://SyNtheticBetterStackToken9@supa.kortix.com/1',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +SUPABASE_TOKEN_URL +names api\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +BETTERSTACK_API_SENTRY_DSN +names supa\.kortix\.com/);
  });

  // The real dev/staging DSN points at the shared Better Stack ingestion host, which is not
  // the prod apex: a user-only DSN must be judged, not denied for being one.
  it('keeps a user-only DSN at the shared Better Stack host allowed (KRTX-4108 [B])', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        BETTERSTACK_API_SENTRY_DSN:
          'https://SyNtheticBetterStackToken9@s2347088.eu-nbg-2.betterstackdata.com/1',
        DEV_API: 'https://deploy-token@dev-api.kortix.com/v1',
      }),
    });
    expect(r.code, r.out).toBe(0);
  });

  // Strix finding 407a920a: a prod host is any label under the apex, not three literal
  // names, and a client's spelling of the same host does not launder it.
  it('names every label under the prod apex, and keeps dev, staging and internal (KRTX-4108 item 4)', () => {
    const r = run({
      prod: {},
      nonProd: nonProd({
        SUPABASE_URL: 'postgres://u:p@supa.kortix.com:5432/db',
        KORTIX_GATEWAY_URL: 'postgres://u:p@gateway.kortix.com:6543/db',
        DATABASE_URL: 'postgres://u:p@API.KORTIX.COM.:5432/db',
        PIPEDREAM:
          'postgres://u:p@api-ecs-fargate.kortix.com:5432/db|postgres://u:p@dev.kortix.com:5432/db',
        DEV_DB: 'postgres://u:p@dev-api.kortix.com:5432/db',
        STAGE_DB: 'postgres://u:p@staging.kortix.com:5432/db',
        LOCAL_DB: 'postgres://u:p@db.kortix.internal:5432/db',
        FRONTEND_URL: 'https://kortix.com/pricing',
      }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ local +SUPABASE_URL +names supa\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +KORTIX_GATEWAY_URL +names gateway\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +DATABASE_URL +names api\.kortix\.com/);
    expect(r.out).toMatch(/✗ local +PIPEDREAM +names api-ecs-fargate\.kortix\.com/);
    expect(r.out).not.toMatch(/DEV_DB|STAGE_DB|LOCAL_DB|FRONTEND_URL/);
  });

  // KRTX-4108 review item 2: a green run must prove prod decrypted. A ciphertext prod
  // value can never equal a plaintext non-prod one, so the value track would pass vacuously.
  it('fails instead of passing when the prod profile did not decrypt (KRTX-4108 item 2)', () => {
    const r = run({
      prod: {},
      rawProd: 'DATABASE_URL=encrypted:BHBGJpUn\n',
      nonProd: nonProd({ DATABASE_URL: 'postgres://local-db/kortix' }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/prod did not decrypt/);
  });

  // The same refusal covers a non-prod profile: an undecrypted dev profile compares against
  // nothing and would report `✓ dev 0 unallowed` it never earned, so the run fails there too.
  it('fails instead of passing when a non-prod profile did not decrypt (KRTX-4108 item 2)', () => {
    const r = run({
      prod: { DATABASE_URL: 'postgres://prod-db/everyone' },
      rawDev: 'DATABASE_URL=encrypted:GJROHNCe\n',
      nonProd: nonProd({ KORTIX_X: 'local' }),
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/\.env\.dev did not decrypt — the value comparison cannot run/);
  });

  // The committed profiles are the ones `pnpm test:envs` reads on a host that can decrypt
  // prod: a brand key missing from the shipped allowlist fails dev and staging there.
  it('ships an allowlist entry for every brand value the committed profiles hold', () => {
    const shipped = readFileSync(
      resolve(root, 'scripts/secrets-shared-with-prod.allowlist'),
      'utf8',
    );
    const listed = new Set(
      shipped
        .split('\n')
        .map((l) => /^([A-Z][A-Z0-9_]+)\s/.exec(l)?.[1])
        .filter(Boolean),
    );
    // Brand values: one public zone, sender address or host name serves every environment.
    for (const key of [
      'CLOUDFLARE_ZONE_NAME',
      'MAILTRAP_FROM_EMAIL',
      'RESEND_FROM_EMAIL',
      'RESEND_MANAGED_DOMAIN',
      'KORTIX_PREVIEW_BASE_DOMAIN',
      'BETTERSTACK_API_LOG_HOST',
    ])
      expect(listed, `${key} is shared by every environment`).toContain(key);
  });
});
