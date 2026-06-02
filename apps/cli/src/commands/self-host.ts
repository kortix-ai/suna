import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { getHost, upsertHost, type Host } from '../api/config.ts';
import { prompt, selectFrom } from '../prompts.ts';
import { C, status } from '../style.ts';

const DEFAULT_INSTANCE = 'default';
const DEFAULT_TAG = 'latest';
const DEFAULT_HOST_NAME = 'selfhost';
const DEFAULT_PUBLIC_URL = 'http://localhost:13737';
const DEFAULT_API_URL = 'http://localhost:13738';
const DEFAULT_FRONTEND_IMAGE_REPO = 'kortix/kortix-frontend';
const DEFAULT_API_IMAGE_REPO = 'kortix/kortix-api';
const DEFAULT_SANDBOX_IMAGE_REPO = 'kortix/kortix-sandbox';
const LOCAL_SOURCE_TAG = 'selfhost-local';

const HELP = `Usage: kortix self-host <subcommand> [options]

Run your own Kortix Cloud locally or on your infrastructure using the
published Docker images from Docker Hub.

Subcommands:
  init                 Create self-host config with production defaults.
  start                Pull images and start your self-hosted Kortix.
  stop                 Stop the stack.
  restart              Restart the stack.
  status               Show Docker Compose service status.
  logs [service]       Tail logs.
  open                 Open the local dashboard.
  configure            Guided integration config (Freestyle, GitHub, Pipedream).
  env ls              Show persistent environment values.
  env set KEY=VALUE    Update persistent environment values.

Options:
  --instance <name>    Instance name (default: ${DEFAULT_INSTANCE}).
  --tag <tag>          Docker image tag (default: ${DEFAULT_TAG}).
  --local              Use current-source local images instead of registry images.
  --registry           Force registry images even when running from a source checkout.
  --yes                Accept defaults in non-interactive flows.
  -h, --help           Show this help.

Examples:
  kortix self-host init
  kortix self-host start
  kortix self-host env set PUBLIC_URL=https://kortix.example.com API_PUBLIC_URL=https://api.example.com
  kortix hosts ls
`;

interface GlobalFlags {
  instance: string;
  tag: string;
  yes: boolean;
  local: boolean;
  registry: boolean;
}

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
  SANDBOX_IMAGE: string;
  KORTIX_LOCAL_IMAGES: string;
  POSTGRES_PASSWORD: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INTERNAL_SERVICE_KEY: string;
  API_KEY_SECRET: string;
  TUNNEL_SIGNING_SECRET: string;
  SANDBOX_CONTAINER_NAME: string;
  SANDBOX_PORT_BASE: string;
  KORTIX_GITHUB_APP_ID: string;
  KORTIX_GITHUB_APP_PRIVATE_KEY: string;
  KORTIX_GITHUB_APP_SLUG: string;
  KORTIX_GITHUB_TOKEN: string;
  KORTIX_GITHUB_OWNER: string;
  FREESTYLE_API_KEY: string;
  FREESTYLE_API_URL: string;
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

  switch (sub) {
    case 'init':
    case 'setup':
      return selfHostInit(flags);
    case 'start':
    case 'up':
      return selfHostStart(flags);
    case 'stop':
    case 'down':
      return composeCommand(flags, ['down']);
    case 'restart':
      return selfHostRestart(flags);
    case 'status':
    case 'ps':
      return composeCommand(flags, ['ps']);
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
  const instance = takeFlagValue(args, ['--instance']) ?? DEFAULT_INSTANCE;
  const tag = takeFlagValue(args, ['--tag', '--version']) ?? DEFAULT_TAG;
  if (local && registry) {
    throw new Error('use either --local or --registry, not both');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(instance)) {
    throw new Error('instance must start with a letter and contain only letters, digits, dots, underscores, or dashes');
  }
  return { instance, tag, yes, local, registry };
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
  if (!existing || existing.SANDBOX_IMAGE === `${DEFAULT_SANDBOX_IMAGE_REPO}:${existing.KORTIX_VERSION}`) {
    env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${flags.tag}`;
  }

  if (!existing && shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env);
  }

  writeEnv(flags.instance, env);
  writeDbInit(flags.instance, env);
  writeKongConfig(flags.instance);
  writeCompose(flags.instance, env);
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
  writeDbInit(flags.instance, env);
  writeKongConfig(flags.instance);
  writeCompose(flags.instance, env);

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
    writeDbInit(flags.instance, env);
    writeKongConfig(flags.instance);
    writeCompose(flags.instance, env);
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
  writeDbInit(flags.instance, env);
  writeKongConfig(flags.instance);
  writeCompose(flags.instance, env);
  process.stdout.write(`${status.ok('Updated self-host integration config')}\n`);
  renderIntegrationSummary(env);
  return 0;
}

async function configureIntegrations(env: SelfHostEnv): Promise<void> {
  process.stdout.write(`\n  ${C.bold}Kortix self-host integrations${C.reset}\n`);
  process.stdout.write(`  ${C.dim}These power app deployments, GitHub repo access, and app connectors.${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Press enter to skip anything you do not use yet.${C.reset}\n\n`);

  const freestyleMode = await selectFrom('App deployments (Freestyle): skip/configure', ['skip', 'configure'] as const, freestyleConfigured(env) ? 'configure' : 'skip');
  if (freestyleMode === 'configure') {
    env.FREESTYLE_API_KEY = await promptSecret('Freestyle API key', env.FREESTYLE_API_KEY);
    env.FREESTYLE_API_URL = await prompt('Freestyle API URL', env.FREESTYLE_API_URL || 'https://api.freestyle.sh');
  }

  const githubMode = await selectFrom('GitHub integration: none/app/pat', ['none', 'app', 'pat'] as const, inferGithubMode(env));
  if (githubMode === 'app') {
    env.KORTIX_GITHUB_APP_ID = await prompt('GitHub App ID', env.KORTIX_GITHUB_APP_ID);
    env.KORTIX_GITHUB_APP_SLUG = await prompt('GitHub App slug', env.KORTIX_GITHUB_APP_SLUG);
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = await promptSecret('GitHub App private key (paste with \\n escapes)', env.KORTIX_GITHUB_APP_PRIVATE_KEY);
    env.KORTIX_GITHUB_TOKEN = '';
  } else if (githubMode === 'pat') {
    env.KORTIX_GITHUB_TOKEN = await promptSecret('GitHub PAT (repo scope)', env.KORTIX_GITHUB_TOKEN);
    env.KORTIX_GITHUB_OWNER = await prompt('Default GitHub owner/org', env.KORTIX_GITHUB_OWNER);
    env.KORTIX_GITHUB_APP_ID = '';
    env.KORTIX_GITHUB_APP_SLUG = '';
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = '';
  } else {
    env.KORTIX_GITHUB_APP_ID = '';
    env.KORTIX_GITHUB_APP_SLUG = '';
    env.KORTIX_GITHUB_APP_PRIVATE_KEY = '';
    env.KORTIX_GITHUB_TOKEN = '';
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

function freestyleConfigured(env: SelfHostEnv): boolean {
  return !!env.FREESTYLE_API_KEY;
}

function integrationReviewNeeded(env: SelfHostEnv): boolean {
  if (env.KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED === 'true') return false;
  return !(freestyleConfigured(env) && inferGithubMode(env) !== 'none' && pipedreamConfigured(env));
}

function shouldPrompt(flags: GlobalFlags): boolean {
  return !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function renderIntegrationSummary(env: SelfHostEnv): void {
  const rows = [
    {
      name: 'App deployments',
      configured: freestyleConfigured(env),
      hint: 'FREESTYLE_API_KEY',
    },
    {
      name: 'GitHub App',
      configured: inferGithubMode(env) === 'app',
      hint: 'KORTIX_GITHUB_APP_ID + KORTIX_GITHUB_APP_PRIVATE_KEY + KORTIX_GITHUB_APP_SLUG',
    },
    {
      name: 'GitHub PAT fallback',
      configured: inferGithubMode(env) === 'pat',
      hint: 'KORTIX_GITHUB_TOKEN + KORTIX_GITHUB_OWNER',
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
  env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`;
  env.KORTIX_LOCAL_IMAGES = 'true';
}

function ensureLocalSourceImages(): void {
  const images = [
    `${DEFAULT_FRONTEND_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
    `${DEFAULT_API_IMAGE_REPO}:${LOCAL_SOURCE_TAG}`,
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

  if (changes.length > 0) {
    writeEnv(instance, env);
  }
  return changes;
}

async function ensurePort(
  env: SelfHostEnv,
  portKey: 'FRONTEND_PORT' | 'API_PORT' | 'SUPABASE_PORT' | 'POSTGRES_PORT',
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
    FRONTEND_IMAGE: `${DEFAULT_FRONTEND_IMAGE_REPO}:${flags.tag}`,
    API_IMAGE: `${DEFAULT_API_IMAGE_REPO}:${flags.tag}`,
    SANDBOX_IMAGE: `${DEFAULT_SANDBOX_IMAGE_REPO}:${flags.tag}`,
    KORTIX_LOCAL_IMAGES: 'false',
    POSTGRES_PASSWORD: token(32),
    SUPABASE_JWT_SECRET: jwtSecret,
    SUPABASE_ANON_KEY: supabaseJwt('anon', jwtSecret),
    SUPABASE_SERVICE_ROLE_KEY: supabaseJwt('service_role', jwtSecret),
    INTERNAL_SERVICE_KEY: token(32),
    API_KEY_SECRET: token(32),
    TUNNEL_SIGNING_SECRET: token(32),
    SANDBOX_CONTAINER_NAME: `kortix-${flags.instance}-sandbox`,
    SANDBOX_PORT_BASE: '15000',
    KORTIX_GITHUB_APP_ID: '',
    KORTIX_GITHUB_APP_PRIVATE_KEY: '',
    KORTIX_GITHUB_APP_SLUG: '',
    KORTIX_GITHUB_TOKEN: '',
    KORTIX_GITHUB_OWNER: '',
    FREESTYLE_API_KEY: '',
    FREESTYLE_API_URL: 'https://api.freestyle.sh',
    INTEGRATION_AUTH_PROVIDER: 'pipedream',
    KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED: 'false',
    PIPEDREAM_CLIENT_ID: '',
    PIPEDREAM_CLIENT_SECRET: '',
    PIPEDREAM_PROJECT_ID: '',
    PIPEDREAM_ENVIRONMENT: 'production',
    PIPEDREAM_WEBHOOK_SECRET: '',
  };
}

function writeCompose(instance: string, env: SelfHostEnv): void {
  const project = composeProject(instance);
  const text = `services:
  supabase-db:
    image: supabase/postgres:15.8.1.085
    ports:
      - "127.0.0.1:\${POSTGRES_PORT}:5432"
    volumes:
      - supabase-db-data:/var/lib/postgresql/data
      - ./volumes/db/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro
      - ./volumes/db/kortix.sql:/docker-entrypoint-initdb.d/init-scripts/99-kortix.sql:ro
    environment:
      POSTGRES_HOST: /var/run/postgresql
      POSTGRES_PORT: "5432"
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      JWT_SECRET: \${SUPABASE_JWT_SECRET}
      JWT_EXP: "3600"
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
      - -c
      - log_min_messages=fatal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -h localhost"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  supabase-auth:
    image: supabase/gotrue:v2.186.0
    depends_on:
      supabase-db:
        condition: service_healthy
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: "9999"
      API_EXTERNAL_URL: \${SUPABASE_PUBLIC_URL}
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres
      GOTRUE_SITE_URL: \${PUBLIC_URL}
      GOTRUE_URI_ALLOW_LIST: ""
      GOTRUE_DISABLE_SIGNUP: "false"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: "3600"
      GOTRUE_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"
      GOTRUE_MAILER_AUTOCONFIRM: "true"
      GOTRUE_SMTP_ADMIN_EMAIL: admin@localhost
      GOTRUE_SMTP_HOST: localhost
      GOTRUE_SMTP_PORT: "587"
      GOTRUE_SMTP_USER: unused
      GOTRUE_SMTP_PASS: unused
      GOTRUE_SMTP_SENDER_NAME: Kortix
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
    restart: unless-stopped

  supabase-rest:
    image: postgrest/postgrest:v14.5
    depends_on:
      supabase-db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: postgres://authenticator:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"
      PGRST_APP_SETTINGS_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      PGRST_APP_SETTINGS_JWT_EXP: "3600"
    command: ["postgrest"]
    restart: unless-stopped

  supabase-kong:
    image: kong:2.8.1
    ports:
      - "127.0.0.1:\${SUPABASE_PORT}:8000"
    volumes:
      - ./kong.yml:/home/kong/temp.yml:ro
    depends_on:
      supabase-auth:
        condition: service_started
      supabase-rest:
        condition: service_started
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /home/kong/kong.yml
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_PLUGINS: request-transformer,cors,key-auth,acl,basic-auth
      SUPABASE_ANON_KEY: \${SUPABASE_ANON_KEY}
      SUPABASE_SERVICE_KEY: \${SUPABASE_SERVICE_ROLE_KEY}
    entrypoint: bash -c 'eval "echo \\"$$(cat ~/temp.yml)\\"" > ~/kong.yml && /docker-entrypoint.sh kong docker-start'
    restart: unless-stopped

  frontend:
    image: \${FRONTEND_IMAGE}
    ports:
      - "127.0.0.1:\${FRONTEND_PORT}:3000"
    extra_hosts:
      - "localhost:host-gateway"
    environment:
      KORTIX_PUBLIC_SUPABASE_URL: \${SUPABASE_PUBLIC_URL}
      KORTIX_PUBLIC_SUPABASE_ANON_KEY: \${SUPABASE_ANON_KEY}
      KORTIX_PUBLIC_BACKEND_URL: \${API_PUBLIC_URL}/v1
      KORTIX_PUBLIC_BILLING_ENABLED: "false"
      KORTIX_PUBLIC_APP_URL: \${PUBLIC_URL}
      SUPABASE_URL: \${SUPABASE_PUBLIC_URL}
      SUPABASE_SERVER_URL: http://supabase-kong:8000
      SUPABASE_ANON_KEY: \${SUPABASE_ANON_KEY}
      BACKEND_URL: \${API_PUBLIC_URL}/v1
    depends_on:
      kortix-api:
        condition: service_started
    restart: unless-stopped

  kortix-api:
    image: \${API_IMAGE}
    user: "0:0"
    ports:
      - "127.0.0.1:\${API_PORT}:8008"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - .env
    environment:
      PORT: "8008"
      SUPABASE_URL: http://supabase-kong:8000
      DATABASE_URL: postgresql://postgres:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres
      SUPABASE_SERVICE_ROLE_KEY: \${SUPABASE_SERVICE_ROLE_KEY}
      ALLOWED_SANDBOX_PROVIDERS: local_docker
      DOCKER_HOST: unix:///var/run/docker.sock
      KORTIX_URL: http://kortix-api:8008
      FRONTEND_URL: \${PUBLIC_URL}
      CORS_ALLOWED_ORIGINS: \${PUBLIC_URL},\${API_PUBLIC_URL}
      SANDBOX_IMAGE: \${SANDBOX_IMAGE}
      SANDBOX_NETWORK: ${project}_default
      KORTIX_LOCAL_DOCKER_HOST: host.docker.internal
      KORTIX_LOCAL_IMAGES: \${KORTIX_LOCAL_IMAGES}
      KORTIX_ROUTER_INTERNAL_ENABLED: "false"
      KORTIX_BILLING_INTERNAL_ENABLED: "false"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      supabase-db:
        condition: service_healthy
      supabase-kong:
        condition: service_started
    restart: unless-stopped

volumes:
  supabase-db-data:
`;
  writeFileSync(composePath(instance), text, 'utf8');
}

function writeDbInit(instance: string, env: SelfHostEnv): void {
  const dbDir = join(instanceDir(instance), 'volumes', 'db');
  mkdirSync(dbDir, { recursive: true });

  const roles = `-- Supabase roles required by GoTrue and PostgREST
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN NOINHERIT CREATEROLE CREATEDB REPLICATION BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;
GRANT supabase_auth_admin TO authenticator;
GRANT supabase_admin TO postgres;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO postgres;
ALTER ROLE supabase_auth_admin SET search_path = 'auth';

ALTER ROLE supabase_auth_admin WITH PASSWORD '${sqlString(env.POSTGRES_PASSWORD)}';
ALTER ROLE authenticator WITH PASSWORD '${sqlString(env.POSTGRES_PASSWORD)}';
ALTER ROLE supabase_admin WITH PASSWORD '${sqlString(env.POSTGRES_PASSWORD)}';
`;

  const kortix = `-- Kortix bootstrap: extensions and schemas
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE SCHEMA IF NOT EXISTS kortix;
CREATE SCHEMA IF NOT EXISTS basejump;
`;

  writeFileSync(join(dbDir, 'roles.sql'), roles, 'utf8');
  writeFileSync(join(dbDir, 'kortix.sql'), kortix, 'utf8');
}

function writeKongConfig(instance: string): void {
  const text = `_format_version: '2.1'
_transform: true

consumers:
  - username: anon
    keyauth_credentials:
      - key: $SUPABASE_ANON_KEY
  - username: service_role
    keyauth_credentials:
      - key: $SUPABASE_SERVICE_KEY

acls:
  - consumer: anon
    group: anon
  - consumer: service_role
    group: admin

services:
  - name: auth-v1-open
    url: http://supabase-auth:9999/verify
    routes:
      - name: auth-v1-open
        strip_path: true
        paths:
          - /auth/v1/verify
    plugins:
      - name: cors
  - name: auth-v1-open-callback
    url: http://supabase-auth:9999/callback
    routes:
      - name: auth-v1-open-callback
        strip_path: true
        paths:
          - /auth/v1/callback
    plugins:
      - name: cors
  - name: auth-v1-open-authorize
    url: http://supabase-auth:9999/authorize
    routes:
      - name: auth-v1-open-authorize
        strip_path: true
        paths:
          - /auth/v1/authorize
    plugins:
      - name: cors
  - name: auth-v1
    url: http://supabase-auth:9999/
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
  - name: rest-v1
    url: http://supabase-rest:3000/
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
`;
  mkdirSync(instanceDir(instance), { recursive: true });
  writeFileSync(join(instanceDir(instance), 'kong.yml'), text, 'utf8');
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
  return { ...defaultEnv(flags), ...existing };
}

function writeEnv(instance: string, env: SelfHostEnv): void {
  mkdirSync(instanceDir(instance), { recursive: true });
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  writeFileSync(envPath(instance), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
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
  return resolve(homedir(), '.config', 'kortix', 'self-host', instance);
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

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
