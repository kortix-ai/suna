import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Runtime env keys this module reads. Stripped from the child process to
// reproduce the production BUILD environment, where `KORTIX_PUBLIC_*` /
// `NEXT_PUBLIC_*` values are injected at RUNTIME and are legitimately absent
// while Next.js collects page data.
const RUNTIME_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'KORTIX_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'KORTIX_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'BACKEND_URL',
  'KORTIX_PUBLIC_BACKEND_URL',
  'NEXT_PUBLIC_BACKEND_URL',
];

const webRoot = join(import.meta.dir, '..', '..');

function envWithoutRuntimeKeys(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !RUNTIME_ENV_KEYS.includes(key)) clean[key] = value;
  }
  return clean;
}

describe('env-config module import', () => {
  // Regression: a top-level `export const env = getEnv()` ran zod validation at
  // import time and threw a ZodError when runtime env was absent, failing
  // `next build` with "Failed to collect page data". Importing the module must
  // have no eager side effect — validation belongs in `getEnv()` at call time.
  test('importing the module does not throw when runtime env is absent', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', 'await import("./src/lib/env-config.ts")'],
      cwd: webRoot,
      env: envWithoutRuntimeKeys(),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  });
});

describe('env-config server branch BACKEND_URL precedence', () => {
  // Regression (same-origin deployments): in the sandbox/local stack the web
  // runs with a SAME-ORIGIN env shape — `NEXT_PUBLIC_BACKEND_URL=/v1` for the
  // browser (proxied by next.config rewrites) plus an absolute
  // `BACKEND_URL` for server-side SDK fetches. The server branch must prefer
  // the ABSOLUTE value (mirroring `SUPABASE_URL` right above it): a relative
  // URL here makes every server-side `fetch()` throw `Failed to parse URL`,
  // and each caller silently falls back to empty data (e.g. the marketplace
  // item page served its notFound() 404). The browser is unaffected: it reads
  // `window.__KORTIX_RUNTIME_CONFIG`, which the server serializes from the
  // public values (see public-env-server.ts).
  test('prefers the absolute BACKEND_URL over the root-relative public value', () => {
    const env = {
      ...envWithoutRuntimeKeys(),
      SUPABASE_URL: 'http://127.0.0.1:13321',
      SUPABASE_ANON_KEY: 'test-anon-key',
      BACKEND_URL: 'http://127.0.0.1:13008/v1',
      KORTIX_PUBLIC_BACKEND_URL: '/v1',
      NEXT_PUBLIC_BACKEND_URL: '/v1',
    };
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        'const { getEnv } = await import("./src/lib/env-config.ts");' +
          'console.log(getEnv().BACKEND_URL);',
      ],
      cwd: webRoot,
      env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    expect(out).toBe('http://127.0.0.1:13008/v1');
  });

  // When no absolute value exists (production build without BACKEND_URL), the
  // public values remain the source — unchanged behavior.
  test('falls back to the public value when BACKEND_URL is absent', () => {
    const env = {
      ...envWithoutRuntimeKeys(),
      SUPABASE_URL: 'http://127.0.0.1:13321',
      SUPABASE_ANON_KEY: 'test-anon-key',
      NEXT_PUBLIC_BACKEND_URL: 'https://api.example.com/v1',
    };
    delete env.BACKEND_URL;
    delete env.KORTIX_PUBLIC_BACKEND_URL;
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        'const { getEnv } = await import("./src/lib/env-config.ts");' +
          'console.log(getEnv().BACKEND_URL);',
      ],
      cwd: webRoot,
      env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    expect(out).toBe('https://api.example.com/v1');
  });
});
