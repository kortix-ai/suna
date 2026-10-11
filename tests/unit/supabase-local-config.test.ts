import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/**
 * `supabase start` decodes supabase/config.toml before it touches Docker, and
 * which CLI boots the local stack varies by host: scripts/dev-local.sh prefers
 * /opt/supabase and ensurePrimarySupabase uses whatever `supabase` is on PATH.
 * A key the config spec renamed (the pre-rename refresh_token_rotation_enabled)
 * makes every CLI that decodes strictly fail the whole local stack at config
 * parse — `pnpm dev` and `pnpm worktree start` never boot (KRTX-1656) — while
 * the pinned npm CLI tolerates unknown keys and silently drops the setting, so
 * the intended GoTrue behavior would quietly change too. The contract lives in
 * the file, so both surfaces are asserted: the parsed [auth] table must name
 * the rotation switch the way the current config spec does, and the pinned CLI
 * must parse the file without a config error (`supabase status` runs the same
 * parse and never starts or stops a container).
 */
describe('supabase/config.toml', () => {
  it('names the refresh-token rotation switch the way the current config spec does', () => {
    const conf = parse(readFileSync(join(root, 'supabase/config.toml'), 'utf8')) as {
      auth: Record<string, unknown>;
    };
    expect(conf.auth.enable_refresh_token_rotation).toBe(true);
    expect(conf.auth).not.toHaveProperty('refresh_token_rotation_enabled');
    // The KRTX-910 anti-replay setting next to it stays.
    expect(conf.auth.refresh_token_reuse_interval).toBe(0);
  });

  it('parses under the pinned CLI (`supabase status`, side-effect-free)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-config-parse-'));
    mkdirSync(join(dir, 'supabase'));
    copyFileSync(join(root, 'supabase/config.toml'), join(dir, 'supabase/config.toml'));
    const r = spawnSync(join(root, 'node_modules/.bin/supabase'), ['status'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
    });
    // A failed spawn must fail the test, not vacuously pass the assertions.
    expect(r.error).toBeUndefined();
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toMatch(/failed to (parse|read) config/);
    expect(out).not.toContain('invalid keys');
  }, 60_000);
});
