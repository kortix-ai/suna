import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const CLI_PATH = resolve(import.meta.dir, 'cli.ts');

describe('agent tunnel service UX', () => {
  test('offers persistent daemon mode without an unsupported keep-awake flag', () => {
    const result = spawnSync('bun', ['run', CLI_PATH, 'help'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--daemon');
    expect(result.stdout).toContain('--foreground');
    expect(result.stdout).not.toContain('--keep-awake');
  });

  test('rejects the removed keep-awake flag instead of silently ignoring it', () => {
    const result = spawnSync('bun', ['run', CLI_PATH, 'connect', '--keep-awake'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--keep-awake is not supported');
  });
});
