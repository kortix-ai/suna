import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  EXPECTED_PRODUCTION_BACKEND_URL,
  EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF,
  EXPECTED_PRODUCTION_SUPABASE_URL,
  parseRuntimeConfigScript,
  validateDeployedProductionSupabase,
  validateProductionSupabaseEnv,
} from './validate-production-supabase-env.mjs';

function jwtFor(ref, role = 'anon') {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ref, role })}.signature`;
}

function successfulFetch() {
  return async () => new Response('{}', { status: 200 });
}

function productionEnv(overrides = {}) {
  return {
    VERCEL_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: EXPECTED_PRODUCTION_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtFor(EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF),
    ...overrides,
  };
}

describe('validateProductionSupabaseEnv', () => {
  it('does not enforce the production project outside a Vercel production build', async () => {
    const result = await validateProductionSupabaseEnv(
      {
        VERCEL_ENV: 'preview',
        NEXT_PUBLIC_SUPABASE_URL: 'https://preview.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'preview-key',
      },
      { fetchImpl: async () => assert.fail('preview validation must not call Supabase') },
    );

    assert.deepEqual(result, { skipped: true });
  });

  it('accepts the pinned EU project URL and anon key', async () => {
    const calls = [];
    const result = await validateProductionSupabaseEnv(productionEnv(), {
      fetchImpl: async (url, init) => {
        calls.push({ url, apikey: init.headers.apikey });
        return new Response('{}', { status: 200 });
      },
    });

    assert.equal(result.projectRef, EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF);
    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        `${EXPECTED_PRODUCTION_SUPABASE_URL}/auth/v1/settings`,
        `https://${EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co/auth/v1/settings`,
      ],
    );
    assert.ok(
      calls.every(({ apikey }) => apikey === productionEnv().NEXT_PUBLIC_SUPABASE_ANON_KEY),
    );
  });

  it('rejects a production anon key from another Supabase project', async () => {
    await assert.rejects(
      validateProductionSupabaseEnv(
        productionEnv({
          NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtFor('uhrwvisbqjfxhxjvoofd'),
        }),
        { fetchImpl: successfulFetch() },
      ),
      /anon key project ref uhrwvisbqjfxhxjvoofd does not match required production ref jbriwassebxdwoieikga/,
    );
  });

  it('rejects a production URL outside the pinned EU project', async () => {
    await assert.rejects(
      validateProductionSupabaseEnv(
        productionEnv({
          NEXT_PUBLIC_SUPABASE_URL: 'https://uhrwvisbqjfxhxjvoofd.supabase.co',
        }),
        { fetchImpl: successfulFetch() },
      ),
      /NEXT_PUBLIC_SUPABASE_URL must be https:\/\/supa\.kortix\.com or the native EU project URL/,
    );
  });

  it('rejects conflicting URL aliases before Next.js can select one', async () => {
    await assert.rejects(
      validateProductionSupabaseEnv(
        productionEnv({
          SUPABASE_URL: EXPECTED_PRODUCTION_SUPABASE_URL,
          KORTIX_PUBLIC_SUPABASE_URL: 'https://uhrwvisbqjfxhxjvoofd.supabase.co',
        }),
        { fetchImpl: successfulFetch() },
      ),
      /KORTIX_PUBLIC_SUPABASE_URL must be https:\/\/supa\.kortix\.com or the native EU project URL/,
    );
  });

  it('rejects conflicting anon-key aliases', async () => {
    await assert.rejects(
      validateProductionSupabaseEnv(
        productionEnv({
          SUPABASE_ANON_KEY: jwtFor(EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF),
          KORTIX_PUBLIC_SUPABASE_ANON_KEY: `${jwtFor(EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF)}-rotated`,
        }),
        { fetchImpl: successfulFetch() },
      ),
      /production Supabase anon-key variables must contain one identical value/,
    );
  });

  it('rejects a key that the pinned native project does not accept', async () => {
    await assert.rejects(
      validateProductionSupabaseEnv(productionEnv(), {
        fetchImpl: async (url) =>
          new Response('{}', {
            status: url.includes(EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF) ? 401 : 200,
          }),
      }),
      /Supabase validation failed with HTTP 401/,
    );
  });
});

describe('deployed production validation', () => {
  const key = jwtFor(EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF);
  const config = {
    SUPABASE_URL: EXPECTED_PRODUCTION_SUPABASE_URL,
    SUPABASE_ANON_KEY: key,
    BACKEND_URL: EXPECTED_PRODUCTION_BACKEND_URL,
    VERSION: '0.11.0',
  };
  const script =
    `window.__KORTIX_RUNTIME_CONFIG=${JSON.stringify(config)};` +
    'window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;';

  it('parses the public runtime bootstrap without evaluating JavaScript', () => {
    assert.deepEqual(parseRuntimeConfigScript(script), config);
  });

  it('validates the deployed version, backend, custom domain, and native project', async () => {
    const calls = [];
    const result = await validateDeployedProductionSupabase(
      'https://kortix.com/api/runtime-config',
      {
        expectedVersion: '0.11.0',
        fetchImpl: async (url) => {
          calls.push(url);
          return url.endsWith('/api/runtime-config')
            ? new Response(script, { status: 200 })
            : new Response('{}', { status: 200 });
        },
      },
    );

    assert.equal(result.projectRef, EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF);
    assert.deepEqual(calls, [
      'https://kortix.com/api/runtime-config',
      `${EXPECTED_PRODUCTION_SUPABASE_URL}/auth/v1/settings`,
      `https://${EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co/auth/v1/settings`,
    ]);
  });

  it('rejects a stale deployed frontend version', async () => {
    await assert.rejects(
      validateDeployedProductionSupabase('https://kortix.com/api/runtime-config', {
        expectedVersion: '0.11.1',
        fetchImpl: async () => new Response(script, { status: 200 }),
      }),
      /runtime config version 0\.11\.0 does not match release 0\.11\.1/,
    );
  });

  it('rejects a deployed frontend that points at another backend', async () => {
    const wrongBackendScript = `window.__KORTIX_RUNTIME_CONFIG=${JSON.stringify({
      ...config,
      BACKEND_URL: 'https://api-use2-shadow.kortix.com/v1',
    })};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`;

    await assert.rejects(
      validateDeployedProductionSupabase('https://kortix.com/api/runtime-config', {
        expectedVersion: '0.11.0',
        fetchImpl: async () => new Response(wrongBackendScript, { status: 200 }),
      }),
      /does not match https:\/\/api\.kortix\.com\/v1/,
    );
  });
});

describe('release wiring', () => {
  it('runs the guard inside the frontend build command', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );

    assert.match(
      packageJson.scripts.build,
      /^node scripts\/validate-production-supabase-env\.mjs && /,
    );
    assert.match(
      packageJson.scripts.build,
      /NODE_OPTIONS="\$\{NODE_OPTIONS:---max-old-space-size=6144\}" next build$/,
    );
  });

  it('blocks the GitHub release and banner clear on deployed frontend proof', async () => {
    const workflow = await readFile(
      new URL('../../../.github/workflows/deploy-prod.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /frontend-auth-proof:\n/);
    assert.match(
      workflow,
      /needs: \[version, retag-images, build-cli, deploy-ecs, verify-live-version, frontend-auth-proof\]/,
    );
    assert.match(
      workflow,
      /maintenance-banner-off:[\s\S]*?needs: \[verify-live-version, frontend-auth-proof\]/,
    );
  });
});
