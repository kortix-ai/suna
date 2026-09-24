import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vercel builds bake the runtime config into prerendered pages
// (apps/web/src/lib/runtime-config-mode.ts). `vercel deploy -e` reaches only the
// runtime, so every staging value must also reach the build through `-b`, or
// staging bakes the project's generic Preview values.
describe('staging Vercel deploy', () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/deploy-staging.yml'),
    'utf8',
  );
  const start = workflow.indexOf('          staging_env=(');
  const end = workflow.indexOf('| tail -n1)"', start);
  const block = workflow.slice(start, end);

  it('passes every staging value to both the build and the runtime', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('env_flags+=(-e "$kv" -b "$kv")');
    expect(block).toContain('"${env_flags[@]}"');
    // No bare runtime-only value may bypass the shared list.
    expect(block).not.toMatch(/^\s+-e \S+=/m);
  });

  it('keeps the values the baked runtime config reads', () => {
    for (const key of [
      'NEXT_PUBLIC_BACKEND_URL',
      'KORTIX_PUBLIC_BACKEND_URL',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_BILLING_ENABLED',
      'NEXT_PUBLIC_AUTH_PROVIDERS',
      'NEXT_PUBLIC_AUTH_METHODS',
    ]) {
      expect(block).toMatch(new RegExp(`^\\s+${key}=`, 'm'));
    }
  });
});
