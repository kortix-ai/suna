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
