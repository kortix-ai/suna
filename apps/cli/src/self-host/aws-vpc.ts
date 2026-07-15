import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { confirm } from '../prompts.ts';
import { C, status } from '../style.ts';
import {
  applianceInstanceId,
  awsIdentity,
  awsJson,
  awsJsonOptional,
  dockerPsViaSsm,
  firstLine,
  readReleaseRecord,
  runUpdaterViaSsm,
  spawnAws,
  verifyPinnedIdentity,
  type AwsIdentity,
  type DockerServiceStatus,
  type UpdaterRunResult,
} from './aws-vpc-control-plane.ts';
import {
  assertEnterpriseRelease,
  completeConfiguration,
  hasConfigurationFlags,
  mergeAwsConfiguration,
  missingConfiguration,
  parseConfigurationAssignments,
  promptForConfiguration,
} from './aws-vpc-settings.ts';
import {
  assertOperatorRuntimeAssignments,
  bootstrapRuntimeSecret,
  missingOperatorRuntimeKeys,
  parseRuntimeAssignments,
  readRuntimeSecret,
  runtimeSecretId,
  writeRuntimeSecret,
} from './aws-vpc-secrets.ts';
import {
  assertAwsVpcInstanceName,
  loadInstanceConfig,
  writeInstanceConfig,
  type SelfHostInstanceConfig,
} from './config.ts';
import {
  enterpriseTerraformRoot,
  writeEnterpriseTerraformAssets,
} from './enterprise-assets.ts';
import {
  ensureApplicable,
  isRemoteState,
  migrateAndVerifyState,
  prepareTerraform,
  publicPlan,
  readBackendConfig,
  terraformApply,
  terraformOutput,
  terraformPlan,
  writeClusterFiles,
  type EnterpriseInstanceOutput,
  type StagePlan,
} from './enterprise-terraform.ts';
import type { SelfHostCommandFlags } from './types.ts';

type AwsVpcCommand =
  | 'init'
  | 'setup'
  | 'plan'
  | 'deploy'
  | 'update'
  | 'upgrade'
  | 'reconcile'
  | 'rollback'
  | 'status'
  | 'ps'
  | 'version'
  | 'doctor'
  | 'logs'
  | 'open'
  | 'configure'
  | 'config'
  | 'start'
  | 'up'
  | 'stop'
  | 'down'
  | 'restart'
  | 'env';

const DOCKER_ONLY = new Set<AwsVpcCommand>(['start', 'up', 'stop', 'down', 'restart']);

export async function runAwsVpcCommand(
  command: string,
  args: string[],
  flags: SelfHostCommandFlags,
): Promise<number> {
  const typedCommand = command as AwsVpcCommand;
  if (DOCKER_ONLY.has(typedCommand)) return rejectDockerLifecycleCommand(typedCommand, flags.instance);

  if (typedCommand === 'init' || typedCommand === 'setup') return initAwsVpc(flags);

  const config = loadAwsConfig(flags.instance);
  if (!config) return 1;
  if (flags.local || flags.registry || (flags.tag !== 'latest' && !flags.release)) {
    process.stderr.write(
      `${status.err('AWS EC2 targets use --release with signed enterprise versions; --tag, --local, and --registry are Docker-only.')}\n`,
    );
    return 2;
  }
  if (!['configure', 'config', 'logs', 'env'].includes(typedCommand) && args.length > 0) {
    process.stderr.write(`${status.err(`unexpected AWS EC2 arguments: ${args.join(' ')}`)}\n`);
    return 2;
  }

  switch (typedCommand) {
    case 'doctor':
      return doctorAwsVpc(config, flags);
    case 'configure':
    case 'config':
      return configureAwsVpc(config, args, flags);
    case 'plan':
      return planAwsVpc(config, flags);
    case 'deploy':
      return deployAwsVpc(config, flags);
    case 'update':
    case 'upgrade':
      return startManagedUpdate(config, 'cli-update', flags);
    case 'reconcile':
      return startManagedUpdate(config, 'cli-reconcile', flags);
    case 'rollback':
      return rollbackAwsVpc(config, flags);
    case 'version':
      return showAwsVpcVersion(config, flags);
    case 'status':
    case 'ps':
      return showAwsVpcStatus(config, flags);
    case 'logs':
      return showAwsVpcLogs(config, args, flags);
    case 'open':
      return openAwsVpc(config);
    case 'env':
      return manageAwsVpcEnv(config, args, flags);
    default:
      process.stderr.write(`${status.err(`unknown AWS EC2 self-host command "${command}"`)}\n`);
      return 2;
  }
}
async function initAwsVpc(flags: SelfHostCommandFlags): Promise<number> {
  try {
    assertAwsVpcInstanceName(flags.instance);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 2;
  }
  if (flags.local || flags.registry || (flags.tag !== 'latest' && !flags.release)) {
    process.stderr.write(
      `${status.err('AWS EC2 targets use signed releases; --local, --registry, and --tag are Docker-only options.')}\n`,
    );
    return 2;
  }
  if (flags.channel && flags.channel !== 'stable') {
    process.stderr.write(`${status.err('AWS EC2 targets may only track the stable channel.')}\n`);
    return 2;
  }
  if (flags.release) {
    try {
      assertEnterpriseRelease(flags.release);
    } catch (error) {
      process.stderr.write(`${status.err((error as Error).message)}\n`);
      return 2;
    }
  }

  const profile = flags.awsProfile?.trim() || process.env.AWS_PROFILE?.trim() || 'default';
  const region = flags.region?.trim()
    || process.env.AWS_REGION?.trim()
    || process.env.AWS_DEFAULT_REGION?.trim()
    || 'us-west-2';

  let identity: AwsIdentity;
  try {
    identity = awsIdentity({ profile, region, account_id: '000000000000' });
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }

  let existing: SelfHostInstanceConfig | null;
  try {
    existing = loadInstanceConfig(flags.instance);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 2;
  }
  if (existing && existing.target !== 'aws-ec2') {
    process.stderr.write(`${status.err(`instance "${flags.instance}" already targets Docker`)}\n`);
    return 2;
  }
  if (existing?.aws && existing.aws.account_id !== identity.Account) {
    process.stderr.write(
      `${status.err(`AWS account mismatch: instance is pinned to ${existing.aws.account_id}, profile ${profile} resolved to ${identity.Account}`)}\n`,
    );
    return 1;
  }

  const aws = mergeAwsConfiguration(
    existing?.aws ?? { profile, region, account_id: identity.Account },
    flags,
    { profile, region, account_id: identity.Account },
  );
  const config: SelfHostInstanceConfig = {
    schema_version: 1,
    instance: flags.instance,
    target: 'aws-ec2',
    channel: 'stable',
    ...(flags.release || existing?.release ? { release: flags.release ?? existing?.release } : {}),
    aws,
  };
  try {
    writeInstanceConfig(config);
    writeEnterpriseTerraformAssets(config.instance);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 2;
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  const missing = missingConfiguration(config.aws!);
  process.stdout.write(`\n  ${C.bold}Kortix Enterprise EC2${C.reset}\n\n`);
  process.stdout.write(`${status.ok(existing ? 'AWS EC2 instance config verified' : 'AWS EC2 instance config created')}\n`);
  process.stdout.write(`  ${C.dim}instance  ${C.reset}${config.instance}\n`);
  process.stdout.write(`  ${C.dim}account   ${C.reset}${identity.Account}\n`);
  process.stdout.write(`  ${C.dim}profile   ${C.reset}${profile}\n`);
  process.stdout.write(`  ${C.dim}region    ${C.reset}${region}\n`);
  process.stdout.write(`  ${C.dim}channel   ${C.reset}stable\n`);
  process.stdout.write(`  ${C.dim}terraform ${C.reset}${enterpriseTerraformRoot(config.instance)}\n\n`);
  if (missing.length > 0) {
    process.stdout.write(`  ${C.dim}Configure ${missing.join(', ')} before planning.${C.reset}\n`);
    process.stdout.write(`  ${C.cyan}kortix self-host configure --instance ${config.instance}${C.reset}\n\n`);
  } else {
    process.stdout.write(`  ${C.dim}Next: ${C.reset}${C.cyan}kortix self-host doctor --instance ${config.instance}${C.reset}\n`);
    process.stdout.write(`        ${C.cyan}kortix self-host plan --instance ${config.instance}${C.reset}\n\n`);
  }
  process.stdout.write(`  ${C.dim}Full AWS EC2 walkthrough: docs/runbooks/enterprise-vpc-deployment.md${C.reset}\n\n`);
  return 0;
}

async function configureAwsVpc(
  config: SelfHostInstanceConfig,
  args: string[],
  flags: SelfHostCommandFlags,
): Promise<number> {
  try {
    verifyPinnedIdentity(config.aws!);
    if (flags.channel && flags.channel !== 'stable') throw new Error('AWS EC2 targets may only track the stable channel');
    const fromArgs = parseConfigurationAssignments(args);
    let aws = mergeAwsConfiguration(config.aws!, flags, fromArgs);
    if (!flags.yes && args.length === 0 && !hasConfigurationFlags(flags)) {
      aws = await promptForConfiguration(aws);
    }
    verifyPinnedIdentity(aws);
    const updated: SelfHostInstanceConfig = { ...config, channel: 'stable', aws };
    writeInstanceConfig(updated);
    writeEnterpriseTerraformAssets(updated.instance);
    const missing = missingConfiguration(aws);
    const payload = {
      instance: updated.instance,
      target: updated.target,
      configured: missing.length === 0,
      missing,
      aws,
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`\n  ${C.bold}kortix self-host configure${C.reset}\n`);
      process.stdout.write(`${status.ok('Secret-free AWS deployment settings saved')}\n`);
      if (missing.length > 0) process.stdout.write(`  ${C.dim}Still required: ${missing.join(', ')}${C.reset}\n`);
      else process.stdout.write(`  ${C.dim}Ready for ${C.reset}${C.cyan}kortix self-host plan --instance ${updated.instance}${C.reset}\n`);
      process.stdout.write('\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 2;
  }
}

function doctorAwsVpc(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  const coordinates = config.aws!;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    const identity = verifyPinnedIdentity(coordinates);
    checks.push({ name: 'aws-identity', ok: true, detail: `${identity.Account} (${identity.Arn})` });
  } catch (error) {
    checks.push({ name: 'aws-identity', ok: false, detail: (error as Error).message });
  }
  for (const [name, command, args] of [
    ['aws-cli', 'aws', ['--version']],
    ['terraform', 'terraform', ['version', '-json']],
  ] as const) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    checks.push({
      name,
      ok: !result.error && result.status === 0,
      detail: result.error?.message ?? (firstLine(result.stdout || result.stderr) || `exit ${result.status ?? 1}`),
    });
  }
  const missing = missingConfiguration(coordinates);
  checks.push({
    name: 'deployment-config',
    ok: missing.length === 0,
    detail: missing.length === 0 ? 'complete and secret-free' : `missing ${missing.join(', ')}`,
  });

  const ok = checks.every((check) => check.ok);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ instance: config.instance, target: config.target, ok, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  ${C.bold}kortix self-host doctor${C.reset}\n`);
    process.stdout.write(`  ${C.dim}instance ${C.reset}${config.instance}\n\n`);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? status.ok(check.name) : status.err(check.name)} ${C.dim}${check.detail}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }
  return ok ? 0 : 1;
}

function planAwsVpc(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  let plans: StagePlan[] = [];
  try {
    const aws = completeConfiguration(config);
    const identity = verifyPinnedIdentity(aws);
    if (flags.release) assertEnterpriseRelease(flags.release);
    const roots = prepareTerraform(config.instance, aws);
    const stateRemote = isRemoteState(config.instance);
    const stateBackend = stateRemote ? join(roots.state, 'backend.hcl') : undefined;
    if (stateRemote && !existsSync(stateBackend!)) {
      throw new Error('migrated state backend is missing backend.hcl; restore it before planning');
    }
    plans.push(terraformPlan('state', roots.state, aws, stateBackend));
    if (stateRemote) {
      const boundary = terraformOutput<string>(roots.state, aws, 'permissions_boundary_arn');
      writeClusterFiles(config.instance, aws, boundary, readBackendConfig(stateBackend!));
      plans.push(terraformPlan('cluster', roots.cluster, aws, join(roots.cluster, 'backend.hcl')));
    }
    const payload = {
      instance: config.instance,
      account_id: identity.Account,
      region: aws.region,
      bootstrap: stateRemote ? 'remote-state' : 'state-bootstrap',
      stages: plans.map(publicPlan),
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else renderPlans(payload.instance, payload.account_id, payload.region, plans);
    return plans.some((plan) => plan.decision === 'blocked') ? 3 : 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  } finally {
    for (const plan of plans) rmSync(plan.planPath, { force: true });
  }
}

async function deployAwsVpc(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): Promise<number> {
  const plans: StagePlan[] = [];
  try {
    const aws = completeConfiguration(config);
    const identity = verifyPinnedIdentity(aws);
    if (flags.release) assertEnterpriseRelease(flags.release);
    if (!flags.yes) {
      if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
        process.stderr.write(
          `${status.err(`AWS EC2 deployment requires confirmation; rerun with --yes after reviewing plan for ${identity.Account}.`)}\n`,
        );
        return 2;
      }
      const approved = await confirm(
        `Apply reviewed enterprise infrastructure for ${config.instance} in ${identity.Account}/${aws.region}`,
        false,
      );
      if (!approved) return 2;
    }

    const roots = prepareTerraform(config.instance, aws);
    const stateWasRemote = isRemoteState(config.instance);
    const stateBackendPathValue = stateWasRemote ? join(roots.state, 'backend.hcl') : undefined;
    plans.push(terraformPlan('state', roots.state, aws, stateBackendPathValue));
    ensureApplicable(plans[0]);
    terraformApply(roots.state, aws, plans[0].planPath);

    const migration = migrateAndVerifyState(config.instance, roots.state, aws, stateWasRemote);
    writeClusterFiles(config.instance, aws, migration.permissionsBoundaryArn, migration.backend);
    plans.push(terraformPlan('cluster', roots.cluster, aws, join(roots.cluster, 'backend.hcl')));
    ensureApplicable(plans[1]);
    terraformApply(roots.cluster, aws, plans[1].planPath);

    const instance = terraformOutput<EnterpriseInstanceOutput>(roots.cluster, aws, 'instance');
    const runtimeSecretArn = requiredOutputString(instance, 'runtime_secret_arn');
    const supabasePrivateIp = requiredOutputString(instance, 'supabase_private_ip');
    const runtime = bootstrapRuntimeSecret(aws, {
      runtimeSecretArn,
      supabasePrivateIp,
      apiDomain: aws.api_domain,
      frontendDomain: aws.frontend_domain,
      instance: config.instance,
      region: aws.region,
    });
    const deployment = runtime.missingOperatorKeys.length === 0
      ? { ...runUpdaterViaSsm(config, { ...(flags.release ? { release: flags.release } : {}), ...(flags.allowDowntime ? { allowDowntime: true } : {}) }), status: 'DEPLOYED' }
      : {
          status: 'WAITING_FOR_RUNTIME_CONFIG',
          command_id: null,
          instance_id: null,
          missing: runtime.missingOperatorKeys,
        };
    const payload = {
      instance: config.instance,
      account_id: identity.Account,
      region: aws.region,
      state: { ...publicPlan(plans[0]), applied: true },
      state_migration: migration.verification,
      cluster: { ...publicPlan(plans[1]), applied: true },
      runtime_secret: {
        arn: runtimeSecretArn,
        bootstrapped: runtime.created,
        missing: runtime.missingOperatorKeys,
      },
      deployment,
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`\n  ${C.bold}Kortix Enterprise EC2 deployed${C.reset}\n`);
      process.stdout.write(`${status.ok(`Terraform state verified at lineage ${migration.verification.lineage}, serial ${migration.verification.serial}`)}\n`);
      process.stdout.write(`${status.ok('Customer cluster infrastructure applied')}\n`);
      process.stdout.write(`${status.ok('Generated core runtime credentials directly into customer Secrets Manager')}\n`);
      if (runtime.missingOperatorKeys.length > 0) {
        process.stdout.write(`${status.warn(`Deployment is waiting for: ${runtime.missingOperatorKeys.join(', ')}`)}\n`);
        process.stdout.write(`  ${C.cyan}kortix self-host env set --instance ${config.instance} KEY=VALUE ...${C.reset}\n`);
        process.stdout.write(`  ${C.cyan}kortix self-host deploy --instance ${config.instance} --yes${C.reset}\n\n`);
      } else {
        process.stdout.write(`${status.ok(`On-box updater completed via SSM: ${deployment.command_id}`)}\n\n`);
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  } finally {
    for (const plan of plans) rmSync(plan.planPath, { force: true });
  }
}

async function startManagedUpdate(
  config: SelfHostInstanceConfig,
  _trigger: 'cli-update' | 'cli-reconcile',
  flags: SelfHostCommandFlags,
): Promise<number> {
  try {
    verifyPinnedIdentity(config.aws!);
    if (flags.channel && flags.channel !== 'stable') throw new Error('AWS EC2 targets may only track the stable channel');
    if (flags.release) assertEnterpriseRelease(flags.release);
    assertRuntimeReady(config);
    const result = runUpdaterViaSsm(config, {
      force: flags.force,
      ...(flags.release ? { release: flags.release } : {}),
      ...(flags.allowDowntime ? { allowDowntime: true } : {}),
    });
    renderUpdaterRun(config, result, flags);
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function manageAwsVpcEnv(
  config: SelfHostInstanceConfig,
  args: string[],
  flags: SelfHostCommandFlags,
): number {
  try {
    const coordinates = config.aws!;
    verifyPinnedIdentity(coordinates);
    const action = args[0] ?? 'ls';
    const secretId = runtimeSecretId(config.instance);
    const current = readRuntimeSecret(coordinates, secretId);
    if (!current) throw new Error(`runtime secret is not initialized; deploy ${config.instance} infrastructure first`);

    if (action === 'ls' || action === 'list') {
      const payload = {
        instance: config.instance,
        secret_id: secretId,
        keys: Object.keys(current).sort(),
        missing_required: missingOperatorRuntimeKeys(current),
      };
      if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else {
        for (const key of payload.keys) process.stdout.write(`${key}=<set>\n`);
        for (const key of payload.missing_required) process.stdout.write(`${key}=<required>\n`);
      }
      return payload.missing_required.length === 0 ? 0 : 1;
    }
    if (action === 'set') {
      const assignments = parseRuntimeAssignments(args.slice(1));
      assertOperatorRuntimeAssignments(assignments);
      const next = { ...current, ...assignments };
      writeRuntimeSecret(coordinates, next, secretId);
      const missing = missingOperatorRuntimeKeys(next);
      const payload = {
        instance: config.instance,
        updated: Object.keys(assignments).sort(),
        missing_required: missing,
      };
      if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else {
        process.stdout.write(`${status.ok(`Updated ${payload.updated.length} value(s) in customer Secrets Manager`)}\n`);
        if (missing.length > 0) process.stdout.write(`  ${C.dim}Still required: ${missing.join(', ')}${C.reset}\n`);
      }
      return 0;
    }
    throw new Error(`unknown env subcommand "${action}"`);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function assertRuntimeReady(config: SelfHostInstanceConfig): void {
  const secret = readRuntimeSecret(config.aws!, runtimeSecretId(config.instance));
  if (!secret) throw new Error(`runtime secret is not initialized; run kortix self-host deploy --instance ${config.instance}`);
  const missing = missingOperatorRuntimeKeys(secret);
  if (missing.length > 0) {
    throw new Error(`runtime configuration is incomplete (${missing.join(', ')}); run kortix self-host env set --instance ${config.instance} KEY=VALUE ...`);
  }
}

function requiredOutputString(value: EnterpriseInstanceOutput, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.length === 0) throw new Error(`cluster output is missing ${key}`);
  return item;
}

async function rollbackAwsVpc(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): Promise<number> {
  try {
    const identity = verifyPinnedIdentity(config.aws!);
    if (!flags.release) throw new Error('rollback requires --release <verified-enterprise-version>');
    assertEnterpriseRelease(flags.release);
    if (!flags.yes) {
      if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
        process.stderr.write(
          `${status.err('rollback requires confirmation; rerun with --yes after reviewing the compatibility contract')}\n`,
        );
        return 2;
      }
      const approved = await confirm(
        `Request rollback of ${config.instance} in ${identity.Account} to ${flags.release}`,
        false,
      );
      if (!approved) return 2;
    }
    const result = runUpdaterViaSsm(config, {
      force: flags.force,
      rollback: flags.release,
      ...(flags.allowDowntime ? { allowDowntime: true } : {}),
    });
    renderUpdaterRun(config, result, flags);
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function showAwsVpcVersion(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  try {
    verifyPinnedIdentity(config.aws!);
    const record = readReleaseRecord(config);
    const payload = {
      instance: config.instance,
      target: config.target,
      channel: 'stable',
      release: record?.version ?? null,
      status: record ? 'deployed' : 'not-deployed',
      deployed_at: record?.deployed_at ?? null,
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`\n  ${C.bold}kortix self-host version${C.reset}\n`);
      for (const [key, value] of Object.entries(payload)) {
        process.stdout.write(`  ${C.dim}${key.padEnd(11)}${C.reset}${value ?? 'none'}\n`);
      }
      process.stdout.write('\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function showAwsVpcStatus(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  try {
    const coordinates = config.aws!;
    verifyPinnedIdentity(coordinates);
    // One appliance host; the whole product is Docker on it.
    const hostResponse = awsJsonOptional<{
      Reservations?: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string }; PublicIpAddress?: string }> }>;
    }>(coordinates, [
      'ec2', 'describe-instances',
      '--filters', `Name=tag:Name,Values=${config.instance}-appliance`, 'Name=instance-state-name,Values=pending,running,stopping,stopped',
    ]);
    const hostInstance = hostResponse?.Reservations?.flatMap((entry) => entry.Instances ?? [])[0];
    const running = hostInstance?.State?.Name === 'running';
    const services = running ? dockerPsViaSsm(config) : [];
    const release = readReleaseRecord(config);
    const payload = {
      instance: config.instance,
      target: config.target,
      account_id: coordinates.account_id,
      region: coordinates.region,
      host: hostInstance ? {
        instance_id: hostInstance.InstanceId ?? null,
        state: hostInstance.State?.Name ?? 'unknown',
        public_ip: hostInstance.PublicIpAddress ?? null,
      } : { instance_id: null, state: 'NOT_DEPLOYED', public_ip: null },
      services,
      release: release
        ? { version: release.version ?? null, supabase_bundle_sha: release.supabase_bundle_sha ?? null, deployed_at: release.deployed_at ?? null }
        : { version: null, supabase_bundle_sha: null, deployed_at: null },
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else renderLiveStatus(payload);
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function showAwsVpcLogs(config: SelfHostInstanceConfig, args: string[], _flags: SelfHostCommandFlags): number {
  try {
    const coordinates = config.aws!;
    verifyPinnedIdentity(coordinates);
    const unknown = args.filter((arg) => arg.startsWith('-') && !['--follow', '-f'].includes(arg));
    if (unknown.length > 0) throw new Error(`unknown logs option: ${unknown.join(', ')}`);
    const services = args.filter((arg) => !arg.startsWith('-'));
    if (services.length > 1) throw new Error('logs accepts at most one service name');
    const service = services[0] ?? 'updater';
    const follow = args.includes('--follow') || args.includes('-f');

    // The whole product runs as Docker/systemd on ONE host; container + unit logs
    // live on the box (streamed via SSM), while the CloudWatch appliance group
    // carries the host/updater log stream.
    const SSM_UNIT: Record<string, string> = {
      supabase: 'journalctl -u kortix-supabase -f -n 200',
      app: 'journalctl -u kortix-app -f -n 200',
      watchdog: 'journalctl -u kortix-watchdog -f -n 200',
      api: 'docker compose --project-name kortix-app logs -f --tail 200 api',
      gateway: 'docker compose --project-name kortix-app logs -f --tail 200 gateway',
      frontend: 'docker compose --project-name kortix-app logs -f --tail 200 frontend',
      caddy: 'docker compose --project-name kortix-app logs -f --tail 200 caddy',
    };
    if (SSM_UNIT[service]) {
      const instanceId = applianceInstanceId(config);
      if (!instanceId) throw new Error(`no running appliance host found for ${config.instance}`);
      const result = spawnAws(coordinates, [
        'ssm', 'start-session', '--target', instanceId,
        '--document-name', 'AWS-StartInteractiveCommand',
        '--parameters', `command=${SSM_UNIT[service]}`,
      ], 'inherit');
      if (result.status !== 0) throw new Error(`SSM log session failed with exit ${result.status ?? 1}`);
      return 0;
    }
    if (service !== 'updater' && service !== 'appliance') {
      throw new Error('logs service must be updater, appliance, supabase, app, watchdog, api, gateway, frontend, or caddy');
    }
    const group = `/kortix/${config.instance}/appliance`;
    const result = spawnAws(coordinates, [
      'logs', 'tail', group, '--since', '1h', ...(follow ? ['--follow'] : []), '--no-cli-pager',
    ]);
    if (result.status !== 0) throw new Error(firstLine(result.stderr) || `CloudWatch logs failed with exit ${result.status ?? 1}`);
    process.stdout.write(result.stdout);
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function openAwsVpc(config: SelfHostInstanceConfig): number {
  try {
    const aws = completeConfiguration(config);
    verifyPinnedIdentity(aws);
    const url = `https://${aws.frontend_domain}`;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const result = spawnSync(command, args, { stdio: 'ignore' });
    if (result.error || result.status !== 0) throw new Error(`could not open ${url}`);
    process.stdout.write(`${url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
}

function renderPlans(instance: string, account: string, region: string, plans: StagePlan[]): void {
  process.stdout.write(`\n  ${C.bold}kortix self-host plan${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${instance}\n`);
  process.stdout.write(`  ${C.dim}target   ${C.reset}${account}/${region}\n\n`);
  for (const plan of plans) {
    const summary = plan.summary;
    process.stdout.write(`  ${plan.decision === 'blocked' ? status.err(plan.name) : status.ok(plan.name)} ${plan.decision}\n`);
    process.stdout.write(`    ${C.dim}create=${summary.create} update=${summary.update} delete=${summary.delete} replace=${summary.replace}${C.reset}\n`);
    for (const reason of plan.reasons) process.stdout.write(`    ${C.dim}${reason.severity}: ${reason.address}: ${reason.reason}${C.reset}\n`);
  }
  process.stdout.write('\n');
}

function renderUpdaterRun(
  config: SelfHostInstanceConfig,
  result: UpdaterRunResult,
  flags: SelfHostCommandFlags,
): void {
  const payload = { instance: config.instance, channel: 'stable', ...result };
  if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`\n  ${C.bold}Kortix on-box updater${C.reset}\n`);
    process.stdout.write(`${status.ok(result.command_id)}\n`);
    process.stdout.write(`  ${C.dim}SSM ran kortix-updater on ${result.instance_id}: TUF verify, digest pull, migrate, start-first roll, health, breadcrumb.${C.reset}\n\n`);
  }
}

function renderLiveStatus(payload: {
  instance: string;
  account_id: string;
  region: string;
  host: { state: unknown; public_ip: unknown };
  services: DockerServiceStatus[];
  release: { version: unknown; deployed_at: unknown };
}): void {
  process.stdout.write(`\n  ${C.bold}kortix self-host status${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance   ${C.reset}${payload.instance}\n`);
  process.stdout.write(`  ${C.dim}target     ${C.reset}${payload.account_id}/${payload.region}\n`);
  process.stdout.write(`  ${C.dim}host       ${C.reset}${String(payload.host.state)}${payload.host.public_ip ? ` (${String(payload.host.public_ip)})` : ''}\n`);
  for (const service of payload.services) {
    process.stdout.write(`  ${C.dim}${service.service.padEnd(11)}${C.reset}${service.state}${service.health ? ` (${service.health})` : ''}\n`);
  }
  process.stdout.write(`  ${C.dim}release    ${C.reset}${String(payload.release.version ?? 'not deployed')}${payload.release.deployed_at ? ` (${String(payload.release.deployed_at)})` : ''}\n\n`);
}

function rejectDockerLifecycleCommand(command: AwsVpcCommand, instance: string): number {
  const canonical = command === 'up' ? 'start' : command === 'down' ? 'stop' : command;
  process.stderr.write(`${status.err(`${canonical} is only available for Docker targets.`)}\n`);
  if (canonical === 'start') {
    process.stderr.write(
      `${C.dim}AWS EC2 environments are continuously reconciled; bootstrap with ${C.reset}${C.cyan}kortix self-host deploy --instance ${instance}${C.reset}${C.dim}.${C.reset}\n`,
    );
  }
  return 2;
}

function loadAwsConfig(instance: string): SelfHostInstanceConfig | null {
  let config: SelfHostInstanceConfig | null;
  try {
    config = loadInstanceConfig(instance);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return null;
  }
  if (!config) {
    process.stderr.write(
      `${status.err(`Self-host instance "${instance}" is not initialized. Run \`kortix self-host init --target aws-ec2 --instance ${instance}\` first.`)}\n`,
    );
    return null;
  }
  if (config.target !== 'aws-ec2' || !config.aws) {
    process.stderr.write(`${status.err(`Self-host instance "${instance}" is not an AWS EC2 target.`)}\n`);
    return null;
  }
  return config;
}
