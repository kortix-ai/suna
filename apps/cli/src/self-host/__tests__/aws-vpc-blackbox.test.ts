import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');

describe('kortix self-host aws-vpc', () => {
  let tmp: string;
  let configRoot: string;
  let fakeBin: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-aws-vpc-cli-'));
    configRoot = join(tmp, 'self-host');
    fakeBin = join(tmp, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const aws = join(fakeBin, 'aws');
    writeFileSync(
      aws,
      `#!/bin/sh
case "$*" in
  *"sts get-caller-identity"*)
    printf '%s\n' '{"UserId":"fake","Account":"935064898258","Arn":"arn:aws:iam::935064898258:user/fake"}'
    ;;
  *"--version"*) printf '%s\n' 'aws-cli/2.31.0' ;;
  *) printf '%s\n' "unexpected aws args: $*" >&2; exit 64 ;;
esac
`,
    );
    chmodSync(aws, 0o755);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function run(args: string[]) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args],
      cwd: tmp,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test('initializes a secret-free instance pinned to the verified AWS account', async () => {
    const result = await run([
      'init',
      '--target', 'aws-vpc',
      '--instance', 'kortix-vpc-demo',
      '--aws-profile', 'default',
      '--region', 'us-west-2',
      '--channel', 'stable',
      '--yes',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('✗');
    expect(JSON.parse(result.stdout)).toMatchObject({
      instance: 'kortix-vpc-demo',
      target: 'aws-vpc',
      channel: 'stable',
      aws: {
        profile: 'default',
        region: 'us-west-2',
        account_id: '935064898258',
      },
    });
    const instanceDir = join(configRoot, 'kortix-vpc-demo');
    expect(JSON.parse(readFileSync(join(instanceDir, 'instance.json'), 'utf8'))).toMatchObject({
      target: 'aws-vpc',
      aws: { account_id: '935064898258' },
    });
    expect(existsSync(join(instanceDir, '.env'))).toBe(false);
  });

  test('does not reinterpret Docker lifecycle commands for AWS', async () => {
    const initialized = await run([
      'init', '--target', 'aws-vpc', '--instance', 'enterprise', '--aws-profile', 'default', '--region', 'us-west-2', '--yes',
    ]);
    expect(initialized.code).toBe(0);

    const result = await run(['start', '--instance', 'enterprise']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('start is only available for Docker targets');
    expect(result.stderr).toContain('kortix self-host deploy --instance enterprise');
  });

  test('advertises the production management command surface', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('plan');
    expect(result.stdout).toContain('deploy');
    expect(result.stdout).toContain('reconcile');
    expect(result.stdout).toContain('rollback');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('--target <target>');
    expect(result.stdout).toContain('--aws-profile <name>');
  });
});
