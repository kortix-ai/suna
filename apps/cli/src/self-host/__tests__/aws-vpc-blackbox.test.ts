import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');
const TRUSTED_ROOT = 'a'.repeat(64);
const BOOTSTRAP_DIGEST = 'b'.repeat(64);

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
    installSuccessfulTool('helm', 'v3.17.0');
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
  *"states start-execution"*)
    printf '%s\n' '{"executionArn":"arn:aws:states:us-west-2:935064898258:execution:kortix-vpc-demo-reconcile:cli-1","startDate":"2026-07-13T12:00:00Z"}'
    ;;
  *"states list-executions"*)
    printf '%s\n' '{"executions":[{"executionArn":"arn:aws:states:us-west-2:935064898258:execution:kortix-vpc-demo-reconcile:hourly-1","name":"hourly-1","status":"SUCCEEDED","startDate":"2026-07-13T11:00:00Z","stopDate":"2026-07-13T11:05:00Z"}]}'
    ;;
  *"dynamodb get-item"*)
    printf '%s\n' '{"Item":{"instance":{"S":"kortix-vpc-demo"},"release":{"S":"0.9.84-e1"},"channel":{"S":"stable"},"status":{"S":"healthy"},"updated_at":{"S":"2026-07-13T11:05:00Z"}}}'
    ;;
  *"eks describe-cluster"*)
    printf '%s\n' '{"cluster":{"name":"kortix-vpc-demo","status":"ACTIVE","version":"1.32","endpoint":"https://private.example"}}'
    ;;
  *"codebuild batch-get-projects"*)
    printf '%s\n' '{"projects":[{"name":"kortix-vpc-demo-updater","arn":"arn:aws:codebuild:us-west-2:935064898258:project/kortix-vpc-demo-updater"}],"projectsNotFound":[]}'
    ;;
  *"ec2 describe-instances"*)
    printf '%s\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-0123456789","State":{"Name":"running"},"PrivateIpAddress":"10.60.16.10"}]}]}'
    ;;
  *"logs tail"*) printf '%s\n' '2026-07-13T11:05:00Z updater healthy' ;;
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
    printf '%s\n' '{"format_version":"1.2","resource_changes":[{"address":"module.enterprise.aws_iam_role.updater","type":"aws_iam_role","change":{"actions":["create"]}}]}'
    ;;
  *"output -json backend_config"*)
    printf '%s\n' '{"bucket":"kortix-vpc-demo-935064898258-us-west-2-tfstate","dynamodb_table":"kortix-vpc-demo-terraform-locks","region":"us-west-2","encrypt":true,"kms_key_id":"arn:aws:kms:us-west-2:935064898258:key/state"}'
    ;;
  *"output -json permissions_boundary_arn"*)
    printf '%s\n' '"arn:aws:iam::935064898258:policy/kortix-vpc-demo-workload-boundary"'
    ;;
  *"output -json instance"*)
    printf '%s\n' '{"name":"kortix-vpc-demo","account_id":"935064898258","region":"us-west-2","cluster_name":"kortix-vpc-demo","state_machine_arn":"arn:aws:states:us-west-2:935064898258:stateMachine:kortix-vpc-demo-reconcile","release_state_table":"kortix-vpc-demo-release-state","supabase_instance_id":"i-0123456789"}'
    ;;
  *"state pull"*)
    for arg in "$@"; do case "$arg" in -chdir=*) dir="\${arg#-chdir=}" ;; esac; done
    case "\${dir:-}" in */state)
      if [ ! -f "$dir/terraform.bootstrap.tfstate" ]; then
        printf '%s\n' '{"version":4,"serial":7,"lineage":"lineage-123"}' > "$dir/terraform.bootstrap.tfstate"
      fi
      ;;
    esac
    printf '%s\n' '{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"lineage-123","outputs":{},"resources":[]}'
    ;;
  *"plan"*)
    for arg in "$@"; do case "$arg" in -out=*) : > "\${arg#-out=}" ;; esac; done
    printf '%s\n' 'Plan: 1 to add, 0 to change, 0 to destroy.'
    ;;
  *"apply"*)
    for arg in "$@"; do case "$arg" in -chdir=*) dir="\${arg#-chdir=}" ;; esac; done
    case "\${dir:-}" in */state) printf '%s\n' '{"version":4,"serial":7,"lineage":"lineage-123"}' > "$dir/terraform.bootstrap.tfstate" ;; esac
    printf '%s\n' 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.'
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

  function configuredInitArgs(instance = 'kortix-vpc-demo'): string[] {
    return [
      'init', '--target', 'aws-vpc', '--instance', instance,
      '--aws-profile', 'default', '--region', 'us-west-2', '--channel', 'stable',
      '--vpc-cidr', '10.60.0.0/16',
      '--api-domain', 'api.vpc-demo.kortix.com',
      '--frontend-domain', 'vpc-demo.kortix.com',
      '--release-repository-url', 'https://releases.kortix.com/enterprise',
      '--tuf-root-sha256', TRUSTED_ROOT,
      '--updater-bootstrap-url', 'https://releases.kortix.com/enterprise/bootstrap/updater-linux-amd64',
      '--updater-bootstrap-sha256', BOOTSTRAP_DIGEST,
      '--release-publisher-account-id', '935064898258',
      '--maintenance-window', 'Sun:02:00-05:00',
      '--yes', '--json',
    ];
  }

  async function initConfigured(instance = 'kortix-vpc-demo') {
    const result = await run(configuredInitArgs(instance));
    expect(result.code).toBe(0);
    return result;
  }

  test('initializes a secret-free account-pinned instance and embeds the reviewed Terraform graph', async () => {
    const result = await initConfigured();
    const config = JSON.parse(result.stdout);
    expect(config).toMatchObject({
      instance: 'kortix-vpc-demo',
      target: 'aws-vpc',
      channel: 'stable',
      aws: {
        profile: 'default',
        region: 'us-west-2',
        account_id: '935064898258',
        vpc_cidr: '10.60.0.0/16',
        api_domain: 'api.vpc-demo.kortix.com',
        frontend_domain: 'vpc-demo.kortix.com',
        tuf_root_sha256: TRUSTED_ROOT,
      },
    });

    const instanceDir = join(configRoot, 'kortix-vpc-demo');
    const persisted = readFileSync(join(instanceDir, 'instance.json'), 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({ target: 'aws-vpc', aws: { account_id: '935064898258' } });
    expect(persisted).not.toContain('cloudflare_api_token');
    expect(existsSync(join(instanceDir, '.env'))).toBe(false);
    expect(readFileSync(join(instanceDir, 'terraform/environments/enterprise-vpc/state/main.tf'), 'utf8'))
      .toContain('module "state"');
    expect(readFileSync(join(instanceDir, 'terraform/modules/enterprise-vpc/supabase.tf'), 'utf8'))
      .toContain('aws_instance" "supabase');
    expect(readFileSync(join(instanceDir, 'terraform/modules/eks/platform/main.tf'), 'utf8'))
      .toContain('helm_release" "argo_cd');
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

    const plan = await run(['plan', '--instance', 'kortix-vpc-demo', '--json']);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      instance: 'kortix-vpc-demo',
      stages: [{ name: 'state', decision: 'manual_review' }],
    });
    expect(readFileSync(terraformLog, 'utf8')).toContain('plan');
    expect(readFileSync(terraformLog, 'utf8')).not.toContain(' apply ');
    expect(readFileSync(awsLog, 'utf8')).toContain('sts get-caller-identity');

    writeFileSync(terraformLog, '');
    const mismatch = await run(
      ['plan', '--instance', 'kortix-vpc-demo'],
      { FAKE_AWS_ACCOUNT: '327903111249' },
    );
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('AWS account mismatch');
    expect(readFileSync(terraformLog, 'utf8')).toBe('');
  });

  test('does not persist a replacement AWS profile unless it resolves to the pinned account', async () => {
    await initConfigured();
    const result = await run([
      'configure', '--instance', 'kortix-vpc-demo', '--aws-profile', 'wrong-account', '--yes',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('AWS account mismatch');
    const persisted = JSON.parse(readFileSync(join(configRoot, 'kortix-vpc-demo/instance.json'), 'utf8'));
    expect(persisted.aws.profile).toBe('default');
  });

  test('requires deployment confirmation before any Terraform or AWS mutation', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(['deploy', '--instance', 'kortix-vpc-demo']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('requires confirmation');
    expect(readFileSync(terraformLog, 'utf8')).toBe('');
    expect(readFileSync(awsLog, 'utf8')).toContain('sts get-caller-identity');
    expect(readFileSync(awsLog, 'utf8')).not.toContain('start-execution');
  });

  test('applies reviewed stages, verifies state migration, and starts customer-owned bootstrap reconciliation', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(['deploy', '--instance', 'kortix-vpc-demo', '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      instance: 'kortix-vpc-demo',
      state_migration: { verified: true, lineage: 'lineage-123', serial: 7 },
      cluster: { decision: 'manual_review', applied: true },
      reconciliation: { execution_arn: expect.stringContaining('kortix-vpc-demo-reconcile') },
    });

    const calls = readFileSync(terraformLog, 'utf8');
    expect(calls).toContain('state apply');
    expect(calls).toContain('init -input=false -migrate-state -force-copy');
    expect(calls).toContain('cluster apply');
    expect(calls.indexOf('state apply')).toBeLessThan(calls.indexOf('cluster apply'));
    const stateRoot = join(configRoot, 'kortix-vpc-demo/terraform/environments/enterprise-vpc/state');
    expect(readFileSync(join(stateRoot, 'backend.tf'), 'utf8')).toContain('backend "s3"');
    expect(existsSync(join(stateRoot, 'terraform.bootstrap.tfstate'))).toBe(false);
    expect(readFileSync(awsLog, 'utf8')).toContain('states start-execution');

    await run(['configure', '--instance', 'kortix-vpc-demo', '--maintenance-window', 'Sat:03:00-04:00', '--yes']);
    expect(readFileSync(join(stateRoot, 'backend.tf'), 'utf8')).toContain('backend "s3"');
  });

  test('preserves local bootstrap state and restores the local backend when migration fails', async () => {
    await initConfigured();
    writeFileSync(terraformLog, '');
    writeFileSync(awsLog, '');

    const result = await run(
      ['deploy', '--instance', 'kortix-vpc-demo', '--yes'],
      { FAKE_TERRAFORM_FAIL_MIGRATE: '1' },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('local bootstrap state was preserved');
    const stateRoot = join(configRoot, 'kortix-vpc-demo/terraform/environments/enterprise-vpc/state');
    expect(readFileSync(join(stateRoot, 'backend.tf'), 'utf8')).toContain('backend "local"');
    expect(existsSync(join(stateRoot, 'terraform.bootstrap.tfstate'))).toBe(true);
    expect(readFileSync(awsLog, 'utf8')).not.toContain('states start-execution');
  });

  test('routes reconcile, force update, and rollback through the customer state machine', async () => {
    await initConfigured();
    writeFileSync(awsLog, '');

    const reconcile = await run(['reconcile', '--instance', 'kortix-vpc-demo', '--json']);
    expect(reconcile.code).toBe(0);
    const update = await run([
      'update', '--instance', 'kortix-vpc-demo', '--release', '0.9.85-e1', '--force', '--json',
    ]);
    expect(update.code).toBe(0);
    const rollback = await run([
      'rollback', '--instance', 'kortix-vpc-demo', '--release', '0.9.84-e1', '--yes', '--json',
    ]);
    expect(rollback.code).toBe(0);

    const calls = readFileSync(awsLog, 'utf8');
    expect(calls.match(/states start-execution/g)).toHaveLength(3);
    expect(calls).toContain('"trigger":"cli-reconcile"');
    expect(calls).toContain('"requested_release":"0.9.85-e1"');
    expect(calls).toContain('"force":true');
    expect(calls).toContain('"trigger":"cli-rollback"');
    expect(calls).toContain('"rollback_to":"0.9.84-e1"');
  });

  test('reports live AWS status/version and tails customer-owned updater logs', async () => {
    await initConfigured();
    writeFileSync(awsLog, '');

    const status = await run(['status', '--instance', 'kortix-vpc-demo', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      instance: 'kortix-vpc-demo',
      cluster: { status: 'ACTIVE' },
      supabase: { state: 'running' },
      updater: { status: 'AVAILABLE' },
      reconciliation: { status: 'SUCCEEDED' },
      release: { release: '0.9.84-e1', status: 'healthy' },
    });

    const version = await run(['version', '--instance', 'kortix-vpc-demo', '--json']);
    expect(version.code).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ release: '0.9.84-e1', channel: 'stable' });

    const logs = await run(['logs', 'updater', '--instance', 'kortix-vpc-demo']);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain('updater healthy');
    expect(readFileSync(awsLog, 'utf8')).toContain('logs tail /kortix/kortix-vpc-demo/updater');
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
    expect(result.stdout).toContain('--tuf-root-sha256 <digest>');
  });
});
