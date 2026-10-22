import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_REPO_ROOT, pinnedSupabaseVersion, resolveSupabaseCli, supabaseVersionOf } from '../lib';

/** A throwaway checkout root pinning supabase 2.116.0, with or without its installed binary. */
function checkout(withPinnedBin: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-supabase-pin-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { supabase: '2.116.0' } }));
  if (withPinnedBin) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'supabase'), '#!/bin/sh\necho 2.116.0\n');
    chmodSync(join(root, 'node_modules', '.bin', 'supabase'), 0o755);
  }
  return root;
}

describe('the supabase CLI every worktree command runs', () => {
  test('is the pinned binary whenever it is installed, whatever PATH holds', () => {
    const root = checkout(true);
    const cli = resolveSupabaseCli({ root, pathBin: '/opt/homebrew/bin/supabase', version: () => '2.120.0' });
    expect(cli).toEqual({ bin: join(root, 'node_modules', '.bin', 'supabase'), refusal: null });
  });

  test('falls back to PATH without the pin installed, and refuses a version other than the pin', () => {
    const root = checkout(false);
    const refused = resolveSupabaseCli({ root, pathBin: '/opt/homebrew/bin/supabase', version: () => '2.120.0' });
    expect(refused.refusal).toContain('2.120.0');
    expect(refused.refusal).toContain('2.116.0');
    expect(refused.refusal).toContain('42P10');
    expect(refused.refusal).toContain(`(cd ${root} && pnpm install)`);
    // A probe that cannot run is no proof of the pin either.
    expect(resolveSupabaseCli({ root, pathBin: '/x/supabase', version: () => null }).refusal).toContain('unknown version');
    expect(resolveSupabaseCli({ root, pathBin: '/x/supabase', version: () => '2.116.0' })).toEqual({ bin: '/x/supabase', refusal: null });
    expect(resolveSupabaseCli({ root, pathBin: null, version: () => null })).toEqual({ bin: null, refusal: null });
  });

  test('the version probe reports a binary that cannot run as null instead of throwing', () => {
    expect(supabaseVersionOf('/nonexistent/supabase')).toBeNull();
    expect(supabaseVersionOf(join(checkout(true), 'node_modules', '.bin', 'supabase'))).toBe('2.116.0');
  });

  test('the repo root comes from the CLI location, not the cwd, and pins an exact version', () => {
    expect(CLI_REPO_ROOT).toBe(join(import.meta.dir, '..', '..', '..'));
    expect(pinnedSupabaseVersion(CLI_REPO_ROOT)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinnedSupabaseVersion(join(checkout(false), 'missing'))).toBeNull();
  });
});
