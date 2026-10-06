import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dir, '../index.ts');
const MiB = 1024 * 1024;
const dirs: string[] = [];
// One CLI process per test; under `--parallel=4` a cold start can take seconds.
const SPAWN_TEST_MS = 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(git = true): string {
  const cwd = mkdtempSync(join(tmpdir(), 'repo-size-'));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'kortix.yaml'), 'kortix_version: 1\nproject:\n  name: size-test\n');
  if (git) Bun.spawnSync(['git', 'init', '-q'], { cwd });
  return cwd;
}

function validate(cwd: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_CONFIG_FILE: join(cwd, 'config.json'),
  };
  delete env.KORTIX_TOKEN;
  const result = Bun.spawnSync([process.execPath, cli, 'validate', '--json'], { cwd, env, timeout: 30_000 });
  const report = JSON.parse(result.stdout.toString()) as {
    valid: boolean;
    issues: { path: string; message: string; severity: string }[];
  };
  return { exitCode: result.exitCode, report, size: report.issues.find((i) => i.path === 'repository') };
}

describe('kortix validate — repository size', () => {
  test('a small repository gets no size warning', () => {
    const r = validate(project());
    expect(r.exitCode).toBe(0);
    expect(r.size).toBeUndefined();
  }, SPAWN_TEST_MS);

  test('one large file is a warning that names it, never an error', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'assets'));
    writeFileSync(join(cwd, 'assets/demo.mp4'), Buffer.alloc(11 * MiB));
    const r = validate(cwd);
    expect(r.exitCode).toBe(0);
    expect(r.report.valid).toBe(true);
    expect(r.size?.severity).toBe('warning');
    expect(r.size?.message).toContain('assets/demo.mp4 (11.0 MiB)');
    expect(r.size?.message).toContain('object storage');
  }, SPAWN_TEST_MS);

  test('many medium files over the release limit are a warning', () => {
    const cwd = project();
    for (let i = 0; i < 4; i++) writeFileSync(join(cwd, `part-${i}.bin`), Buffer.alloc(9 * MiB));
    const r = validate(cwd);
    expect(r.exitCode).toBe(0);
    expect(r.size?.message).toContain('36.0 MiB');
    expect(r.size?.message).toContain('32 MiB');
  }, SPAWN_TEST_MS);

  test('gitignored and export-ignore files do not count', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'assets'));
    mkdirSync(join(cwd, 'build'));
    writeFileSync(join(cwd, 'assets/demo.mp4'), Buffer.alloc(11 * MiB));
    writeFileSync(join(cwd, 'build/out.bin'), Buffer.alloc(11 * MiB));
    writeFileSync(join(cwd, '.gitattributes'), 'assets/** export-ignore\n');
    writeFileSync(join(cwd, '.gitignore'), 'build/\n');
    expect(validate(cwd).size).toBeUndefined();
  }, SPAWN_TEST_MS);

  test('a folder that is not a git repository skips the check', () => {
    const cwd = project(false);
    writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(11 * MiB));
    const r = validate(cwd);
    expect(r.exitCode).toBe(0);
    expect(r.size).toBeUndefined();
  }, SPAWN_TEST_MS);
});
