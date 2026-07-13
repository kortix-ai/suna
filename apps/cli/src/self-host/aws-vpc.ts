import { spawnSync } from 'node:child_process';

import { C, status } from '../style.ts';
import {
  loadInstanceConfig,
  writeInstanceConfig,
  type AwsVpcCoordinates,
  type SelfHostInstanceConfig,
} from './config.ts';
import type { SelfHostCommandFlags } from './types.ts';

interface AwsIdentity {
  UserId: string;
  Account: string;
  Arn: string;
}

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

const DOCKER_ONLY = new Set<AwsVpcCommand>(['start', 'up', 'stop', 'down', 'restart', 'env']);

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

  switch (typedCommand) {
    case 'doctor':
      return doctorAwsVpc(config, flags);
    case 'version':
      return showAwsVpcVersion(config, flags);
    case 'status':
    case 'ps':
      return showAwsVpcStatus(config, flags);
    case 'plan':
    case 'deploy':
    case 'update':
    case 'upgrade':
    case 'reconcile':
    case 'rollback':
    case 'logs':
    case 'open':
    case 'configure':
    case 'config':
      return unavailableUntilBootstrap(typedCommand, config, args, flags);
    default:
      process.stderr.write(`${status.err(`unknown AWS VPC self-host command "${command}"`)}\n`);
      return 2;
  }
}

async function initAwsVpc(flags: SelfHostCommandFlags): Promise<number> {
  if (flags.local || flags.registry || flags.tag !== 'latest') {
    process.stderr.write(
      `${status.err('AWS VPC targets use signed releases; --local, --registry, and --tag are Docker-only options.')}\n`,
    );
    return 2;
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

  const existing = loadInstanceConfig(flags.instance);
  if (existing?.aws && existing.aws.account_id !== identity.Account) {
    process.stderr.write(
      `${status.err(`AWS account mismatch: instance is pinned to ${existing.aws.account_id}, profile ${profile} resolved to ${identity.Account}`)}\n`,
    );
    return 1;
  }

  const config: SelfHostInstanceConfig = {
    schema_version: 1,
    instance: flags.instance,
    target: 'aws-vpc',
    channel: flags.channel ?? existing?.channel ?? 'stable',
    ...(flags.release || existing?.release ? { release: flags.release ?? existing?.release } : {}),
    aws: { profile, region, account_id: identity.Account },
  };
  writeInstanceConfig(config);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`\n  ${C.bold}Kortix Enterprise VPC${C.reset}\n\n`);
  process.stdout.write(`${status.ok(existing ? 'AWS VPC instance config verified' : 'AWS VPC instance config created')}\n`);
  process.stdout.write(`  ${C.dim}instance  ${C.reset}${config.instance}\n`);
  process.stdout.write(`  ${C.dim}target    ${C.reset}${config.target}\n`);
  process.stdout.write(`  ${C.dim}account   ${C.reset}${identity.Account}\n`);
  process.stdout.write(`  ${C.dim}profile   ${C.reset}${profile}\n`);
  process.stdout.write(`  ${C.dim}region    ${C.reset}${region}\n`);
  process.stdout.write(`  ${C.dim}channel   ${C.reset}${config.channel}\n\n`);
  process.stdout.write(`  ${C.dim}Next: ${C.reset}${C.cyan}kortix self-host doctor --instance ${config.instance}${C.reset}\n`);
  process.stdout.write(`        ${C.cyan}kortix self-host plan --instance ${config.instance}${C.reset}\n\n`);
  return 0;
}

function doctorAwsVpc(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  const coordinates = config.aws!;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    const identity = awsIdentity(coordinates);
    checks.push({
      name: 'aws-identity',
      ok: identity.Account === coordinates.account_id,
      detail: `${identity.Account} (${identity.Arn})`,
    });
  } catch (error) {
    checks.push({ name: 'aws-identity', ok: false, detail: (error as Error).message });
  }
  for (const [name, command, args] of [
    ['terraform', 'terraform', ['version', '-json']],
    ['kubectl', 'kubectl', ['version', '--client=true', '--output=json']],
    ['helm', 'helm', ['version', '--short']],
  ] as const) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    checks.push({
      name,
      ok: !result.error && result.status === 0,
      detail: result.error?.message ?? (firstLine(result.stdout || result.stderr) || `exit ${result.status ?? 1}`),
    });
  }

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

function showAwsVpcVersion(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  const payload = {
    instance: config.instance,
    target: config.target,
    channel: config.channel,
    release: config.release ?? null,
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`\n  ${C.bold}kortix self-host version${C.reset}\n`);
    process.stdout.write(`  ${C.dim}instance ${C.reset}${config.instance}\n`);
    process.stdout.write(`  ${C.dim}channel  ${C.reset}${config.channel}\n`);
    process.stdout.write(`  ${C.dim}release  ${C.reset}${config.release ?? 'not deployed'}\n\n`);
  }
  return 0;
}

function showAwsVpcStatus(config: SelfHostInstanceConfig, flags: SelfHostCommandFlags): number {
  const coordinates = config.aws!;
  let identity: AwsIdentity;
  try {
    identity = awsIdentity(coordinates);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n`);
    return 1;
  }
  if (identity.Account !== coordinates.account_id) {
    process.stderr.write(
      `${status.err(`AWS account mismatch: expected ${coordinates.account_id}, resolved ${identity.Account}`)}\n`,
    );
    return 1;
  }
  const payload = {
    instance: config.instance,
    target: config.target,
    account_id: coordinates.account_id,
    region: coordinates.region,
    channel: config.channel,
    release: config.release ?? null,
    bootstrap: 'pending',
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`\n  ${C.bold}kortix self-host status${C.reset}\n`);
    for (const [key, value] of Object.entries(payload)) {
      process.stdout.write(`  ${C.dim}${key.padEnd(11)}${C.reset}${value ?? 'none'}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

function unavailableUntilBootstrap(
  command: AwsVpcCommand,
  config: SelfHostInstanceConfig,
  _args: string[],
  _flags: SelfHostCommandFlags,
): number {
  process.stderr.write(
    `${status.err(`AWS VPC ${command} is not available until the enterprise bootstrap bundle is installed for ${config.instance}.`)}\n`,
  );
  process.stderr.write(`${C.dim}Run ${C.reset}${C.cyan}kortix self-host doctor --instance ${config.instance}${C.reset}${C.dim} first.${C.reset}\n`);
  return 1;
}

function rejectDockerLifecycleCommand(command: AwsVpcCommand, instance: string): number {
  const canonical = command === 'up' ? 'start' : command === 'down' ? 'stop' : command;
  process.stderr.write(`${status.err(`${canonical} is only available for Docker targets.`)}\n`);
  if (canonical === 'start') {
    process.stderr.write(
      `${C.dim}AWS VPC environments are continuously reconciled; bootstrap with ${C.reset}${C.cyan}kortix self-host deploy --instance ${instance}${C.reset}${C.dim}.${C.reset}\n`,
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
      `${status.err(`Self-host instance "${instance}" is not initialized. Run \`kortix self-host init --target aws-vpc --instance ${instance}\` first.`)}\n`,
    );
    return null;
  }
  if (config.target !== 'aws-vpc' || !config.aws) {
    process.stderr.write(`${status.err(`Self-host instance "${instance}" is not an AWS VPC target.`)}\n`);
    return null;
  }
  return config;
}

function awsIdentity(coordinates: AwsVpcCoordinates): AwsIdentity {
  const result = spawnSync(
    'aws',
    [
      '--profile', coordinates.profile,
      '--region', coordinates.region,
      'sts', 'get-caller-identity',
      '--output', 'json',
      '--no-cli-pager',
    ],
    { encoding: 'utf8' },
  );
  if (result.error) throw new Error(`unable to run AWS CLI: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`AWS identity check failed for profile ${coordinates.profile}: ${firstLine(result.stderr) || `exit ${result.status}`}`);
  }
  try {
    const identity = JSON.parse(result.stdout) as AwsIdentity;
    if (!/^\d{12}$/.test(identity.Account) || !identity.Arn) throw new Error('missing Account or Arn');
    return identity;
  } catch (error) {
    throw new Error(`AWS identity response was invalid: ${(error as Error).message}`);
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}
