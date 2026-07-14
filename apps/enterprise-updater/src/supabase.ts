import type { EcsControlPlane } from './ecs.ts';
import type { EnterpriseReleaseManifest } from './release-contract.ts';
import type { CommandRunner } from './process.ts';

const SSM_COMMAND_WAIT_SCRIPT = `
set -euo pipefail
command_id="$1"
instance_id="$2"
region="$3"
deadline=$((SECONDS + 1860))
while (( SECONDS < deadline )); do
  if current=$(aws ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$instance_id" \
    --region "$region" --query Status --output text 2>&1); then
    case "$current" in
      Success|Cancelled|TimedOut|Failed) exit 0 ;;
      Pending|InProgress|Delayed|Cancelling) ;;
      *) printf 'Unexpected SSM command status: %s\n' "$current" >&2; exit 1 ;;
    esac
  elif [[ "$current" != *InvocationDoesNotExist* ]]; then
    printf '%s\n' "$current" >&2
    exit 1
  fi
  sleep 5
done
printf 'SSM command %s did not reach a terminal state within 31 minutes\n' "$command_id" >&2
exit 1
`;

export interface SupabaseConfig {
  region: string;
  instance: string;
  supabaseInstanceId: string;
  runtimeSecretArn: string;
  artifactBucket: string;
  artifactKmsKeyArn: string;
  apiDomain: string;
  frontendDomain: string;
}

/**
 * Drives the official Supabase Docker host on the customer EC2 through SSM
 * RunCommand. The install/finalize/rollback scripts keep their proven
 * transactional semantics (symlink swap + previous-release restore). Database
 * durability is handled out-of-band by encrypted EBS + hourly AWS Backup, not by
 * any in-host log-shipping or point-in-time tooling.
 */
export class SupabaseInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly aws: Pick<EcsControlPlane, 'awsJson' | 'awsRaw'>,
    private readonly config: SupabaseConfig,
  ) {}

  install(manifest: EnterpriseReleaseManifest, archive: string): void {
    const key = `updater-staging/${manifest.artifacts.supabase_bundle.sha256}.tar.gz`;
    this.aws.awsRaw([
      's3', 'cp', archive, `s3://${this.config.artifactBucket}/${key}`,
      '--sse', 'aws:kms', '--sse-kms-key-id', this.config.artifactKmsKeyArn,
    ]);
    const script = supabaseInstallScript({
      bucket: this.config.artifactBucket,
      key,
      sha256: manifest.artifacts.supabase_bundle.sha256,
      version: manifest.version,
      runtimeSecretArn: this.config.runtimeSecretArn,
      instance: this.config.instance,
      apiDomain: this.config.apiDomain,
      frontendDomain: this.config.frontendDomain,
    });
    this.run(`Install verified Kortix enterprise release ${manifest.version}`, script);
  }

  finalize(manifest: EnterpriseReleaseManifest): void {
    this.run(
      `Commit Kortix enterprise release ${manifest.version}`,
      supabaseFinalizeScript(manifest.version, manifest.artifacts.supabase_bundle.sha256),
    );
  }

  rollback(manifest: EnterpriseReleaseManifest): void {
    this.run(
      `Rollback Supabase after failed Kortix enterprise release ${manifest.version}`,
      supabaseRollbackScript(manifest.version, manifest.artifacts.supabase_bundle.sha256),
    );
  }

  private run(comment: string, script: string): void {
    const response = this.aws.awsJson<{ Command?: { CommandId?: string } }>([
      'ssm', 'send-command', '--document-name', 'AWS-RunShellScript',
      '--instance-ids', this.config.supabaseInstanceId,
      '--comment', comment,
      '--parameters', JSON.stringify({ commands: [script], executionTimeout: ['1800'] }),
    ]);
    const commandId = response.Command?.CommandId;
    if (!commandId) throw new Error('SSM did not return a command id for Supabase installation');
    this.runner.run('bash', [
      '-ceu', SSM_COMMAND_WAIT_SCRIPT, 'bash', commandId,
      this.config.supabaseInstanceId, this.config.region,
    ]);
    const result = this.aws.awsJson<{ Status?: string; StandardErrorContent?: string }>([
      'ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', this.config.supabaseInstanceId,
    ]);
    if (result.Status !== 'Success') {
      throw new Error(`Supabase installation failed through SSM: ${(result.StandardErrorContent ?? result.Status ?? 'unknown').slice(0, 500)}`);
    }
  }
}

export function verifyPublicHealth(
  runner: CommandRunner,
  manifest: EnterpriseReleaseManifest,
  apiDomain: string,
  frontendDomain: string,
): void {
  const apiUrl = `https://${apiDomain}${manifest.health.api_path}`;
  const api = curlWithRetry(runner, [
    '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2', apiUrl,
  ], apiUrl);
  let health: Record<string, unknown>;
  try {
    health = JSON.parse(api) as Record<string, unknown>;
  } catch {
    throw new Error('API health endpoint did not return JSON');
  }
  const version = health.version ?? health.kortix_version;
  if (version !== manifest.health.expected_version) {
    throw new Error(`API health reports ${String(version)} instead of immutable prod ${manifest.health.expected_version}`);
  }
  const frontendUrl = `https://${frontendDomain}${manifest.health.frontend_path}`;
  curlWithRetry(runner, [
    '--fail', '--silent', '--show-error', '--output', '/dev/null', '--proto', '=https', '--tlsv1.2', frontendUrl,
  ], frontendUrl);
}

function curlWithRetry(runner: CommandRunner, args: string[], url: string): string {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      return runner.run('curl', args);
    } catch (error) {
      lastError = error as Error;
      if (attempt < 60) runner.run('sleep', ['10']);
    }
  }
  throw new Error(`health endpoint ${url} did not become ready within 10 minutes: ${lastError?.message ?? 'unknown error'}`);
}

export function supabaseInstallScript(input: {
  bucket: string;
  key: string;
  sha256: string;
  version: string;
  runtimeSecretArn: string;
  instance: string;
  apiDomain: string;
  frontendDomain: string;
}): string {
  for (const value of [input.bucket, input.key, input.version, input.instance]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)) throw new Error('unsafe Supabase installation coordinate');
  }
  for (const domain of [input.apiDomain, input.frontendDomain]) {
    if (domain.length > 253 || !domain.includes('.') || domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('unsafe Supabase installation domain');
    }
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || !/^arn:[a-z0-9-]+:secretsmanager:[^:]+:\d{12}:secret:[a-zA-Z0-9/_+=.@-]+$/.test(input.runtimeSecretArn)) {
    throw new Error('unsafe Supabase digest or secret ARN');
  }
  return `set -euo pipefail
umask 077
archive=/tmp/kortix-supabase-${input.sha256}.tar.gz
staging=/opt/kortix/releases/${input.version}.staging
release_dir=/opt/kortix/releases/${input.version}
transaction=/opt/kortix/update-transactions/${input.sha256}
aws s3 cp s3://${input.bucket}/${input.key} "$archive"
echo '${input.sha256}  '"$archive" | sha256sum --check --strict
entries=$(tar -tzf "$archive")
test -n "$entries"
printf '%s\n' "$entries" | awk '{ if ($0 ~ /^\\//) exit 1; count=split($0, segments, "/"); for (part=1; part<=count; part++) if (segments[part] == "..") exit 1 }'
tar -tvzf "$archive" | awk '{ type=substr($0, 1, 1); if (type != "-" && type != "d") exit 1 }'
rm -rf "$staging"
install -d -m 0700 "$staging"
(umask 022; tar -xzf "$archive" --directory "$staging" --no-same-owner --no-same-permissions)
test -x "$staging/bin/install"
test -f "$staging/bundle.json"
"$staging/bin/install" --runtime-secret-arn '${input.runtimeSecretArn}' --release '${input.version}' --instance '${input.instance}' --api-domain '${input.apiDomain}' --frontend-domain '${input.frontendDomain}'
printf '%s\n' '${input.sha256}' >"$staging/.artifact-sha256"
if [ -e "$release_dir" ]; then
  test "$(cat "$release_dir/.artifact-sha256")" = '${input.sha256}'
  rm -rf "$staging"
else
  mv "$staging" "$release_dir"
fi
install -d -m 0700 /opt/kortix/update-transactions
previous=
if [ -L /opt/kortix/current ]; then
  previous=$(readlink -f /opt/kortix/current)
  case "$previous" in
    /opt/kortix/releases/*) ;;
    *) echo 'Unsafe previous Supabase release path' >&2; exit 1 ;;
  esac
  test -d "$previous"
fi
printf '%s\n' "$previous" >"$transaction.previous"
printf '%s\n' "$release_dir" >"$transaction.expected"
ln -sfn "$release_dir" /opt/kortix/current.new
mv -Tf /opt/kortix/current.new /opt/kortix/current
if ! systemctl restart kortix-supabase.service || ! systemctl is-active --quiet kortix-supabase.service; then
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" /opt/kortix/current.rollback
    mv -Tf /opt/kortix/current.rollback /opt/kortix/current
    systemctl restart kortix-supabase.service || true
  else
    rm -f /opt/kortix/current
  fi
  rm -f "$transaction.previous" "$transaction.expected"
  echo 'Supabase failed to start; restored the previous release' >&2
  exit 1
fi`;
}

export function supabaseFinalizeScript(version: string, sha256: string): string {
  const paths = supabaseTransactionPaths(version, sha256);
  return `set -euo pipefail
current=$(readlink -f /opt/kortix/current 2>/dev/null || true)
test "$current" = '${paths.releaseDir}'
test "$(cat '${paths.expected}')" = '${paths.releaseDir}'
rm -f '${paths.previous}' '${paths.expected}'`;
}

export function supabaseRollbackScript(version: string, sha256: string): string {
  const paths = supabaseTransactionPaths(version, sha256);
  return `set -euo pipefail
expected=$(cat '${paths.expected}')
test "$expected" = '${paths.releaseDir}'
current=$(readlink -f /opt/kortix/current 2>/dev/null || true)
test "$current" = "$expected"
previous=$(cat '${paths.previous}')
if [ -n "$previous" ]; then
  case "$previous" in
    /opt/kortix/releases/*) ;;
    *) echo 'Unsafe previous Supabase release path' >&2; exit 1 ;;
  esac
  test -d "$previous"
  ln -sfn "$previous" /opt/kortix/current.rollback
  mv -Tf /opt/kortix/current.rollback /opt/kortix/current
  systemctl restart kortix-supabase.service
  systemctl is-active --quiet kortix-supabase.service
else
  systemctl stop kortix-supabase.service || true
  rm -f /opt/kortix/current
fi
rm -f '${paths.previous}' '${paths.expected}'`;
}

function supabaseTransactionPaths(version: string, sha256: string): {
  releaseDir: string;
  previous: string;
  expected: string;
} {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-e\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('unsafe Supabase transaction coordinate');
  }
  const transaction = `/opt/kortix/update-transactions/${sha256}`;
  return {
    releaseDir: `/opt/kortix/releases/${version}`,
    previous: `${transaction}.previous`,
    expected: `${transaction}.expected`,
  };
}
