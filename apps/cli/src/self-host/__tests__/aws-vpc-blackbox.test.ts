import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');
const TRUSTED_ROOT = 'a'.repeat(64);
const BOOTSTRAP_DIGEST = 'b'.repeat(64);
const BEDROCK_KEY = 'bedrock-super-secret-value';

describe('kortix self-host aws-vpc', () => {
  let tmp: string;
  let configRoot: string;
  let fakeBin: string;
  let awsLog: string;
  let terraformLog: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-aws-vpc-cli-'));
    configRoot = join(tmp, 'self-host');
    fakeBin = join(tmp, 'bin');
    awsLog = join(tmp, 'aws.log');
    terraformLog = join(tmp, 'terraform.log');
    mkdirSync(fakeBin, { recursive: true });
    installFakeAws();
    installFakeTerraform();
    installSuccessfulTool('kubectl', '{"clientVersion":{"gitVersion":"v1.32.0"}}');
    installSuccessfulTool('sleep', '');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function installFakeAws(): void {
    const aws = join(fakeBin, 'aws');
    writeFileSync(
      aws,
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_AWS_LOG"
case "$*" in
  *"sts get-caller-identity"*)
    account="\${FAKE_AWS_ACCOUNT:-935064898258}"
    case "$*" in *"--profile wrong-account"*) account="327903111249" ;; esac
    printf '{"UserId":"fake","Account":"%s","Arn":"arn:aws:iam::%s:user/fake"}\n' "$account" "$account"
    ;;
  *"ssm get-parameters"*)
    if [ "\${FAKE_RELEASE_EMPTY:-}" = "1" ]; then
      printf '%s\n' '{"Parameters":[],"InvalidParameters":["/kortix/vpc-demo/release"]}'
    else
      printf '%s\n' '{"Parameters":[{"Value":"{\\\"version\\\":\\\"0.9.84-e1\\\",\\\"digests\\\":{\\\"api\\\":\\\"sha256:aaa\\\"},\\\"supabase_bundle_sha\\\":\\\"d\\\",\\\"deployed_at\\\":\\\"2026-07-14T12:00:00Z\\\"}"}]}'
    fi
    ;;
  *"ssm put-parameter"*) printf '%s\n' '{"Version":1}' ;;
  *"ssm send-command"*) printf '%s\n' '{"Command":{"CommandId":"cmd-1"}}' ;;
  *"ssm get-command-invocation"*)
    printf '%s\n' '{"Status":"Success","StandardErrorContent":"","StandardOutputContent":"[{\\\"Service\\\":\\\"api\\\",\\\"State\\\":\\\"running\\\",\\\"Health\\\":\\\"healthy\\\"},{\\\"Service\\\":\\\"gateway\\\",\\\"State\\\":\\\"running\\\"},{\\\"Service\\\":\\\"frontend\\\",\\\"State\\\":\\\"running\\\"},{\\\"Service\\\":\\\"caddy\\\",\\\"State\\\":\\\"running\\\"}]"}'
    ;;
  *"ec2 describe-instances"*)
    printf '%s\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-0123456789","State":{"Name":"running"},"PrivateIpAddress":"10.60.16.10","PublicIpAddress":"52.10.0.5"}]}]}'
    ;;
  *"secretsmanager get-secret-value"*)
    if [ "\${FAKE_RUNTIME_MISSING:-}" = "1" ]; then
      printf '%s\n' 'ResourceNotFoundException: Secrets Manager can not find the specified secret value' >&2
      exit 254
    fi
    printf '%s\n' '{"SecretString":"{\\\"SMTP_ADMIN_EMAIL\\\":\\\"admin@example.com\\\",\\\"SMTP_HOST\\\":\\\"smtp.example.com\\\",\\\"SMTP_PORT\\\":\\\"587\\\",\\\"SMTP_USER\\\":\\\"smtp-user\\\",\\\"SMTP_PASS\\\":\\\"smtp-pass\\\",\\\"SMTP_SENDER_NAME\\\":\\\"Kortix\\\",\\\"DAYTONA_API_KEY\\\":\\\"daytona-key\\\",\\\"AWS_BEDROCK_API_KEY\\\":\\\"${BEDROCK_KEY}\\\"}"}'
    ;;
  *"secretsmanager put-secret-value"*)
    cat >/dev/null
    printf '%s\n' '{"ARN":"arn:aws:secretsmanager:us-west-2:935064898258:secret:vpc-demo/runtime-test","VersionId":"00000000-0000-0000-0000-000000000000"}'
    ;;
  *"logs tail"*) printf '%s\n' '2026-07-13T11:05:00Z deployer up to date' ;;
  *"--version"*) printf '%s\n' 'aws-cli/2.31.0' ;;
  *) printf '%s\n' "unexpected aws args: $*" >&2; exit 64 ;;
esac
`,
    );
    chmodSync(aws, 0o755);
  }

  function installFakeTerraform(): void {
    const terraform = join(fakeBin, 'terraform');
    writeFileSync(
      terraform,
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_TERRAFORM_LOG"
case "$*" in
  "version -json") printf '%s\n' '{"terraform_version":"1.9.8"}' ;;
  *"show -json"*)
    printf '%s\n' '{"format_version":"1.2","resource_changes":[{"address":"module.enterprise.aws_ecs_service.api","type":"aws_ecs_service","change":{"actions":["create"]}}]}'
    ;;
  *"output -json backend_config"*)
    printf '%s\n' '{"bucket":"vpc-demo-935064898258-us-west-2-tfstate","dynamodb_table":"vpc-demo-terraform-locks","region":"us-west-2","encrypt":true,"kms_key_id":"arn:aws:kms:us-west-2:935064898258:key/state"}'
    ;;
  *"output -json permissions_boundary_arn"*)
    printf '%s\n' '"arn:aws:iam::935064898258:policy/vpc-demo-workload-boundary"'
    ;;
  *"output -json instance"*)
    printf '%s\n' '{"name":"vpc-demo","account_id":"935064898258","region":"us-west-2","cluster_name":"kortix-vpc-demo","supabase_instance_id":"i-0123456789","supabase_private_ip":"10.60.16.10","runtime_secret_arn":"arn:aws:secretsmanager:us-west-2:935064898258:secret:vpc-demo/runtime-test"}'
    ;;
  *"state pull"*)
    for arg in "$@"; do case "$arg" in -chdir=*) dir="\${arg#-chdir=}" ;; esac; done
    case "\${dir:-}" in */state)
      if [ ! -f "$dir/terraform.bootstrap.tfstate" ]; then
        printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"lineage-123","outputs":{},"resources":[]}' > "$dir/terraform.bootstrap.tfstate"
      fi
      if grep -q 'backend "s3"' "$dir/backend.tf"; then
        if [ "\${FAKE_TERRAFORM_REMOTE_DIFFERENT:-}" = "1" ]; then
          printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":1,"lineage":"remote-lineage","outputs":{},"resources":[{"mode":"managed","type":"terraform_data","name":"stale","provider":"provider[\\"terraform.io/builtin/terraform\\"]","instances":[]}]}'
        elif [ "\${FAKE_TERRAFORM_REMOTE_REFRESHED:-}" = "1" ]; then
          printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":2,"lineage":"remote-lineage","outputs":{},"resources":[{"mode":"managed","type":"terraform_data","name":"account_guard","provider":"provider[\\"terraform.io/builtin/terraform\\"]","instances":[{"schema_version":0,"attributes":{"id":"guard-1","output":{"provider_filled":true}}}]}]}'
        else
          printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":1,"lineage":"remote-lineage","outputs":{},"resources":[]}'
        fi
        exit 0
      fi
      ;;
    esac
    printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"lineage-123","outputs":{},"resources":[]}'
    ;;
  *"apply"*)
    if [ -f "\${FAKE_TERRAFORM_LOG}.fail-apply" ]; then
      printf '%s\n' '╷' '│ Error: simulated actionable apply failure' '╵' >&2
      exit 66
    fi
    for arg in "$@"; do case "$arg" in -chdir=*) dir="\${arg#-chdir=}" ;; esac; done
    case "\${dir:-}" in */state)
      if ! grep -q 'backend "s3"' "$dir/backend.tf"; then
        printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"lineage-123","outputs":{},"resources":[]}' > "$dir/terraform.bootstrap.tfstate"
      fi
      ;;
    esac
    printf '%s\n' 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.'
    ;;
  *"plan"*)
    for arg in "$@"; do case "$arg" in -out=*) : > "\${arg#-out=}" ;; esac; done
    printf '%s\n' 'Plan: 1 to add, 0 to change, 0 to destroy.'
    ;;
  *"init -input=false -migrate-state"*)
    if [ "\${FAKE_TERRAFORM_FAIL_MIGRATE:-}" = "1" ]; then
      printf '%s\n' 'simulated state migration failure' >&2
      exit 65
    fi
    printf '%s\n' 'Terraform has been successfully initialized!'
    ;;
  *"init"*) printf '%s\n' 'Terraform has been successfully initialized!' ;;
  *) printf '%s\n' "unexpected terraform args: $*" >&2; exit 64 ;;
esac
`,
    );
    chmodSync(terraform, 0o755);
  }

  function installSuccessfulTool(name: string, output: string): void {
    const executable = join(fakeBin, name);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    chmodSync(executable, 0o755);
  }

  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args],
      cwd: tmp,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        FAKE_AWS_LOG: awsLog,
        FAKE_TERRAFORM_LOG: terraformLog,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
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

  function configuredInitArgs(instance = 'vpc-demo'): string[] {
    return [
      'init', '--target', 'aws-vpc', '--instance', instance,
      '--aws-profile', 'default', '--region', 'us-west-2', '--channel', 'stable',
      '--vpc-cidr', '10.60.0.0/16',
      '--api-domain', 'api.vpc-demo.kortix.com',
      '--frontend-domain', 'vpc-demo.kortix.com',
      '--route53-zone-id', 'Z0123456789EXAMPLE',
      '--release-repository-url', 'https://releases.kortix.com/enterprise',
      '--tuf-root-sha256', TRUSTED_ROOT,
      '--updater-bootstrap-url', 'https://releases.kortix.com/enterprise/bootstrap/updater-linux-amd64',
      '--updater-bootstrap-sha256', BOOTSTRAP_DIGEST,
      '--release-publisher-account-id', '935064898258',
      '--maintenance-window', 'Sun:02:00-05:00',
      '--yes', '--json',
    ];
  }

  async function initConfigured(instance = 'vpc-demo') {
    const result = await run(configuredInitArgs(instance));
    expect(result.code, result.stderr).toBe(0);
    return result;
  }

  test('initializes a secret-free account-pinned instance and embeds the reviewed Terraform graph', async () => {
    const result = await initConfigured();
    const config = JSON.parse(result.stdout);
    expect(config).toMatchObject({
      instance: 'vpc-demo',
      target: 'aws-vpc',
      channel: 'stable',
      aws: {
        profile: 'default',
        region: 'us-west-2',
        account_id: '935064898258',
        vpc_cidr: '10.60.0.0/16',
        api_domain: 'api.vpc-demo.kortix.com',
        frontend_domain: 'vpc-demo.kortix.com',
        route53_zone_id: 'Z0123456789EXAMPLE',
        tuf_root_sha256: TRUSTED_ROOT,
      },
    });

    const instanceDir = join(configRoot, 'vpc-demo');
    const persisted = readFileSync(join(instanceDir, 'instance.json'), 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({ target: 'aws-vpc', aws: { account_id: '935064898258' } });
    expect(persisted).not.toContain('cloudflare_api_token');
    expect(existsSync(join(instanceDir, '.env'))).toBe(false);
    expect(readFileSync(join(instanceDir, 'terraform/environments/enterprise-vpc/state/main.tf'), 'utf8'))
      .toContain('module "state"');
    expect(readFileSync(join(instanceDir, 'terraform/modules/enterprise-vpc/supabase.tf'), 'utf8'))
      .toContain('aws_instance" "appliance');
  });

  test('enforces Terraform-compatible lowercase DNS slugs for AWS instances', async () => {
    const result = await run([
      'init', '--target', 'aws-vpc', '--instance', 'Essentia_VPC', '--aws-profile', 'default', '--yes',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('lowercase DNS slug');
    expect(existsSync(awsLog)).toBe(false);
  });

  test('plans without mutation and refuses a profile that no longer resolves to the pinned account', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const plan = await run(['plan', '--instance', 'vpc-demo', '--json']);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      instance: 'vpc-demo',
      stages: [{ name: 'state', decision: 'auto_apply' }],
    });
    expect(readFileSync(terraformLog, 'utf8')).toContain('plan');
    expect(readFileSync(terraformLog, 'utf8')).not.toContain(' apply ');
    expect(readFileSync(awsLog, 'utf8')).toContain('sts get-caller-identity');

    writeFileSync(terraformLog, '');
    const mismatch = await run(
      ['plan', '--instance', 'vpc-demo'],
      { FAKE_AWS_ACCOUNT: '327903111249' },
    );
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('AWS account mismatch');
    expect(readFileSync(terraformLog, 'utf8')).toBe('');
  });

  test('does not persist a replacement AWS profile unless it resolves to the pinned account', async () => {
    await initConfigured();
    const result = await run([
      'configure', '--instance', 'vpc-demo', '--aws-profile', 'wrong-account', '--yes',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('AWS account mismatch');
    const persisted = JSON.parse(readFileSync(join(configRoot, 'vpc-demo/instance.json'), 'utf8'));
    expect(persisted.aws.profile).toBe('default');
  });

  test('requires deployment confirmation before any Terraform or AWS mutation', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(['deploy', '--instance', 'vpc-demo']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('requires confirmation');
    expect(readFileSync(terraformLog, 'utf8')).toBe('');
    expect(readFileSync(awsLog, 'utf8')).toContain('sts get-caller-identity');
    expect(readFileSync(awsLog, 'utf8')).not.toContain('ssm send-command');
  });

  test('applies reviewed stages, verifies state migration, and runs the on-box updater via SSM', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(['deploy', '--instance', 'vpc-demo', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      instance: 'vpc-demo',
      state_migration: {
        verified: true,
        lineage: 'remote-lineage',
        serial: 1,
        verification_mode: 'exact-content',
      },
      cluster: { decision: 'auto_apply', applied: true },
      deployment: { status: 'DEPLOYED', command_id: 'cmd-1', instance_id: 'i-0123456789' },
    });

    const calls = readFileSync(terraformLog, 'utf8');
    expect(calls).toContain('state apply');
    expect(calls).toContain('init -input=false -migrate-state -force-copy');
    expect(calls).toContain('cluster apply');
    expect(calls.indexOf('state apply')).toBeLessThan(calls.indexOf('cluster apply'));
    const awsCalls = readFileSync(awsLog, 'utf8');
    // the updater runs on the box via SSM RunCommand, not an ECS task
    expect(awsCalls).toContain('ssm send-command');
    expect(awsCalls).toContain('kortix-updater run');
    expect(awsCalls).not.toContain('ecs run-task');
    expect(awsCalls).toContain('secretsmanager put-secret-value');
    expect(awsCalls).toContain('file://');
    // secrets are written through a temp file, never disclosed on the command line
    expect(awsCalls).not.toContain(BEDROCK_KEY);
  });

  test('bootstraps internal credentials but waits for operator runtime values before first deploy', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(
      ['deploy', '--instance', 'vpc-demo', '--yes', '--json'],
      { FAKE_RUNTIME_MISSING: '1' },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      runtime_secret: {
        bootstrapped: true,
        missing: expect.arrayContaining(['SMTP_HOST', 'DAYTONA_API_KEY', 'AWS_BEDROCK_API_KEY']),
      },
      deployment: { status: 'WAITING_FOR_RUNTIME_CONFIG', command_id: null },
    });
    const calls = readFileSync(awsLog, 'utf8');
    expect(calls).toContain('secretsmanager put-secret-value');
    expect(calls).not.toContain('ssm send-command');
  });

  test('preserves local bootstrap state and restores the local backend when migration fails', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(
      ['deploy', '--instance', 'vpc-demo', '--yes'],
      { FAKE_TERRAFORM_FAIL_MIGRATE: '1' },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('local bootstrap state was preserved');
    const stateRoot = join(configRoot, 'vpc-demo/terraform/environments/enterprise-vpc/state');
    expect(readFileSync(join(stateRoot, 'backend.tf'), 'utf8')).toContain('backend "local"');
    expect(existsSync(join(stateRoot, 'terraform.bootstrap.tfstate'))).toBe(true);
    expect(readFileSync(awsLog, 'utf8')).not.toContain('ssm send-command');
  });

  test('surfaces Terraform diagnostics instead of a box-drawing border', async () => {
    await initConfigured();
    writeFileSync(`${terraformLog}.fail-apply`, '');
    const result = await run(['deploy', '--instance', 'vpc-demo', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Terraform apply failed: Error: simulated actionable apply failure');
    expect(result.stderr).not.toContain('Terraform apply failed: ╷');
  });

  test('rejects a migrated remote state whose resources differ from the preserved bootstrap state', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(
      ['deploy', '--instance', 'vpc-demo', '--yes'],
      { FAKE_TERRAFORM_REMOTE_DIFFERENT: '1' },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('remote state verification failed');
    const stateRoot = join(configRoot, 'vpc-demo/terraform/environments/enterprise-vpc/state');
    expect(existsSync(join(stateRoot, 'terraform.bootstrap.tfstate'))).toBe(true);
    expect(readFileSync(awsLog, 'utf8')).not.toContain('ssm send-command');
  });

  test('recovers an already-remote state after provider refresh when all object identities and outputs match', async () => {
    await initConfigured();
    const stateRoot = join(configRoot, 'vpc-demo/terraform/environments/enterprise-vpc/state');
    writeFileSync(join(stateRoot, 'backend.tf'), 'terraform { backend "s3" {} }\n');
    writeFileSync(
      join(stateRoot, 'backend.hcl'),
      'bucket = "state"\ndynamodb_table = "locks"\nregion = "us-west-2"\nencrypt = true\nkms_key_id = "key"\n',
    );
    writeFileSync(
      join(stateRoot, 'terraform.bootstrap.tfstate'),
      '{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"lineage-123","outputs":{},"resources":[{"mode":"managed","type":"terraform_data","name":"account_guard","provider":"provider[\\"terraform.io/builtin/terraform\\"]","instances":[{"schema_version":0,"attributes":{"id":"guard-1"}}]}]}\n',
    );

    const result = await run(
      ['deploy', '--instance', 'vpc-demo', '--yes', '--json'],
      { FAKE_TERRAFORM_REMOTE_REFRESHED: '1' },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state_migration: {
        verified: true,
        already_remote: true,
        verification_mode: 'refreshed-object-identity',
      },
    });
    expect(existsSync(join(stateRoot, 'terraform.bootstrap.tfstate'))).toBe(false);
  });

  test('routes reconcile, force update, and rollback through the on-box updater via SSM', async () => {
    await initConfigured();
    writeFileSync(awsLog, '');

    const reconcile = await run(['reconcile', '--instance', 'vpc-demo', '--json']);
    expect(reconcile.code, reconcile.stderr).toBe(0);
    const update = await run([
      'update', '--instance', 'vpc-demo', '--release', '0.9.85-e1', '--force', '--json',
    ]);
    expect(update.code).toBe(0);
    const rollback = await run([
      'rollback', '--instance', 'vpc-demo', '--release', '0.9.84-e1', '--yes', '--json',
    ]);
    expect(rollback.code).toBe(0);

    const calls = readFileSync(awsLog, 'utf8');
    expect(calls.match(/ssm send-command/g)).toHaveLength(3);
    expect(calls).toContain('kortix-updater run');
    expect(calls).toContain('KORTIX_DEPLOY_RELEASE');
    expect(calls).toContain('0.9.85-e1');
    expect(calls).toContain('KORTIX_DEPLOY_FORCE');
    expect(calls).toContain('KORTIX_DEPLOY_ROLLBACK');
    expect(calls).toContain('0.9.84-e1');
  });

  test('manages AWS runtime environment only in customer Secrets Manager', async () => {
    await initConfigured();
    writeFileSync(awsLog, '');

    const list = await run(['env', 'ls', '--instance', 'vpc-demo', '--json']);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      instance: 'vpc-demo',
      missing_required: [],
    });
    expect(list.stdout).not.toContain('smtp-pass');

    const set = await run([
      'env', 'set', 'SMTP_PASS=rotated-secret', '--instance', 'vpc-demo', '--json',
    ]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ updated: ['SMTP_PASS'] });
    const calls = readFileSync(awsLog, 'utf8');
    expect(calls).toContain('secretsmanager put-secret-value');
    expect(calls).toContain('file://');
    expect(calls).not.toContain('rotated-secret');
    expect(readFileSync(join(configRoot, 'vpc-demo/instance.json'), 'utf8')).not.toContain('rotated-secret');
  });

  test('reports live appliance status/version via docker ps + breadcrumb and tails the updater log', async () => {
    await initConfigured();
    writeFileSync(awsLog, '');

    const statusResult = await run(['status', '--instance', 'vpc-demo', '--json']);
    expect(statusResult.code, statusResult.stderr).toBe(0);
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      instance: 'vpc-demo',
      host: { state: 'running' },
      services: expect.arrayContaining([
        expect.objectContaining({ service: 'api', state: 'running', health: 'healthy' }),
      ]),
      release: { version: '0.9.84-e1' },
    });
    // status reads container state through SSM docker ps, not ECS.
    expect(readFileSync(awsLog, 'utf8')).toContain('ssm send-command');
    expect(readFileSync(awsLog, 'utf8')).not.toContain('ecs describe');

    const version = await run(['version', '--instance', 'vpc-demo', '--json']);
    expect(version.code).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ release: '0.9.84-e1', channel: 'stable', status: 'deployed' });

    const logs = await run(['logs', 'updater', '--instance', 'vpc-demo']);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain('up to date');
    expect(readFileSync(awsLog, 'utf8')).toContain('logs tail /kortix/vpc-demo/appliance');
  });

  test('reports not-deployed release state when the SSM release parameter is absent', async () => {
    await initConfigured();

    const result = await run(
      ['version', '--instance', 'vpc-demo', '--json'],
      { FAKE_RELEASE_EMPTY: '1' },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      release: null,
      status: 'not-deployed',
    });
  });

  test('does not reinterpret Docker lifecycle commands for AWS', async () => {
    await initConfigured('enterprise');
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
    expect(result.stdout).toContain('--vpc-cidr <cidr>');
    expect(result.stdout).toContain('--route53-zone-id <id>');
    expect(result.stdout).toContain('--tuf-root-sha256 <digest>');
  });
});
