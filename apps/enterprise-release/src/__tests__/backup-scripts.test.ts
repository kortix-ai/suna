import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { materializeSupabaseBundle } from '../bundles.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kortix-backup-scripts-'));
  roots.push(root);
  const bundle = join(root, 'bundle');
  const bin = join(root, 'bin');
  const spool = join(root, 'wal');
  const locks = join(root, 'locks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(spool, { recursive: true });
  mkdirSync(locks, { recursive: true });
  materializeSupabaseBundle(bundle, '0.9.84-e1');

  const instanceEnv = join(root, 'instance.env');
  writeFileSync(instanceEnv, [
    'AWS_REGION=us-west-2',
    'KORTIX_INSTANCE=customer-zero',
    'KORTIX_BACKUP_BUCKET=customer-zero-backups',
    'KORTIX_BACKUP_KMS_KEY_ARN=arn:aws:kms:us-west-2:935064898258:key/test',
    'KORTIX_STATE_TABLE=customer-zero-release-state',
    '',
  ].join('\n'));
  const log = join(root, 'aws.log');
  const manifest = join(root, 'manifest.json');

  executable(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -c ] && [ "\${2:-}" = %s ]; then wc -c <"\$3" | tr -d ' '; else exec /usr/bin/stat "\$@"; fi
`);
  executable(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf physical-backup\n');
  executable(join(bin, 'aws'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"\$FAKE_AWS_LOG"
if [ "\${1:-} \${2:-}" = 's3api head-object' ]; then
  if [[ " \$* " == *' --checksum-mode '* ]]; then
    printf '%s\n' '{"ContentLength":15,"ChecksumSHA256":"ZmFrZS1zaGEyNTY="}'
  else
    printf '%s\n' "\$FAKE_WAL_SIZE"
  fi
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = 's3 cp -' ]; then
  if [[ "\${4:-}" == */manifest.json ]]; then cat >"\$FAKE_MANIFEST"; else cat >/dev/null; fi
fi
`);

  return {
    root,
    bundle,
    spool,
    log,
    manifest,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      KORTIX_INSTANCE_ENV_FILE: instanceEnv,
      KORTIX_WAL_SPOOL: spool,
      KORTIX_BACKUP_LOCK_DIR: locks,
      FAKE_AWS_LOG: log,
      FAKE_MANIFEST: manifest,
      FAKE_WAL_SIZE: '5',
    },
  };
}

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function pitrFixture(promotes: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'kortix-pitr-script-'));
  roots.push(root);
  const bundle = join(root, 'bundle');
  const bin = join(root, 'bin');
  const data = join(root, 'postgres');
  const recovery = join(root, 'recovery-wal');
  const restores = join(root, 'restores');
  const locks = join(root, 'locks');
  const baseSource = join(root, 'base-source');
  const baseArchive = join(root, 'base.tar.gz');
  const walSource = join(root, '000000010000000000000001');
  for (const path of [bin, data, recovery, restores, locks, baseSource]) mkdirSync(path, { recursive: true });
  materializeSupabaseBundle(bundle, '0.9.84-e1');
  writeFileSync(join(bundle, '.instance'), 'customer-zero\n');
  writeFileSync(join(bundle, '.env'), 'POSTGRES_PASSWORD=test\n');
  writeFileSync(join(data, 'old-cluster-marker'), 'original');
  writeFileSync(join(recovery, 'old-recovery-marker'), 'original');
  writeFileSync(join(baseSource, 'PG_VERSION'), '17\n');
  writeFileSync(join(baseSource, 'postgresql.auto.conf'), 'shared_buffers = 128MB\n');
  const tar = spawnSync('tar', ['-czf', baseArchive, '-C', baseSource, '.'], { encoding: 'utf8' });
  expect(tar.status, tar.stderr).toBe(0);
  const bytes = readFileSync(baseArchive);
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, `${JSON.stringify({
    schema_version: 1,
    instance: 'customer-zero',
    created_at: '2026-07-13T10:00:00Z',
    object_key: 'basebackups/customer-zero/20260713T100000Z/base.tar.gz',
    checksum_sha256: createHash('sha256').update(bytes).digest('base64'),
    length: bytes.byteLength,
  })}\n`);
  writeFileSync(walSource, 'wal-segment');
  const instanceEnv = join(root, 'instance.env');
  writeFileSync(instanceEnv, [
    'AWS_REGION=us-west-2',
    'KORTIX_INSTANCE=customer-zero',
    'KORTIX_BACKUP_BUCKET=customer-zero-backups',
    'KORTIX_STATE_TABLE=customer-zero-release-state',
    '',
  ].join('\n'));
  const log = join(root, 'commands.log');

  executable(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'systemctl'), `#!/usr/bin/env bash
printf 'systemctl %s\\n' "\$*" >>"\$FAKE_COMMAND_LOG"
exit 0
`);
  executable(join(bin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -c ] && [ "\${2:-}" = %s ]; then wc -c <"\$3" | tr -d ' '; else exec /usr/bin/stat "\$@"; fi
`);
  executable(join(bin, 'date'), `#!/usr/bin/env bash
set -euo pipefail
case "\$*" in
  '-u -d 2026-07-13T10:00:00Z +%s') printf '100\\n' ;;
  '-u -d 2026-07-13T11:00:00Z +%s') printf '200\\n' ;;
  '-u +%s') printf '300\\n' ;;
  '-u +%Y%m%dT%H%M%SZ') printf '20260713T120000Z\\n' ;;
  '-u +%Y-%m-%dT%H:%M:%SZ') printf '2026-07-13T12:00:00Z\\n' ;;
  *) echo "unexpected date args: \$*" >&2; exit 64 ;;
esac
`);
  executable(join(bin, 'aws'), `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "\$*" >>"\$FAKE_COMMAND_LOG"
if [ "\${1:-} \${2:-}" = 's3 cp' ]; then
  case "\${3:-}" in
    */manifest.json) /bin/cp "\$FAKE_MANIFEST_SOURCE" "\$4" ;;
    */base.tar.gz) /bin/cp "\$FAKE_BASE_SOURCE" "\$4" ;;
    *) echo "unexpected S3 object: \${3:-}" >&2; exit 64 ;;
  esac
  exit 0
fi
if [ "\${1:-} \${2:-}" = 's3 sync' ]; then
  mkdir -p "\$4"
  /bin/cp "\$FAKE_WAL_SOURCE" "\$4/"
  exit 0
fi
if [ "\${1:-} \${2:-}" = 'dynamodb update-item' ]; then printf '{}\\n'; exit 0; fi
echo "unexpected aws args: \$*" >&2
exit 64
`);
  executable(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "\$*" >>"\$FAKE_COMMAND_LOG"
if [[ " \$* " == *' config --images '* ]]; then
  printf 'supabase/postgres:17.6.1.136@sha256:%064d\\n' 0
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = 'exec supabase-db psql' ]; then
  [ "\$FAKE_PROMOTES" = 1 ] && printf 't\\n' || printf 'f\\n'
  exit 0
fi
exit 0
`);

  return {
    root,
    bundle,
    data,
    recovery,
    restores,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      KORTIX_INSTANCE_ENV_FILE: instanceEnv,
      KORTIX_POSTGRES_DATA_DIR: data,
      KORTIX_RECOVERY_WAL_DIR: recovery,
      KORTIX_RESTORE_WORK_DIR: restores,
      KORTIX_BACKUP_LOCK_DIR: locks,
      KORTIX_RESTORE_MAX_ATTEMPTS: '1',
      FAKE_MANIFEST_SOURCE: manifest,
      FAKE_BASE_SOURCE: baseArchive,
      FAKE_WAL_SOURCE: walSource,
      FAKE_COMMAND_LOG: log,
      FAKE_PROMOTES: promotes ? '1' : '0',
    },
  };
}

describe('Supabase physical backup scripts', () => {
  test('uploads and length-verifies a complete WAL segment before deleting the spool copy', () => {
    const test = fixture();
    const wal = join(test.spool, '000000010000000000000001');
    writeFileSync(wal, '12345');

    const result = spawnSync('bash', [join(test.bundle, 'bin/wal-archive')], {
      env: test.env,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(wal)).toBe(false);
    const calls = readFileSync(test.log, 'utf8');
    expect(calls).toContain(`s3 cp ${wal} s3://customer-zero-backups/wal/customer-zero/000000010000000000000001`);
    expect(calls).toContain('s3api head-object');
    expect(calls).toContain('dynamodb update-item --table-name customer-zero-release-state');
  });

  test('refuses an unexpected WAL spool filename without uploading or deleting it', () => {
    const test = fixture();
    const unexpected = join(test.spool, 'not-a-wal-segment');
    writeFileSync(unexpected, 'do-not-upload');

    const result = spawnSync('bash', [join(test.bundle, 'bin/wal-archive')], {
      env: test.env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing unexpected WAL spool file');
    expect(existsSync(unexpected)).toBe(true);
    expect(existsSync(test.log)).toBe(false);
  });

  test('streams pg_basebackup to encrypted S3 and publishes a checksum manifest last', () => {
    const test = fixture();

    const result = spawnSync('bash', [join(test.bundle, 'bin/base-backup')], {
      env: test.env,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(test.log, 'utf8');
    expect(calls).toContain('s3 cp - s3://customer-zero-backups/basebackups/customer-zero/');
    expect(calls).toContain('--checksum-algorithm SHA256');
    expect(calls).toContain('s3api head-object');
    expect(calls).toContain('manifest.json --region us-west-2 --content-type application/json --sse aws:kms --sse-kms-key-id arn:aws:kms:us-west-2:935064898258:key/test --only-show-errors');
    expect(calls).toContain('SET last_base_backup_at = :created_at, last_base_backup_key = :key');
    const lines = calls.trim().split('\n');
    expect(lines.findIndex((line) => line.includes('/manifest.json')))
      .toBeLessThan(lines.findIndex((line) => line.startsWith('dynamodb update-item')));
    expect(JSON.parse(readFileSync(test.manifest, 'utf8'))).toMatchObject({
      schema_version: 1,
      instance: 'customer-zero',
      checksum_sha256: 'ZmFrZS1zaGEyNTY=',
      length: 15,
    });
  });

  test('checksum-verifies a base backup, replays archived WAL, and retains the old cluster', () => {
    const test = pitrFixture(true);
    const result = spawnSync('bash', [join(test.bundle, 'bin/pitr-restore'),
      '--manifest-key', 'basebackups/customer-zero/20260713T100000Z/manifest.json',
      '--target-time', '2026-07-13T11:00:00Z',
      '--confirm-instance', 'customer-zero',
    ], { env: test.env, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(test.data, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(readFileSync(join(test.data, 'postgresql.auto.conf'), 'utf8')).toContain(
      "recovery_target_time = '2026-07-13T11:00:00Z'",
    );
    expect(existsSync(`${test.data}.pre-pitr-20260713T120000Z/old-cluster-marker`)).toBe(true);
    expect(readFileSync(test.log, 'utf8')).toContain('dynamodb update-item --table-name customer-zero-release-state');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 1,
      target_time: '2026-07-13T11:00:00Z',
      manifest_key: 'basebackups/customer-zero/20260713T100000Z/manifest.json',
    });
  });

  test('automatically restores the original cluster when PostgreSQL cannot reach the target', () => {
    const test = pitrFixture(false);
    const result = spawnSync('bash', [join(test.bundle, 'bin/pitr-restore'),
      '--manifest-key', 'basebackups/customer-zero/20260713T100000Z/manifest.json',
      '--target-time', '2026-07-13T11:00:00Z',
      '--confirm-instance', 'customer-zero',
    ], { env: test.env, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not reach and promote the requested recovery target');
    expect(readFileSync(join(test.data, 'old-cluster-marker'), 'utf8')).toBe('original');
    expect(existsSync(`${test.data}.failed-pitr-20260713T120000Z/PG_VERSION`)).toBe(true);
  });
});
