import { describe, expect, test } from 'bun:test';
import { featureHidden, sandboxFeatures, visibleCommands } from './features.ts';
import { TIERS } from './command-table.ts';

const all = TIERS.flatMap((t) => t.sections.flatMap((s) => s.commands));
const names = (cmds: readonly { name: string }[]) => cmds.map((c) => c.name);

describe('sandbox feature visibility', () => {
  test('no KORTIX_FEATURES (human CLI, old sandbox): nothing is hidden', () => {
    expect(sandboxFeatures(undefined)).toBeNull();
    expect(names(visibleCommands(all, null))).toContain('send');
    expect(featureHidden('human_messaging', null)).toBe(false);
  });
  test('flag listed: send shows', () => {
    const f = sandboxFeatures('human_messaging');
    expect(names(visibleCommands(all, f))).toContain('send');
    expect(featureHidden('human_messaging', f)).toBe(false);
  });
  test('"none" and other flags: send is hidden, the rest stay', () => {
    for (const raw of ['none', 'something_else']) {
      const f = sandboxFeatures(raw);
      expect(names(visibleCommands(all, f))).not.toContain('send');
      expect(names(visibleCommands(all, f))).toContain('sessions');
      expect(featureHidden('human_messaging', f)).toBe(true);
    }
  });
});

describe('the real CLI process inside a sandbox', () => {
  const run = (features: string | undefined, args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_FEATURES: features };
    if (features === undefined) delete env.KORTIX_FEATURES;
    const p = Bun.spawnSync(['bun', 'run', 'src/index.ts', ...args], { env: env as Record<string, string>, cwd: `${import.meta.dir}/..` });
    return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
  };
  test('flag off hides send and --asked, and `send` prints one disabled line', () => {
    expect(run('none', ['--help']).out).not.toMatch(/^\s+send\s/m);
    expect(run('none', ['sessions', '--help']).out).not.toContain('--asked');
    const send = run('none', ['send', '--help']);
    expect(send.code).toBe(1);
    expect(send.err).toContain('Human Messaging is not enabled for this project');
    expect(send.out + send.err).not.toContain('Usage:');
  });
  test('flag on, or no variable, keeps them', () => {
    for (const f of ['human_messaging', undefined]) {
      expect(run(f, ['--help']).out).toMatch(/^\s+send\s/m);
      expect(run(f, ['sessions', '--help']).out).toContain('--asked');
    }
  });
});
