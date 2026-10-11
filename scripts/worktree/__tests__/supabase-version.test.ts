import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedSupabaseVersion, supabaseVersionWarning } from '../lib';

describe('supabase CLI version pin', () => {
  test('warns only when the CLI on PATH differs from the pin', () => {
    expect(supabaseVersionWarning('2.116.0', '2.116.0')).toBeNull();
    expect(supabaseVersionWarning(null, '2.116.0')).toBeNull();
    expect(supabaseVersionWarning('2.120.0', null)).toBeNull();
    const warning = supabaseVersionWarning('2.120.0', '2.116.0');
    expect(warning).toContain('2.120.0');
    expect(warning).toContain('2.116.0');
    expect(warning).toContain('42P10');
    expect(warning).toContain('node_modules/.bin');
  });

  test('reads the pin from the root package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-supabase-pin-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { supabase: '2.116.0' } }));
    expect(pinnedSupabaseVersion(root)).toBe('2.116.0');
    expect(pinnedSupabaseVersion(join(root, 'missing'))).toBeNull();
  });

  test('the repo pins an exact version', () => {
    expect(pinnedSupabaseVersion(join(import.meta.dir, '../../..'))).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
