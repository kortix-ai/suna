import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { getHost, upsertHost, type Host } from '../api/config.ts';
import { prompt, selectFrom } from '../prompts.ts';
import { C, help, status } from '../style.ts';
import { runAwsVpcCommand } from '../self-host/aws-vpc.ts';
import {
  instanceDir as targetInstanceDir,
  loadInstanceConfig,
  parseSelfHostTarget,
  resolveInstanceTarget,
  writeInstanceConfig,
} from '../self-host/config.ts';
import type { SelfHostCommandFlags } from '../self-host/types.ts';
import { renderFullDockerCompose, writeSupabaseVendorAssets } from '../self-host/compose-assets.ts';

const DEFAULT_INSTANCE = 'default';
const DEFAULT_TAG = 'latest';
const DEFAULT_HOST_NAME = 'selfhost';
const DEFAULT_PUBLIC_URL = 'http://localhost:13737';
const DEFAULT_API_URL = 'http://localhost:13738';
const DEFAULT_FRONTEND_IMAGE_REPO = 'kortix/kortix-frontend';
const DEFAULT_API_IMAGE_REPO = 'kortix/kortix-api';
const DEFAULT_GATEWAY_IMAGE_REPO = 'kortix/kortix-gateway';
const DEFAULT_SANDBOX_IMAGE_REPO = 'kortix/kortix-sandbox';
const LOCAL_SOURCE_TAG = 'selfhost-local';

const HELP = help`Usage: kortix self-host <subcommand> [options]

Run Kortix on your own infrastructure. Two deployment targets:

  this machine   --target docker    the full stack via Docker Compose on
                                     whatever machine you run this on. Just works.
  AWS EC2        --target aws-ec2    provision and manage a remote single-EC2
                                     Kortix appliance in your AWS account.

New instances default to docker. For the AWS EC2 walkthrough (Terraform,
domains, secrets, signed updates) see docs/runbooks/enterprise-vpc-deployment.md.
Existing Docker instances remain fully compatible.

Subcommands:
  init                 Create a this-machine (Docker) or AWS EC2 instance config.
  configure            Configure target integrations and secrets.
  plan                 Preview target changes without applying them.
  deploy               Bootstrap or converge the selected target.
  start                Pull images and start your self-hosted Kortix.
  update               Apply a selected Docker tag or signed AWS release.
  reconcile            Check and converge to the configured release channel.
  rollback             Roll back to a compatible signed release.
  version              Show the running version and image tags.
  stop                 Stop the stack.
  restart              Restart the stack.
  status               Show target health and deployment status.
  doctor               Validate local tools, credentials, and target access.
  logs [service]       Tail logs.
  open                 Open the target dashboard.
  env ls              Show persistent environment values.
  env set KEY=VALUE    Update persistent environment values.

Options:
  --instance <name>    Instance name (default: ${DEFAULT_INSTANCE}).
  --target <target>    docker (this machine) or aws-ec2 (AWS EC2). Default:
                       docker for new instances.
  --tag <tag>          Docker image tag / version (default: ${DEFAULT_TAG}).
  --release <version>  Immutable enterprise release (for example 0.9.84-e1).
  --channel <name>     Release channel (AWS default: stable; Docker: latest).
  --aws-profile <name> AWS CLI profile used to bootstrap/manage the target.
  --region <region>    AWS region (default: AWS config, then us-west-2).
  --vpc-cidr <cidr>    Dedicated /16 CIDR for an AWS EC2 target.
  --api-domain <name>  Public API DNS name for the AWS target.
  --frontend-domain <name> Public dashboard DNS name for the AWS target.
  --route53-zone-id <id> Customer Route 53 public hosted zone for DNS and ACM.
  --release-repository-url <url> Immutable enterprise TUF repository.
  --tuf-root-sha256 <digest> Offline-reviewed trusted TUF root digest.
  --updater-bootstrap-url <url> Digest-pinned enterprise updater binary.
  --updater-bootstrap-sha256 <digest> Updater binary SHA-256.
  --release-publisher-account-id <id> Account allowed to send wake-up hints.
  --maintenance-window <window> UTC window, for example Sun:02:00-05:00.
  --local              Use current-source local images instead of registry images.
  --registry           Force registry images even when running from a source checkout.
  --force              Run now, bypassing only the configured maintenance window.
  --allow-downtime     Permit a release whose migration is not backward-compatible
                       to deploy with a brief, honest downtime window (stop app,
                       migrate, start new). Without it such a release is refused.
  --json               Emit machine-readable output where supported.
  --yes                Accept defaults in non-interactive flows.
  -h, --help           Show this help.

Examples:
  kortix self-host init                    # this machine (Docker)
  kortix self-host start
  kortix self-host init --target aws-ec2 --instance customer --aws-profile customer --region us-west-2
  kortix self-host plan --instance customer
  kortix self-host deploy --instance customer
  kortix self-host reconcile --instance customer --channel stable
  kortix self-host update                 # update to the latest published version
  kortix self-host update --tag 0.9.72    # pin to a specific version
  kortix self-host version
  kortix self-host env set PUBLIC_URL=https://kortix.example.com API_PUBLIC_URL=https://api.example.com
  kortix hosts ls
`;

type GlobalFlags = SelfHostCommandFlags;

interface SelfHostEnv {
  KORTIX_VERSION: string;
  PUBLIC_URL: string;
  API_PUBLIC_URL: string;
  SUPABASE_PUBLIC_URL: string;
  FRONTEND_PORT: string;
  API_PORT: string;
  SUPABASE_PORT: string;
  POSTGRES_PORT: string;
  FRONTEND_IMAGE: string;
  API_IMAGE: string;
  GATEWAY_IMAGE: string;
  SANDBOX_IMAGE: string;
  KORTIX_LOCAL_IMAGES: string;
  KORTIX_PUBLIC_AUTH_METHODS: string;
  GATEWAY_INTERNAL_TOKEN: string;
  OPENROUTER_API_KEY: string;
  POSTGRES_PASSWORD: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INTERNAL_SERVICE_KEY: string;
  API_KEY_SECRET: string;
  TUNNEL_SIGNING_SECRET: string;
  ALLOWED_SANDBOX_PROVIDERS: string;
  DAYTONA_API_KEY: string;
  DAYTONA_SERVER_URL: string;
  DAYTONA_TARGET: string;
  KORTIX_GITHUB_APP_ID: string;
  KORTIX_GITHUB_APP_PRIVATE_KEY: string;
  KORTIX_GITHUB_APP_SLUG: string;
  KORTIX_GITHUB_TOKEN: string;
  KORTIX_GITHUB_OWNER: string;
  // Managed git: the backend that provisions project repos. The API reads these
  // MANAGED_GIT_* vars (KORTIX_GITHUB_* alone don't reach it), so the wizard sets
  // both. Without it, project create/CRUD fails "provider github not configured".
  MANAGED_GIT_PROVIDER: string;
  MANAGED_GIT_GITHUB_TOKEN: string;
  MANAGED_GIT_GITHUB_OWNER: string;
  MANAGED_GIT_GITHUB_INSTALL_ID: string;
  INTEGRATION_AUTH_PROVIDER: string;
  KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED: string;
  PIPEDREAM_CLIENT_ID: string;
  PIPEDREAM_CLIENT_SECRET: string;
  PIPEDREAM_PROJECT_ID: string;
  PIPEDREAM_ENVIRONMENT: string;
  PIPEDREAM_WEBHOOK_SECRET: string;
  [key: string]: string;
}

export async function runSelfHost(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 0 : 0;
  }

  const args = [...argv];
  const sub = args.shift()!;
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let flags: GlobalFlags;
  try {
    flags = parseGlobalFlags(args);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n\n${HELP}`);
    return 2;
  }

  let target;
  try {
    target = resolveInstanceTarget(flags.instance, flags.target);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  if (target === 'aws-ec2') {
    return runAwsVpcCommand(sub, args, flags);
  }

  switch (sub) {
    case 'init':
    case 'setup':
      return selfHostInit(flags);
    case 'plan':
      return selfHostDockerPlan(flags);
    case 'deploy':
      return selfHostStart(flags);
    case 'start':
    case 'up':
      return selfHostStart(flags);
    case 'update':
    case 'upgrade':
      return selfHostUpdate(flags);
    case 'reconcile':
      return selfHostUpdate(flags);
    case 'rollback':
      return selfHostDockerRollback(flags);
    case 'version':
      return selfHostVersion(flags);
    case 'stop':
    case 'down':
      return composeCommand(flags, ['down']);
    case 'restart':
      return selfHostRestart(flags);
    case 'status':
    case 'ps':
      return composeCommand(flags, ['ps']);
    case 'doctor':
      return selfHostDockerDoctor(flags);
    case 'logs':
      return composeCommand(flags, ['logs', '-f', ...args]);
    case 'open':
      return selfHostOpen(flags);
    case 'configure':
    case 'config':
      return selfHostConfigure(flags);
    case 'env':
      return selfHostEnv(args, flags);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

function parseGlobalFlags(args: string[]): GlobalFlags {
  const yes = takeFlagBool(args, ['--yes', '-y']);
  const local = takeFlagBool(args, ['--local']);
  const registry = takeFlagBool(args, ['--registry']);
  const json = takeFlagBool(args, ['--json']);
  const force = takeFlagBool(args, ['--force']);
  const allowDowntime = takeFlagBool(args, ['--allow-downtime']);
  const instance = takeFlagValue(args, ['--instance']) ?? DEFAULT_INSTANCE;
  const release = takeFlagValue(args, ['--release']);
  const tag = takeFlagValue(args, ['--tag', '--version']) ?? release ?? DEFAULT_TAG;
  const target = parseSelfHostTarget(takeFlagValue(args, ['--target']));
  const awsProfile = takeFlagValue(args, ['--aws-profile']);
  const region = takeFlagValue(args, ['--region']);
  const channel = takeFlagValue(args, ['--channel']);
  const vpcCidr = takeFlagValue(args, ['--vpc-cidr']);
  const apiDomain = takeFlagValue(args, ['--api-domain']);
  const frontendDomain = takeFlagValue(args, ['--frontend-domain']);
  const route53ZoneId = takeFlagValue(args, ['--route53-zone-id']);
  const releaseRepositoryUrl = takeFlagValue(args, ['--release-repository-url']);
  const tufRootSha256 = takeFlagValue(args, ['--tuf-root-sha256']);
  const updaterBootstrapUrl = takeFlagValue(args, ['--updater-bootstrap-url']);
  const updaterBootstrapSha256 = takeFlagValue(args, ['--updater-bootstrap-sha256']);
  const releasePublisherAccountId = takeFlagValue(args, ['--release-publisher-account-id']);
  const maintenanceWindow = takeFlagValue(args, ['--maintenance-window']);
  if (local && registry) {
    throw new Error('use either --local or --registry, not both');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(instance)) {
    throw new Error('instance must start with a letter and contain only letters, digits, dots, underscores, or dashes');
  }
  return {
    instance,
    tag,
    release,
    channel,
    target,
    awsProfile,
    region,
    vpcCidr,
    apiDomain,
    frontendDomain,
    route53ZoneId,
    releaseRepositoryUrl,
    tufRootSha256,
    updaterBootstrapUrl,
    updaterBootstrapSha256,
    releasePublisherAccountId,
    maintenanceWindow,
    yes,
    local,
    registry,
    json,
    force,
    allowDowntime,
  };
}

async function selfHostInit(flags: GlobalFlags): Promise<number> {
  const dir = instanceDir(flags.instance);
  mkdirSync(dir, { recursive: true });

  const existing = loadEnv(flags.instance);
  const env = { ...defaultEnv(flags), ...(existing ?? {}) };

  env.KORTIX_VERSION = flags.tag;
  if (!existing || existing.FRONTEND_IMAGE === `${DEFAULT_FRONTEND_IMAGE_REPO}:${existing.KORTIX_VERSION}`) {
    env.FRONTEND_IMAGE = `${DEFAULT_FRONTEND_IMAGE_REPO}:${flags.tag}`;
  }
  if (!existing || existing.API_IMAGE === `${DEFAULT_API_IMAGE_REPO}:${existing.KORTIX_VERSION}`) {
    env.API_IMAGE = `${DEFAULT_API_IMAGE_REPO}:${flags.tag}`;
  }
  if (!existing || existing.GATEWAY_IMAGE === `${DEFAULT_GATEWAY_IMAGE_REPO}:${existing.KORTIX_VERSION}`) {
    env.GATEWAY_IMAGE = `${DEFAULT_GATEWAY_IMAGE_REPO}:${flags.tag}`;
  }
  if (!existing || existing.SANDBOX_IMAGE === `${DEFAULT_SANDBOX_IMAGE_REPO}:${existing.KORTIX_VERSION}`) {
    env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${flags.tag}`;
  }

  if (shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env);
  }

  writeEnv(flags.instance, env);
  writeCompose(flags.instance);
  const existingConfig = loadInstanceConfig(flags.instance);
  writeInstanceConfig({
    schema_version: 1,
    instance: flags.instance,
    target: 'docker',
    channel: flags.channel ?? existingConfig?.channel ?? 'latest',
    ...(flags.release || existingConfig?.release ? { release: flags.release ?? existingConfig?.release } : {}),
  });
  renderInitSummary(flags.instance, dir, env, existing !== null);
  return 0;
}

function renderInitSummary(instance: string, dir: string, env: SelfHostEnv, refreshed: boolean): void {
  process.stdout.write(`\n  ${C.bold}Kortix self-host${C.reset}\n\n`);
  process.stdout.write(`${status.ok(refreshed ? 'Self-host config refreshed' : 'Self-host config created')}\n`);
  process.stdout.write(`  ${C.dim}instance  ${C.reset}${instance}\n`);
  process.stdout.write(`  ${C.dim}config    ${C.reset}${dir}\n\n`);
  process.stdout.write(`  ${C.dim}Dashboard ${C.reset}${C.cyan}${env.PUBLIC_URL}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}API       ${C.reset}${env.API_PUBLIC_URL}\n`);
  process.stdout.write(`  ${C.dim}Supabase  ${C.reset}${env.SUPABASE_PUBLIC_URL}\n`);
  process.stdout.write(`  ${C.dim}Images    ${C.reset}${env.FRONTEND_IMAGE}, ${env.API_IMAGE}, ${env.SANDBOX_IMAGE}\n\n`);
  renderIntegrationSummary(env);
  process.stdout.write(`  ${C.dim}Start      ${C.reset}${C.cyan}kortix self-host start${instance === DEFAULT_INSTANCE ? '' : ` --instance ${instance}`}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Configure  ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} or ${C.reset}${C.cyan}kortix self-host env set KEY=VALUE${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Switch API  ${C.reset}${C.cyan}kortix hosts use selfhost${C.reset}${C.dim} / ${C.reset}${C.cyan}kortix hosts use cloud${C.reset}\n\n`);
}

async function selfHostStart(flags: GlobalFlags): Promise<number> {
  if (!existsSync(envPath(flags.instance)) || !existsSync(composePath(flags.instance))) {
    const code = await selfHostInit(flags);
    if (code !== 0) return code;
  }

  const env = loadEnvWithDefaults(flags)!;
  if (shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env);
  }
  const localImageMode = shouldUseLocalSourceImages(flags);
  if (localImageMode) {
    ensureLocalSourceImages();
    applyLocalSourceImages(env);
  }
  const portChanges = await reconcilePorts(flags.instance, env);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance);

  process.stdout.write(`\n  ${C.bold}kortix self-host start${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);
  process.stdout.write(`  ${C.dim}images   ${C.reset}${env.FRONTEND_IMAGE}, ${env.API_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}api      ${C.reset}${env.API_PUBLIC_URL}\n\n`);
  if (localImageMode) {
    process.stdout.write(`${C.dim}  images   current source checkout (${LOCAL_SOURCE_TAG}); pull skipped${C.reset}\n`);
  }
  if (portChanges.length > 0) {
    process.stdout.write(`${C.dim}  ports    ${C.reset}${portChanges.join(', ')}\n\n`);
  }

  if (!sandboxProviderConfigured(env)) {
    process.stdout.write(
      `${C.yellow}  warning${C.reset}  ${C.dim}sandbox runtime not configured — agent sessions will fail to start.${C.reset}\n`,
    );
    process.stdout.write(
      `${C.dim}           run ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} to set ${C.reset}DAYTONA_API_KEY${C.dim}.${C.reset}\n\n`,
    );
  }

  if (!gitProviderConfigured(env)) {
    process.stdout.write(
      `${C.yellow}  warning${C.reset}  ${C.dim}managed git not configured — creating projects will fail.${C.reset}\n`,
    );
    process.stdout.write(
      `${C.dim}           run ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} to connect GitHub (PAT or App).${C.reset}\n\n`,
    );
  }

  if (env.KORTIX_LOCAL_IMAGES === 'true') {
    process.stdout.write(`${C.dim}  pull     skipped (KORTIX_LOCAL_IMAGES=true)${C.reset}\n`);
  } else {
    const pull = compose(flags.instance, ['pull']);
    if (pull !== 0) return pull;
  }
  const up = compose(flags.instance, ['up', '-d']);
  if (up !== 0) return up;
  const refreshApp = compose(flags.instance, ['up', '-d', '--force-recreate', '--no-deps', 'kortix-api', 'frontend']);
  if (refreshApp !== 0) return refreshApp;

  registerLocalHost(DEFAULT_HOST_NAME, env.API_PUBLIC_URL);
  process.stdout.write(`${status.ok('Self-hosted Kortix is starting')}\n`);
  process.stdout.write(`${C.dim}  Dashboard: ${C.reset}${C.cyan}${env.PUBLIC_URL}${C.reset}\n`);
  process.stdout.write(`${C.dim}  Logs:      ${C.reset}${C.cyan}kortix self-host logs${C.reset}\n\n`);
  renderIntegrationSummary(env);
  return 0;
}

async function selfHostRestart(flags: GlobalFlags): Promise<number> {
  const down = composeCommand(flags, ['down']);
  if (down !== 0) return down;
  return selfHostStart(flags);
}

function selfHostDockerPlan(flags: GlobalFlags): number {
  if (!existsSync(composePath(flags.instance)) || !existsSync(envPath(flags.instance))) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  const code = compose(flags.instance, ['config', '--quiet']);
  if (code !== 0) return code;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      instance: flags.instance,
      target: 'docker',
      valid: true,
      compose_file: composePath(flags.instance),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${status.ok(`Docker Compose plan is valid for ${flags.instance}`)}\n`);
    process.stdout.write(`${C.dim}No changes were applied.${C.reset}\n`);
  }
  return 0;
}

function selfHostDockerRollback(flags: GlobalFlags): Promise<number> | number {
  const release = flags.release ?? (flags.tag !== DEFAULT_TAG ? flags.tag : undefined);
  if (!release) {
    process.stderr.write(
      `${status.err('Docker rollback requires an explicit --release <version> or --tag <version>.')}\n`,
    );
    return 2;
  }
  return selfHostUpdate({ ...flags, tag: release });
}

function selfHostDockerDoctor(flags: GlobalFlags): number {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const [name, args] of [
    ['docker', ['--version']],
    ['docker-compose', ['compose', 'version']],
  ] as const) {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    checks.push({
      name,
      ok: !result.error && result.status === 0,
      detail: result.error?.message ?? (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] ?? '',
    });
  }
  if (existsSync(composePath(flags.instance)) && existsSync(envPath(flags.instance))) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--project-name', composeProject(flags.instance),
        '--env-file', envPath(flags.instance),
        '-f', composePath(flags.instance),
        'config', '--quiet',
      ],
      { cwd: instanceDir(flags.instance), encoding: 'utf8' },
    );
    checks.push({
      name: 'compose-config',
      ok: !result.error && result.status === 0,
      detail: result.error?.message ?? (result.stderr.trim() || 'valid'),
    });
  }
  const ok = checks.every((check) => check.ok);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ instance: flags.instance, target: 'docker', ok, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  ${C.bold}kortix self-host doctor${C.reset}\n\n`);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? status.ok(check.name) : status.err(check.name)} ${C.dim}${check.detail}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }
  return ok ? 0 : 1;
}

/**
 * Update an existing instance to a newer version: point the image tags at the
 * requested version (default `latest`), then down→start. `start` re-pulls the
 * tags and the kortix-migrate one-shot applies any new migrations before the
 * API serves traffic. The Postgres volume is preserved across the restart, so
 * this is a true in-place upgrade. Source-image instances rebuild instead.
 */
async function selfHostUpdate(flags: GlobalFlags): Promise<number> {
  if (!existsSync(envPath(flags.instance)) || !existsSync(composePath(flags.instance))) {
    // Nothing to update yet — behave like a first start.
    return selfHostStart(flags);
  }

  const env = loadEnvWithDefaults(flags)!;
  const oldVersion = env.KORTIX_VERSION || 'unknown';
  const localImageMode = env.KORTIX_LOCAL_IMAGES === 'true' || shouldUseLocalSourceImages(flags);

  process.stdout.write(`\n  ${C.bold}kortix self-host update${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);

  if (localImageMode) {
    process.stdout.write(`  ${C.yellow}This instance runs current-source images (${LOCAL_SOURCE_TAG}).${C.reset}\n`);
    process.stdout.write(`  ${C.dim}Rebuilding from the local checkout and applying migrations…${C.reset}\n\n`);
    return selfHostRestart(flags);
  }

  const targetTag = flags.tag;
  env.KORTIX_VERSION = targetTag;
  env.FRONTEND_IMAGE = `${DEFAULT_FRONTEND_IMAGE_REPO}:${targetTag}`;
  env.API_IMAGE = `${DEFAULT_API_IMAGE_REPO}:${targetTag}`;
  env.GATEWAY_IMAGE = `${DEFAULT_GATEWAY_IMAGE_REPO}:${targetTag}`;
  env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${targetTag}`;
  writeEnv(flags.instance, env);
  writeCompose(flags.instance);

  process.stdout.write(`  ${C.dim}version  ${C.reset}${oldVersion} ${C.dim}→${C.reset} ${C.cyan}${targetTag}${C.reset}\n\n`);
  // down keeps the named Postgres volume; start re-pulls + migrates + recreates.
  return selfHostRestart(flags);
}

function isSemverTag(s: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(s);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Resolve published version info from Docker Hub: the newest released version
 * and, when running `:latest`, the concrete version it currently points to (by
 * matching the `latest` tag's digest). Best-effort — returns nulls offline.
 */
async function fetchPublishedVersions(repo: string): Promise<{ latest: string | null; latestResolved: string | null }> {
  try {
    const res = await fetch(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`);
    if (!res.ok) return { latest: null, latestResolved: null };
    const data = (await res.json()) as { results?: Array<{ name: string; digest?: string; images?: Array<{ digest?: string }> }> };
    const rows = data.results ?? [];
    const digestOf = (name: string): string => {
      const r = rows.find((x) => x.name === name);
      return r?.digest || r?.images?.[0]?.digest || '';
    };
    const semvers = rows.map((r) => r.name).filter(isSemverTag).sort((a, b) => compareSemver(b, a));
    const latest = semvers[0] ?? null;
    const latestDigest = digestOf('latest');
    const latestResolved = latestDigest
      ? semvers.find((v) => digestOf(v) && digestOf(v) === latestDigest) ?? null
      : null;
    return { latest, latestResolved };
  } catch {
    return { latest: null, latestResolved: null };
  }
}

async function selfHostVersion(flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  const localMode = env.KORTIX_LOCAL_IMAGES === 'true';
  const configured = env.KORTIX_VERSION || 'unknown';
  const { latest, latestResolved } = await fetchPublishedVersions(DEFAULT_API_IMAGE_REPO);

  // What you're actually running: a pinned semver is itself; `:latest` resolves
  // to whatever version that tag currently points to on Docker Hub.
  const running = isSemverTag(configured)
    ? configured
    : configured === 'latest'
      ? latestResolved ?? latest ?? 'latest'
      : configured;

  process.stdout.write(`\n  ${C.bold}kortix self-host version${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);
  if (localMode) {
    process.stdout.write(`  ${C.dim}running  ${C.reset}${C.cyan}current source${C.reset}${C.dim} (${LOCAL_SOURCE_TAG} images, not a released version)${C.reset}\n`);
  } else {
    const tagNote = configured === 'latest' ? `${C.dim} (tracking :latest)${C.reset}` : '';
    process.stdout.write(`  ${C.dim}running  ${C.reset}${C.cyan}${running}${C.reset}${tagNote}\n`);
  }
  process.stdout.write(`  ${C.dim}latest   ${C.reset}${latest ?? C.dim + 'unknown (offline?)' + C.reset}\n`);

  // Update hint: only meaningful for registry installs with a known latest.
  if (!localMode && latest) {
    if (isSemverTag(running) && compareSemver(running, latest) < 0) {
      process.stdout.write(`  ${C.yellow}update   ${C.reset}${running} ${C.dim}→${C.reset} ${C.green}${latest}${C.reset}${C.dim} available — run ${C.reset}${C.cyan}kortix self-host update${C.reset}\n`);
    } else if (isSemverTag(running)) {
      process.stdout.write(`  ${C.green}up to date${C.reset}\n`);
    }
  }

  process.stdout.write(`\n  ${C.dim}images${C.reset}\n`);
  process.stdout.write(`  ${C.dim}  api      ${C.reset}${env.API_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}  frontend ${C.reset}${env.FRONTEND_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}  gateway  ${C.reset}${env.GATEWAY_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}  sandbox  ${C.reset}${env.SANDBOX_IMAGE}\n\n`);
  process.stdout.write(`  ${C.dim}Update: ${C.reset}${C.cyan}kortix self-host update${C.reset}${C.dim} (latest) or ${C.reset}${C.cyan}--tag <version>${C.reset}\n\n`);
  return 0;
}

function composeCommand(flags: GlobalFlags, args: string[]): number {
  if (!existsSync(composePath(flags.instance))) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  return compose(flags.instance, args);
}

function selfHostOpen(flags: GlobalFlags): number {
  const env = loadEnv(flags.instance);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  openInBrowser(env.PUBLIC_URL);
  process.stdout.write(`${C.dim}${env.PUBLIC_URL}${C.reset}\n`);
  return 0;
}

function selfHostEnv(args: string[], flags: GlobalFlags): number {
  const action = args.shift() ?? 'ls';
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  if (action === 'ls' || action === 'list') {
    for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
      const hidden = key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN') || key.includes('PASSWORD');
      process.stdout.write(`${key}=${hidden && value ? `${value.slice(0, 8)}...` : value}\n`);
    }
    return 0;
  }
  if (action === 'set') {
    if (args.length === 0) {
      process.stderr.write(`${status.err('Pass KEY=VALUE pairs.')}\n`);
      return 2;
    }
    for (const pair of args) {
      const idx = pair.indexOf('=');
      if (idx <= 0) {
        process.stderr.write(`${status.err(`Invalid env assignment: ${pair}`)}\n`);
        return 2;
      }
      env[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    writeEnv(flags.instance, env);
    writeCompose(flags.instance);
    process.stdout.write(`${status.ok('Updated self-host environment')}\n`);
    return 0;
  }
  process.stderr.write(`${status.err(`unknown env subcommand "${action}"`)}\n`);
  return 2;
}

async function selfHostConfigure(flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  await configureIntegrations(env);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance);
  process.stdout.write(`${status.ok('Updated self-host integration config')}\n`);
  renderIntegrationSummary(env);
  return 0;
}

async function configureIntegrations(env: SelfHostEnv): Promise<void> {
  process.stdout.write(`\n  ${C.bold}Kortix self-host integrations${C.reset}\n`);
  process.stdout.write(`  ${C.dim}These power the agent runtime, GitHub repo access, and app connectors.${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Press enter to skip anything you do not use yet.${C.reset}\n\n`);

  // Sandbox runtime — where agents execute. Like Kortix Cloud, self-host runs
  // sandboxes on Daytona; the wizard just collects the API key.
  env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
  process.stdout.write(`  ${C.dim}Agent sandbox runtime: Daytona (https://app.daytona.io)${C.reset}\n`);
  env.DAYTONA_API_KEY = await promptSecret('Daytona API key', env.DAYTONA_API_KEY);
  env.DAYTONA_SERVER_URL = await prompt('Daytona server URL', env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api');
  env.DAYTONA_TARGET = await prompt('Daytona target/region', env.DAYTONA_TARGET || 'us');

  // Managed git (GitHub) — REQUIRED to create/CRUD projects: every project is a
  // git repo the server provisions. A PAT is the quickest path; a GitHub App is
  // the richer one. The API reads MANAGED_GIT_* (not KORTIX_GITHUB_* alone), so
  // we set both. "none" leaves projects unavailable.
  process.stdout.write(`  ${C.dim}GitHub (managed git) is required to create projects.${C.reset}\n`);
  const githubMode = await selectFrom('GitHub for projects: pat/app/none', ['pat', 'app', 'none'] as const, inferGithubMode(env) === 'none' ? 'pat' : inferGithubMode(env));
  if (githubMode === 'app') {
    env.KORTIX_GITHUB_APP_ID = await prompt('GitHub App ID', env.KORTIX_GITHUB_APP_ID);
    env.KORTIX_GITHUB_APP_SLUG = await prompt('GitHub App slug', env.KORTIX_GITHUB_APP_SLUG);
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = await promptSecret('GitHub App private key (paste with \\n escapes)', env.KORTIX_GITHUB_APP_PRIVATE_KEY);
    env.MANAGED_GIT_GITHUB_OWNER = await prompt('GitHub owner/org for project repos', env.MANAGED_GIT_GITHUB_OWNER || env.KORTIX_GITHUB_OWNER);
    env.MANAGED_GIT_GITHUB_INSTALL_ID = await prompt('GitHub App installation ID (on that org)', env.MANAGED_GIT_GITHUB_INSTALL_ID);
    env.KORTIX_GITHUB_OWNER = env.MANAGED_GIT_GITHUB_OWNER;
    env.MANAGED_GIT_PROVIDER = 'github';
    env.KORTIX_GITHUB_TOKEN = '';
    env.MANAGED_GIT_GITHUB_TOKEN = '';
  } else if (githubMode === 'pat') {
    env.KORTIX_GITHUB_TOKEN = await promptSecret('GitHub PAT (repo scope)', env.KORTIX_GITHUB_TOKEN);
    env.MANAGED_GIT_GITHUB_OWNER = await prompt('GitHub owner/org for project repos', env.MANAGED_GIT_GITHUB_OWNER || env.KORTIX_GITHUB_OWNER);
    // The managed-git backend reads MANAGED_GIT_GITHUB_*; mirror the PAT + owner.
    env.MANAGED_GIT_GITHUB_TOKEN = env.KORTIX_GITHUB_TOKEN;
    env.KORTIX_GITHUB_OWNER = env.MANAGED_GIT_GITHUB_OWNER;
    env.MANAGED_GIT_PROVIDER = 'github';
    env.KORTIX_GITHUB_APP_ID = '';
    env.KORTIX_GITHUB_APP_SLUG = '';
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = '';
    env.MANAGED_GIT_GITHUB_INSTALL_ID = '';
  } else {
    env.KORTIX_GITHUB_APP_ID = '';
    env.KORTIX_GITHUB_APP_SLUG = '';
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = '';
    env.KORTIX_GITHUB_TOKEN = '';
    env.MANAGED_GIT_PROVIDER = '';
    env.MANAGED_GIT_GITHUB_TOKEN = '';
    env.MANAGED_GIT_GITHUB_OWNER = '';
    env.MANAGED_GIT_GITHUB_INSTALL_ID = '';
  }

  const pdMode = await selectFrom('Pipedream connectors: skip/configure', ['skip', 'configure'] as const, pipedreamConfigured(env) ? 'configure' : 'skip');
  if (pdMode === 'configure') {
    env.INTEGRATION_AUTH_PROVIDER = 'pipedream';
    env.PIPEDREAM_CLIENT_ID = await prompt('Pipedream client ID', env.PIPEDREAM_CLIENT_ID);
    env.PIPEDREAM_CLIENT_SECRET = await promptSecret('Pipedream client secret', env.PIPEDREAM_CLIENT_SECRET);
    env.PIPEDREAM_PROJECT_ID = await prompt('Pipedream project ID', env.PIPEDREAM_PROJECT_ID);
    env.PIPEDREAM_ENVIRONMENT = await selectFrom('Pipedream environment', ['development', 'production'] as const, env.PIPEDREAM_ENVIRONMENT === 'development' ? 'development' : 'production');
    env.PIPEDREAM_WEBHOOK_SECRET = await promptSecret('Pipedream webhook secret (optional)', env.PIPEDREAM_WEBHOOK_SECRET);
  }
  env.KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED = 'true';
}

async function promptSecret(label: string, current: string): Promise<string> {
  const answer = await prompt(current ? `${label} (already set, enter to keep)` : label);
  return answer || current;
}

function inferGithubMode(env: SelfHostEnv): 'none' | 'app' | 'pat' {
  if (env.KORTIX_GITHUB_APP_ID || env.KORTIX_GITHUB_APP_PRIVATE_KEY || env.KORTIX_GITHUB_APP_SLUG) return 'app';
  if (env.KORTIX_GITHUB_TOKEN) return 'pat';
  return 'none';
}

function pipedreamConfigured(env: SelfHostEnv): boolean {
  return !!(env.PIPEDREAM_CLIENT_ID || env.PIPEDREAM_CLIENT_SECRET || env.PIPEDREAM_PROJECT_ID);
}

function sandboxProviders(env: SelfHostEnv): string[] {
  return (env.ALLOWED_SANDBOX_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** A provider is "ready" if daytona has an API key. */
function sandboxProviderConfigured(env: SelfHostEnv): boolean {
  const providers = sandboxProviders(env);
  if (providers.includes('daytona')) return !!env.DAYTONA_API_KEY;
  return false;
}

/** Managed git provider configured? Required to create/CRUD projects. */
function gitProviderConfigured(env: SelfHostEnv): boolean {
  if (env.MANAGED_GIT_PROVIDER !== 'github') return false;
  const pat = !!(env.MANAGED_GIT_GITHUB_TOKEN && env.MANAGED_GIT_GITHUB_OWNER);
  const app = !!(
    env.KORTIX_GITHUB_APP_ID &&
    env.KORTIX_GITHUB_APP_PRIVATE_KEY &&
    env.MANAGED_GIT_GITHUB_OWNER &&
    env.MANAGED_GIT_GITHUB_INSTALL_ID
  );
  return pat || app;
}

function integrationReviewNeeded(env: SelfHostEnv): boolean {
  // Both the sandbox runtime (the API won't boot without it) and managed git
  // (you can't create projects without it) are required, so a missing one always
  // warrants the wizard — even after a prior review.
  if (!sandboxProviderConfigured(env)) return true;
  if (!gitProviderConfigured(env)) return true;
  if (env.KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED === 'true') return false;
  return true;
}

function shouldPrompt(flags: GlobalFlags): boolean {
  return !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function renderIntegrationSummary(env: SelfHostEnv): void {
  const rows = [
    {
      name: `Agent sandbox runtime (${sandboxProviders(env).join(',') || 'none'})`,
      configured: sandboxProviderConfigured(env),
      hint: 'DAYTONA_API_KEY (via kortix self-host configure)',
    },
    {
      name: 'Managed git for projects (required)',
      configured: gitProviderConfigured(env),
      hint: 'connect GitHub (PAT or App) via kortix self-host configure',
    },
    {
      name: 'Pipedream connectors',
      configured: pipedreamConfigured(env),
      hint: 'PIPEDREAM_CLIENT_ID + PIPEDREAM_CLIENT_SECRET + PIPEDREAM_PROJECT_ID',
    },
  ];

  process.stdout.write(`  ${C.dim}Integrations${C.reset}\n`);
  for (const row of rows) {
    const marker = row.configured ? `${C.green}configured${C.reset}` : `${C.yellow}missing${C.reset}`;
    process.stdout.write(`  ${C.dim}- ${C.reset}${row.name}: ${marker}`);
    if (!row.configured) process.stdout.write(`${C.dim} (${row.hint})${C.reset}`);
    process.stdout.write('\n');
  }
  const missing = rows.filter((row) => !row.configured).length;
  if (missing > 0) {
    process.stdout.write(`  ${C.dim}Configure: ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} or ${C.reset}${C.cyan}kortix self-host env set KEY=VALUE${C.reset}\n`);
  }
  process.stdout.write('\n');
}

function shouldUseLocalSourceImages(flags: GlobalFlags): boolean {
  if (flags.registry) return false;
  if (flags.local) return true;
  return sourceRepoRoot() !== null;
}

function applyLocalSourceImages(env: SelfHostEnv): void {
  env.FRONTEND_IMAGE = `${DEFAULT_FRONTEND_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`;
  env.API_IMAGE = `${DEFAULT_API_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`;
  env.GATEWAY_IMAGE = `${DEFAULT_GATEWAY_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`;
  env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`;
  env.KORTIX_LOCAL_IMAGES = 'true';
}

function ensureLocalSourceImages(): void {
  const images = [
    `${DEFAULT_FRONTEND_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
    `${DEFAULT_API_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
    `${DEFAULT_GATEWAY_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
    `${DEFAULT_SANDBOX_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
  ];
  const missing = images.filter((image) => !dockerImageExists(image));
  if (missing.length === 0) return;

  const root = sourceRepoRoot();
  if (!root) {
    throw new Error(`local self-host images are missing: ${missing.join(', ')}`);
  }

  process.stdout.write(
    `${C.dim}  images   building current-source local images (${missing.join(', ')})${C.reset}\n`,
  );
  const result = spawnSync('bash', [join(root, 'scripts', 'build-local-images.sh'), '--tag', LOCAL_SOURCE_TAG], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error('failed to build current-source local images');
  }
}

function dockerImageExists(image: string): boolean {
  const result = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  return result.status === 0;
}

function sourceRepoRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '../../../..');
    if (
      existsSync(join(root, 'scripts', 'build-local-images.sh')) &&
      existsSync(join(root, 'apps', 'cli', 'src', 'index.ts'))
    ) {
      return root;
    }
  } catch {
    /* not a file-backed source checkout */
  }
  return null;
}

async function reconcilePorts(instance: string, env: SelfHostEnv): Promise<string[]> {
  if (composeHasRunningServices(instance)) return [];

  const changes: string[] = [];
  await ensurePort(env, 'FRONTEND_PORT', 'PUBLIC_URL', changes);
  await ensurePort(env, 'API_PORT', 'API_PUBLIC_URL', changes);
  await ensurePort(env, 'SUPABASE_PORT', 'SUPABASE_PUBLIC_URL', changes);
  await ensurePort(env, 'POSTGRES_PORT', undefined, changes);
  await ensurePort(env, 'POOLER_PORT', undefined, changes);

  if (changes.length > 0) {
    writeEnv(instance, env);
  }
  return changes;
}

async function ensurePort(
  env: SelfHostEnv,
  portKey: 'FRONTEND_PORT' | 'API_PORT' | 'SUPABASE_PORT' | 'POSTGRES_PORT' | 'POOLER_PORT',
  urlKey: 'PUBLIC_URL' | 'API_PUBLIC_URL' | 'SUPABASE_PUBLIC_URL' | undefined,
  changes: string[],
): Promise<void> {
  const current = Number(env[portKey]);
  if (!Number.isInteger(current) || current <= 0) return;
  if (await portAvailable(current)) return;

  const next = await findFreePort();
  env[portKey] = String(next);
  if (urlKey && isLocalhostUrlOnPort(env[urlKey], current)) {
    const url = new URL(env[urlKey]);
    url.port = String(next);
    env[urlKey] = url.toString().replace(/\/$/, '');
  }
  changes.push(`${portKey} ${current}->${next}`);
}

function composeHasRunningServices(instance: string): boolean {
  if (!existsSync(composePath(instance)) || !existsSync(envPath(instance))) return false;
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      composeProject(instance),
      '--env-file',
      envPath(instance),
      '-f',
      composePath(instance),
      'ps',
      '--services',
      '--filter',
      'status=running',
    ],
    { cwd: instanceDir(instance), encoding: 'utf8' },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

function isLocalhostUrlOnPort(value: string, port: number): boolean {
  try {
    const url = new URL(value);
    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return ['localhost', '127.0.0.1'].includes(url.hostname) && effectivePort === String(port);
  } catch {
    return false;
  }
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

function defaultEnv(flags: GlobalFlags): SelfHostEnv {
  const jwtSecret = token(64);
  return {
    KORTIX_VERSION: flags.tag,
    PUBLIC_URL: DEFAULT_PUBLIC_URL,
    API_PUBLIC_URL: DEFAULT_API_URL,
    SUPABASE_PUBLIC_URL: 'http://localhost:13740',
    FRONTEND_PORT: '13737',
    API_PORT: '13738',
    SUPABASE_PORT: '13740',
    POSTGRES_PORT: '13741',
    POOLER_PORT: '13742',
    SUPABASE_POSTGRES_INTERNAL_PORT: '5432',
    FRONTEND_IMAGE: `${DEFAULT_FRONTEND_IMAGE_REPO}:${flags.tag}`,
    API_IMAGE: `${DEFAULT_API_IMAGE_REPO}:${flags.tag}`,
    GATEWAY_IMAGE: `${DEFAULT_GATEWAY_IMAGE_REPO}:${flags.tag}`,
    SANDBOX_IMAGE: `${DEFAULT_SANDBOX_IMAGE_REPO}:${flags.tag}`,
    KORTIX_LOCAL_IMAGES: 'false',
    KORTIX_PUBLIC_AUTH_METHODS: 'password',
    GATEWAY_INTERNAL_TOKEN: token(32),
    OPENROUTER_API_KEY: '',
    POSTGRES_PASSWORD: token(32),
    SUPABASE_JWT_SECRET: jwtSecret,
    SUPABASE_ANON_KEY: supabaseJwt('anon', jwtSecret),
    SUPABASE_SERVICE_ROLE_KEY: supabaseJwt('service_role', jwtSecret),
    JWT_SECRET: jwtSecret,
    JWT_JWKS: '',
    ANON_KEY: supabaseJwt('anon', jwtSecret),
    SERVICE_ROLE_KEY: supabaseJwt('service_role', jwtSecret),
    ANON_KEY_ASYMMETRIC: '',
    SERVICE_ROLE_KEY_ASYMMETRIC: '',
    SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SECRET_KEY: '',
    POSTGRES_HOST: 'supabase-db',
    POSTGRES_DB: 'postgres',
    JWT_EXPIRY: '3600',
    API_EXTERNAL_URL: 'http://localhost:13740/auth/v1',
    SITE_URL: DEFAULT_PUBLIC_URL,
    ADDITIONAL_REDIRECT_URLS: '',
    DISABLE_SIGNUP: 'false',
    ENABLE_EMAIL_SIGNUP: 'true',
    ENABLE_EMAIL_AUTOCONFIRM: 'true',
    ENABLE_ANONYMOUS_USERS: 'false',
    ENABLE_PHONE_SIGNUP: 'false',
    ENABLE_PHONE_AUTOCONFIRM: 'false',
    SMTP_ADMIN_EMAIL: 'admin@localhost',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '587',
    SMTP_USER: 'unused',
    SMTP_PASS: 'unused',
    SMTP_SENDER_NAME: 'Kortix',
    MAILER_URLPATHS_INVITE: '/auth/v1/verify',
    MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
    MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
    MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
    DASHBOARD_USERNAME: 'kortix',
    DASHBOARD_PASSWORD: token(24),
    SECRET_KEY_BASE: token(48),
    REALTIME_DB_ENC_KEY: token(8),
    VAULT_ENC_KEY: token(16),
    PG_META_CRYPTO_KEY: token(24),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: token(24),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: token(24),
    S3_PROTOCOL_ACCESS_KEY_ID: token(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: token(32),
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_MAX_ROWS: '1000',
    PGRST_DB_EXTRA_SEARCH_PATH: 'public',
    POOLER_TENANT_ID: composeProject(flags.instance),
    POOLER_DEFAULT_POOL_SIZE: '20',
    POOLER_MAX_CLIENT_CONN: '100',
    POOLER_DB_POOL_SIZE: '5',
    STUDIO_DEFAULT_ORGANIZATION: 'Kortix',
    STUDIO_DEFAULT_PROJECT: flags.instance,
    OPENAI_API_KEY: '',
    FUNCTIONS_VERIFY_JWT: 'false',
    GLOBAL_S3_BUCKET: 'kortix-storage',
    STORAGE_TENANT_ID: composeProject(flags.instance),
    REGION: 'local',
    IMGPROXY_AUTO_WEBP: 'true',
    DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
    INTERNAL_SERVICE_KEY: token(32),
    API_KEY_SECRET: token(32),
    TUNNEL_SIGNING_SECRET: token(32),
    // Sandboxes run on a real provider, just like Kortix Cloud. Daytona is the
    // self-host sandbox provider; `kortix self-host configure` collects the API key.
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    DAYTONA_API_KEY: '',
    DAYTONA_SERVER_URL: 'https://app.daytona.io/api',
    DAYTONA_TARGET: 'us',
    KORTIX_GITHUB_APP_ID: '',
    KORTIX_GITHUB_APP_PRIVATE_KEY: '',
    KORTIX_GITHUB_APP_SLUG: '',
    KORTIX_GITHUB_TOKEN: '',
    KORTIX_GITHUB_OWNER: '',
    MANAGED_GIT_PROVIDER: 'github',
    MANAGED_GIT_GITHUB_TOKEN: '',
    MANAGED_GIT_GITHUB_OWNER: '',
    MANAGED_GIT_GITHUB_INSTALL_ID: '',
    INTEGRATION_AUTH_PROVIDER: 'pipedream',
    KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED: 'false',
    PIPEDREAM_CLIENT_ID: '',
    PIPEDREAM_CLIENT_SECRET: '',
    PIPEDREAM_PROJECT_ID: '',
    PIPEDREAM_ENVIRONMENT: 'production',
    PIPEDREAM_WEBHOOK_SECRET: '',
  };
}

function writeCompose(instance: string): void {
  const root = instanceDir(instance);
  writeSupabaseVendorAssets(root);
  writeFileSync(
    composePath(instance),
    renderFullDockerCompose(composeProject(instance)),
    { encoding: 'utf8', mode: 0o600 },
  );
}
function loadEnv(instance: string): SelfHostEnv | null {
  const path = envPath(instance);
  if (!existsSync(path)) return null;
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out as SelfHostEnv;
}

function loadEnvWithDefaults(flags: GlobalFlags): SelfHostEnv | null {
  const existing = loadEnv(flags.instance);
  if (!existing) return null;
  const env = { ...defaultEnv(flags), ...existing };
  normalizeFullSupabaseEnv(flags.instance, env);
  return env;
}

function writeEnv(instance: string, env: SelfHostEnv): void {
  normalizeFullSupabaseEnv(instance, env);
  mkdirSync(instanceDir(instance), { recursive: true });
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  writeFileSync(envPath(instance), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeFullSupabaseEnv(instance: string, env: SelfHostEnv): void {
  // The official Supabase distribution uses the unprefixed names. Keep the
  // historical Kortix variables canonical and derive upstream aliases so an
  // existing .env upgrades without rotating its JWT or API keys.
  env.JWT_SECRET = env.SUPABASE_JWT_SECRET;
  env.ANON_KEY = env.SUPABASE_ANON_KEY;
  env.SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  env.POSTGRES_HOST = 'supabase-db';
  env.POSTGRES_DB = 'postgres';
  env.SUPABASE_POSTGRES_INTERNAL_PORT = '5432';
  env.API_EXTERNAL_URL = `${env.SUPABASE_PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;
  env.SITE_URL = env.PUBLIC_URL;
  env.POOLER_TENANT_ID ||= composeProject(instance);
  env.STORAGE_TENANT_ID ||= composeProject(instance);
  env.STUDIO_DEFAULT_PROJECT ||= instance;
}

function compose(instance: string, args: string[]): number {
  const result = spawnSync('docker', ['compose', '--project-name', composeProject(instance), '--env-file', envPath(instance), '-f', composePath(instance), ...args], {
    cwd: instanceDir(instance),
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`${status.err(result.error.message)}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function registerLocalHost(name: string, apiUrl: string): void {
  const existing = getHost(name);
  const sameHost = existing?.url === apiUrl;
  const host: Host = {
    url: apiUrl,
    token: sameHost ? existing?.token ?? '' : '',
    user_id: sameHost ? existing?.user_id ?? '' : '',
    user_email: sameHost ? existing?.user_email ?? '' : '',
    account_id: sameHost ? existing?.account_id ?? '' : '',
    logged_in_at: sameHost ? existing?.logged_in_at ?? new Date().toISOString() : new Date().toISOString(),
  };
  upsertHost(name, host, true);
}

function instanceDir(instance: string): string {
  return targetInstanceDir(instance);
}

function envPath(instance: string): string {
  return join(instanceDir(instance), '.env');
}

function composePath(instance: string): string {
  return join(instanceDir(instance), 'docker-compose.yml');
}

function composeProject(instance: string): string {
  return `kortix-${instance}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function token(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function supabaseJwt(role: string, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ role, iss: 'supabase', iat: 1641024000, exp: 2114380800 }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
