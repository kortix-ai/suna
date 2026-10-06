import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'infra/scripts/copy-env-secret.sh');

// A fake `aws` that keeps each secret in <store>/<region>__<name>.json and
// implements only the four secretsmanager calls the script makes.
const fakeAws = `#!/usr/bin/env bash
set -euo pipefail
op="$2"; shift 2
region="" id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --secret-id|--name) id="$2"; shift 2 ;;
    *) shift ;;
  esac
done
file="$STORE/\${region}__\${id}.json"
case "$op" in
  get-secret-value) cat "$file" ;;
  describe-secret) [ -f "$file" ] ;;
  put-secret-value|create-secret) cat > "$file" ;;
esac
`;

function setup(secrets: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), 'copy-env-secret-'));
  writeFileSync(join(dir, 'aws'), fakeAws);
  chmodSync(join(dir, 'aws'), 0o755);
  for (const [key, value] of Object.entries(secrets)) {
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(value));
  }
  const run = (...args: string[]) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STORE: dir },
    });
  const read = (key: string) => {
    const path = join(dir, `${key}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  };
  return { run, read };
}

describe('copy-env-secret.sh', () => {
  const source = { DATABASE_URL: 'postgres://synthetic', API_KEY: 'synthetic-value' };

  it('creates the copy in the target region with background workers off, and prints no value', () => {
    const { run, read } = setup({ 'us-west-2__kortix-dev-env': source });
    const result = run('kortix-dev-env', 'us-west-2', 'us-east-2', '--workers', 'off');

    expect(result.status).toBe(0);
    expect(read('us-east-2__kortix-dev-env')).toEqual({ ...source, KORTIX_WORKERS_ENABLED: 'false' });
    expect(read('us-west-2__kortix-dev-env')).toEqual(source);
    expect(result.stdout).toContain('created us-east-2/kortix-dev-env from us-west-2/kortix-dev-env: 3 keys');
    expect(result.stdout + result.stderr).not.toContain('synthetic');
  });

  it('writes a new version under another name and turns workers on', () => {
    const { run, read } = setup({
      'us-west-2__kortix-dev-web-env': source,
      'us-east-2__kortix-dev-use2-web-env': { OLD: 'x' },
    });
    const result = run(
      'kortix-dev-web-env', 'us-west-2', 'us-east-2', '--to-name', 'kortix-dev-use2-web-env', '--workers', 'on',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('updated us-east-2/kortix-dev-use2-web-env');
    expect(read('us-east-2__kortix-dev-use2-web-env')).toEqual({ ...source, KORTIX_WORKERS_ENABLED: 'true' });
  });

  it('--check names the drifted keys, ignores the workers flag, and writes nothing', () => {
    const { run, read } = setup({
      'us-west-2__kortix-dev-env': { ...source, KORTIX_WORKERS_ENABLED: 'true' },
      'us-east-2__kortix-dev-env': { ...source, API_KEY: 'rotated', KORTIX_WORKERS_ENABLED: 'false' },
    });

    const drifted = run('kortix-dev-env', 'us-west-2', 'us-east-2', '--check');
    expect(drifted.status).toBe(1);
    expect(drifted.stdout.trim()).toBe('differ: API_KEY');
    expect(drifted.stdout).not.toContain('rotated');
    expect(read('us-east-2__kortix-dev-env').API_KEY).toBe('rotated');

    run('kortix-dev-env', 'us-west-2', 'us-east-2', '--workers', 'off');
    const synced = run('kortix-dev-env', 'us-west-2', 'us-east-2', '--check');
    expect(synced.status).toBe(0);
  });

  it('refuses a non-string value, the same secret as target, and a bad --workers value', () => {
    const { run, read } = setup({ 'us-west-2__bad': { N: 1 } as unknown as Record<string, string> });

    expect(run('bad', 'us-west-2', 'us-east-2').status).not.toBe(0);
    expect(read('us-east-2__bad')).toBeUndefined();
    expect(run('x', 'us-west-2', 'us-west-2').status).toBe(2);
    expect(run('x', 'us-west-2', 'us-east-2', '--workers', 'maybe').status).toBe(2);
  });
});
