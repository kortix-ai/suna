import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The hermetic contract (scripts/hermetic-test-env.sh): the unit suites are
// identical on a laptop, a CI runner and a Kortix worker sandbox. A
// developer's own CLI login — the multi-host store at
// ~/.config/kortix/config.json, including the KRTX-1705 in-sandbox selection
// marker — must not reach the suite through the ambient environment: the
// script has to point KORTIX_CONFIG_FILE at a fresh path the suite owns.

const SCRIPT = resolve(import.meta.dir, '..', '..', '..', '..', 'scripts', 'hermetic-test-env.sh');

/** Source the script under a poisoned ambient environment (the developer
 *  laptop case: a stored login plus ambient KORTIX_* exports) and print the
 *  config path it leaves behind. */
function sourceHermeticEnv(): { config: string; token: string } {
  const proc = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `. '${SCRIPT}' && printf '%s\\n%s' "\${KORTIX_CONFIG_FILE-}" "\${KORTIX_TOKEN-unset}"`,
    ],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      KORTIX_CONFIG_FILE: '/home/dev/.config/kortix/config.json',
      KORTIX_TOKEN: 'kortix_pat_devs_own_login',
    },
  });
  const [config = '', token = ''] = proc.stdout.toString().trim().split('\n');
  return { config, token };
}

describe('hermetic test env', () => {
  test('points the CLI config store at a fresh suite-owned path', () => {
    const { config, token } = sourceHermeticEnv();
    // The stored login itself never survives the script.
    expect(token).toBe('unset');
    // KORTIX_CONFIG_FILE: exported (never falls back to the ambient default
    // path), not the poisoned ambient value, and pointing at a file that does
    // not exist — an empty store, not the developer's.
    expect(config).not.toBe('');
    expect(config.startsWith('/')).toBe(true);
    expect(config).not.toBe('/home/dev/.config/kortix/config.json');
    expect(existsSync(config)).toBe(false);
  });
});
