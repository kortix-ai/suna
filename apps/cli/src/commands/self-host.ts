import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { getHost, upsertHost, type Host } from '../api/config.ts';
import { prompt, selectFrom } from '../prompts.ts';
import { C, help, status } from '../style.ts';
import {
  instanceDir as configInstanceDir,
  loadInstanceConfig,
  writeInstanceConfig,
} from '../self-host/config.ts';
import type { SelfHostCommandFlags } from '../self-host/types.ts';
import { renderFullDockerCompose, writeKortixRuntimeAssets, writeSupabaseVendorAssets } from '../self-host/compose-assets.ts';
import { SHARED_SELF_HOST_DEFAULTS } from '../self-host/shared-runtime-defaults.ts';

const DEFAULT_INSTANCE = 'default';
const CHANNELS = ['stable', 'latest'] as const;
type Channel = (typeof CHANNELS)[number];
const DEFAULT_CHANNEL: Channel = 'stable';
const DEFAULT_AUTO_UPDATE = 'true';
const DEFAULT_UPDATE_INTERVAL_SECONDS = '86400'; // daily
const DEFAULT_HOST_NAME = 'selfhost';
const DEFAULT_PUBLIC_URL = 'http://localhost:13737';
const DEFAULT_API_URL = 'http://localhost:13738';
const DEFAULT_FRONTEND_IMAGE_REPO = 'kortix/kortix-frontend';
const DEFAULT_API_IMAGE_REPO = 'kortix/kortix-api';
const DEFAULT_GATEWAY_IMAGE_REPO = 'kortix/kortix-gateway';
const DEFAULT_SANDBOX_IMAGE_REPO = 'kortix/kortix-sandbox';

const HELP = help`Usage: kortix self-host <subcommand> [options]

Run Kortix on your own infrastructure: one generic Docker Compose stack that
runs identically on a laptop, any VPS, or a cloud box. There is no separate
"target" to pick — ${C.cyan}kortix self-host init${C.reset} generates a
docker-compose.yml + .env, and ${C.cyan}start${C.reset} runs it.

Subcommands:
  init                 Create or refresh this instance's Compose + env config.
  start                Pull images and start your self-hosted Kortix.
  update               Pull the configured channel's images now and apply them.
  reconcile            Same as update — check and converge to the configured
                       channel/version.
  version              Show the running version and image tags.
  stop                 Stop the stack.
  restart              Restart the stack.
  status               Show container status.
  doctor               Validate local Docker tooling and the Compose config.
  logs [service]       Tail logs.
  open                 Open the dashboard in a browser.
  configure            Interactively configure integrations and update policy.
  env ls              Show persistent environment values.
  env set KEY=VALUE    Update persistent environment values.

Options:
  --instance <name>    Instance name (default: ${DEFAULT_INSTANCE}).
  --tag <tag>          Pin an explicit image tag / version (for example 0.9.84).
  --release <version>  Alias for --tag.
  --channel <name>     Which moving tag to track when no explicit --tag is
                       given: stable or latest (default: stable). The
                       auto-updater tracks whichever channel is configured.
  --auto-update <on|off> Enable/disable the in-compose auto-updater (default: on).
  --update-interval <seconds> How often the auto-updater checks for new
                       images (default: 86400, i.e. daily).
  --json               Emit machine-readable output where supported.
  --yes                Accept defaults in non-interactive flows.
  -h, --help           Show this help.

Public domain + TLS (optional): set KORTIX_DOMAIN (and optionally
KORTIX_API_DOMAIN, default api.<KORTIX_DOMAIN>) via
${C.cyan}kortix self-host env set${C.reset} to turn on the bundled Caddy
reverse proxy, which terminates TLS via ACME HTTP-01 on ports 80/443. Leave it
unset for the default loopback-port laptop setup.

Examples:
  kortix self-host init
  kortix self-host start
  kortix self-host update                        # pull + apply the stable channel
  kortix self-host update --tag 0.9.72            # pin to a specific version
  kortix self-host update --channel latest        # track :latest instead
  kortix self-host version
  kortix self-host env set KORTIX_DOMAIN=kortix.example.com
  kortix self-host env set PUBLIC_URL=https://kortix.example.com API_PUBLIC_URL=https://api.example.com
  kortix hosts ls
`;

type GlobalFlags = SelfHostCommandFlags;

interface SelfHostEnv {
  KORTIX_VERSION: string;
  KORTIX_CHANNEL: string;
  KORTIX_AUTO_UPDATE: string;
  KORTIX_UPDATE_INTERVAL: string;
  KORTIX_DOMAIN: string;
  KORTIX_API_DOMAIN: string;
  KORTIX_ACME_EMAIL: string;
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
  // KORTIX_PUBLIC_AUTH_METHODS, ALLOWED_SANDBOX_PROVIDERS, DAYTONA_SERVER_URL,
  // and DAYTONA_TARGET are covered by the [key: string] index signature below —
  // their defaults come from the SHARED_SELF_HOST_DEFAULTS spread in
  // defaultEnv(), not a literal here, so TS can't see them as named properties.
  GATEWAY_INTERNAL_TOKEN: string;
  OPENROUTER_API_KEY: string;
  POSTGRES_PASSWORD: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INTERNAL_SERVICE_KEY: string;
  API_KEY_SECRET: string;
  TUNNEL_SIGNING_SECRET: string;
  DAYTONA_API_KEY: string;
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

  switch (sub) {
    case 'init':
    case 'setup':
      return selfHostInit(flags);
    case 'plan':
      return selfHostPlan(flags);
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
      return selfHostRollback(flags);
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
      return selfHostDoctor(flags);
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
  const json = takeFlagBool(args, ['--json']);
  const instance = takeFlagValue(args, ['--instance']) ?? DEFAULT_INSTANCE;
  const release = takeFlagValue(args, ['--release']);
  const tag = takeFlagValue(args, ['--tag', '--version']);
  const channelRaw = takeFlagValue(args, ['--channel']);
  const autoUpdateRaw = takeFlagValue(args, ['--auto-update']);
  const updateInterval = takeFlagValue(args, ['--update-interval']);
  if (channelRaw !== undefined && !isChannel(channelRaw)) {
    throw new Error(`--channel must be "stable" or "latest", got "${channelRaw}"`);
  }
  if (autoUpdateRaw !== undefined && autoUpdateRaw !== 'on' && autoUpdateRaw !== 'off') {
    throw new Error(`--auto-update must be "on" or "off", got "${autoUpdateRaw}"`);
  }
  if (updateInterval !== undefined && (!/^\d+$/.test(updateInterval) || Number(updateInterval) <= 0)) {
    throw new Error('--update-interval must be a positive number of seconds');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(instance)) {
    throw new Error('instance must start with a letter and contain only letters, digits, dots, underscores, or dashes');
  }
  return {
    instance,
    tag: tag ?? release,
    release,
    channel: channelRaw as Channel | undefined,
    autoUpdate: autoUpdateRaw === undefined ? undefined : autoUpdateRaw === 'on',
    updateInterval,
    yes,
    json,
  };
}

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

async function selfHostInit(flags: GlobalFlags): Promise<number> {
  const dir = instanceDir(flags.instance);
  mkdirSync(dir, { recursive: true });

  const existing = loadEnv(flags.instance);
  const env = { ...defaultEnv(flags), ...(existing ?? {}) };

  applyChannelAndUpdatePolicy(env, flags);
  applyImagesForTag(env, resolveTag(flags, existing));

  if (shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env);
  }

  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  const existingConfig = loadInstanceConfig(flags.instance);
  writeInstanceConfig({
    schema_version: 1,
    instance: flags.instance,
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
  process.stdout.write(`  ${C.dim}Images    ${C.reset}${env.FRONTEND_IMAGE}, ${env.API_IMAGE}, ${env.SANDBOX_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}Channel   ${C.reset}${env.KORTIX_CHANNEL}${C.dim} (auto-update: ${env.KORTIX_AUTO_UPDATE === 'true' ? 'on' : 'off'}, every ${env.KORTIX_UPDATE_INTERVAL}s)${C.reset}\n\n`);
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
  const portChanges = await reconcilePorts(flags.instance, env);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);

  process.stdout.write(`\n  ${C.bold}kortix self-host start${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);
  process.stdout.write(`  ${C.dim}images   ${C.reset}${env.FRONTEND_IMAGE}, ${env.API_IMAGE}\n`);
  process.stdout.write(`  ${C.dim}api      ${C.reset}${env.API_PUBLIC_URL}\n\n`);
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

  const pull = compose(flags.instance, ['pull']);
  if (pull !== 0) return pull;
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

function selfHostPlan(flags: GlobalFlags): number {
  if (!existsSync(composePath(flags.instance)) || !existsSync(envPath(flags.instance))) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  const code = compose(flags.instance, ['config', '--quiet']);
  if (code !== 0) return code;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      instance: flags.instance,
      valid: true,
      compose_file: composePath(flags.instance),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${status.ok(`Docker Compose plan is valid for ${flags.instance}`)}\n`);
    process.stdout.write(`${C.dim}No changes were applied.${C.reset}\n`);
  }
  return 0;
}

function selfHostRollback(flags: GlobalFlags): Promise<number> | number {
  const release = flags.release ?? flags.tag;
  if (!release) {
    process.stderr.write(
      `${status.err('Rollback requires an explicit --release <version> or --tag <version>.')}\n`,
    );
    return 2;
  }
  return selfHostUpdate({ ...flags, tag: release });
}

function selfHostDoctor(flags: GlobalFlags): number {
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
    process.stdout.write(`${JSON.stringify({ instance: flags.instance, ok, checks }, null, 2)}\n`);
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
 * Update an existing instance: point the image tags at the requested
 * version/channel (default: whatever channel is already configured, i.e. the
 * "stable" moving tag unless the operator switched channels or pinned an
 * explicit version), then down→start. `start` re-pulls the tags and the
 * kortix-migrate one-shot applies any new migrations before the API serves
 * traffic. The Postgres volume is preserved across the restart, so this is a
 * true in-place upgrade. This is exactly what the in-compose auto-updater does
 * on its own schedule — `update`/`reconcile` just runs it once, right now.
 */
async function selfHostUpdate(flags: GlobalFlags): Promise<number> {
  if (!existsSync(envPath(flags.instance)) || !existsSync(composePath(flags.instance))) {
    // Nothing to update yet — behave like a first start.
    return selfHostStart(flags);
  }

  const env = loadEnvWithDefaults(flags)!;
  const oldVersion = env.KORTIX_VERSION || 'unknown';

  process.stdout.write(`\n  ${C.bold}kortix self-host update${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);

  applyChannelAndUpdatePolicy(env, flags);
  applyImagesForTag(env, resolveTag(flags, env));
  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);

  process.stdout.write(`  ${C.dim}version  ${C.reset}${oldVersion} ${C.dim}→${C.reset} ${C.cyan}${env.KORTIX_VERSION}${C.reset}\n\n`);
  // down keeps the named Postgres volume; start re-pulls + migrates + recreates.
  return selfHostRestart(flags);
}

/** Resolve the image tag to apply: an explicit pin wins, else the channel. */
function resolveTag(flags: GlobalFlags, existing: SelfHostEnv | null): string {
  return flags.tag ?? flags.release ?? flags.channel ?? existing?.KORTIX_CHANNEL ?? DEFAULT_CHANNEL;
}

/** Apply KORTIX_CHANNEL / auto-update policy flags onto env, defaults preserved. */
function applyChannelAndUpdatePolicy(env: SelfHostEnv, flags: GlobalFlags): void {
  const tag = resolveTag(flags, env);
  if (flags.channel) {
    env.KORTIX_CHANNEL = flags.channel;
  } else if (isChannel(tag)) {
    env.KORTIX_CHANNEL = tag;
  }
  env.KORTIX_CHANNEL ||= DEFAULT_CHANNEL;
  if (flags.autoUpdate !== undefined) env.KORTIX_AUTO_UPDATE = flags.autoUpdate ? 'true' : 'false';
  env.KORTIX_AUTO_UPDATE ||= DEFAULT_AUTO_UPDATE;
  if (flags.updateInterval) env.KORTIX_UPDATE_INTERVAL = flags.updateInterval;
  env.KORTIX_UPDATE_INTERVAL ||= DEFAULT_UPDATE_INTERVAL_SECONDS;
}

/** Point every Kortix app image (and the tracked version) at the given tag. */
function applyImagesForTag(env: SelfHostEnv, tag: string): void {
  env.KORTIX_VERSION = tag;
  env.FRONTEND_IMAGE = `${DEFAULT_FRONTEND_IMAGE_REPO}:${tag}`;
  env.API_IMAGE = `${DEFAULT_API_IMAGE_REPO}:${tag}`;
  env.GATEWAY_IMAGE = `${DEFAULT_GATEWAY_IMAGE_REPO}:${tag}`;
  env.SANDBOX_IMAGE = `${DEFAULT_SANDBOX_IMAGE_REPO}:${tag}`;
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
 * Resolve published version info from Docker Hub: the newest released
 * (semver-tagged) version and, when tracking a moving tag (stable/latest), the
 * concrete version that tag currently points to (by matching digests).
 * Best-effort — returns nulls offline.
 */
async function fetchPublishedVersions(repo: string, trackingTag: string): Promise<{ latest: string | null; trackingResolved: string | null }> {
  try {
    const res = await fetch(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`);
    if (!res.ok) return { latest: null, trackingResolved: null };
    const data = (await res.json()) as { results?: Array<{ name: string; digest?: string; images?: Array<{ digest?: string }> }> };
    const rows = data.results ?? [];
    const digestOf = (name: string): string => {
      const r = rows.find((x) => x.name === name);
      return r?.digest || r?.images?.[0]?.digest || '';
    };
    const semvers = rows.map((r) => r.name).filter(isSemverTag).sort((a, b) => compareSemver(b, a));
    const latest = semvers[0] ?? null;
    const trackingDigest = digestOf(trackingTag);
    const trackingResolved = trackingDigest
      ? semvers.find((v) => digestOf(v) && digestOf(v) === trackingDigest) ?? null
      : null;
    return { latest, trackingResolved };
  } catch {
    return { latest: null, trackingResolved: null };
  }
}

async function selfHostVersion(flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  const configured = env.KORTIX_VERSION || DEFAULT_CHANNEL;
  const { latest, trackingResolved } = await fetchPublishedVersions(DEFAULT_API_IMAGE_REPO, configured);

  // What you're actually running: a pinned semver is itself; a moving tag
  // (stable/latest) resolves to whatever version that tag currently points to.
  const running = isSemverTag(configured) ? configured : trackingResolved ?? latest ?? configured;

  process.stdout.write(`\n  ${C.bold}kortix self-host version${C.reset}\n`);
  process.stdout.write(`  ${C.dim}instance ${C.reset}${flags.instance}\n`);
  const tagNote = !isSemverTag(configured) ? `${C.dim} (tracking :${configured})${C.reset}` : '';
  process.stdout.write(`  ${C.dim}running  ${C.reset}${C.cyan}${running}${C.reset}${tagNote}\n`);
  process.stdout.write(`  ${C.dim}latest   ${C.reset}${latest ?? C.dim + 'unknown (offline?)' + C.reset}\n`);
  process.stdout.write(`  ${C.dim}channel  ${C.reset}${env.KORTIX_CHANNEL || DEFAULT_CHANNEL}${C.dim} (auto-update: ${env.KORTIX_AUTO_UPDATE === 'true' ? 'on' : 'off'}, every ${env.KORTIX_UPDATE_INTERVAL}s)${C.reset}\n`);

  // Update hint: only meaningful for a semver pin with a known newer release.
  if (latest) {
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
  process.stdout.write(`  ${C.dim}Update: ${C.reset}${C.cyan}kortix self-host update${C.reset}${C.dim} (current channel) or ${C.reset}${C.cyan}--tag <version>${C.reset}\n\n`);
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
  await configureUpdatePolicy(env, flags);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  process.stdout.write(`${status.ok('Updated self-host integration config')}\n`);
  renderIntegrationSummary(env);
  return 0;
}

/** Interactive (or flag-driven) auto-update channel/interval configuration. */
async function configureUpdatePolicy(env: SelfHostEnv, flags: GlobalFlags): Promise<void> {
  applyChannelAndUpdatePolicy(env, flags);
  if (!shouldPrompt(flags)) return;

  process.stdout.write(`\n  ${C.dim}Auto-update policy${C.reset}\n`);
  const autoUpdate = await selectFrom(
    'Auto-update this instance',
    ['on', 'off'] as const,
    env.KORTIX_AUTO_UPDATE === 'false' ? 'off' : 'on',
  );
  env.KORTIX_AUTO_UPDATE = autoUpdate === 'on' ? 'true' : 'false';
  const channel = await selectFrom(
    'Channel to track (stable is recommended; latest is bleeding-edge)',
    CHANNELS,
    isChannel(env.KORTIX_CHANNEL) ? env.KORTIX_CHANNEL as Channel : DEFAULT_CHANNEL,
  );
  env.KORTIX_CHANNEL = channel;
  if (!isSemverTag(env.KORTIX_VERSION)) applyImagesForTag(env, channel);
  const interval = await prompt('Check interval in seconds', env.KORTIX_UPDATE_INTERVAL || DEFAULT_UPDATE_INTERVAL_SECONDS);
  env.KORTIX_UPDATE_INTERVAL = /^\d+$/.test(interval) && Number(interval) > 0 ? interval : DEFAULT_UPDATE_INTERVAL_SECONDS;
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
  const tag = flags.tag ?? flags.release ?? flags.channel ?? DEFAULT_CHANNEL;
  return {
    KORTIX_VERSION: tag,
    KORTIX_CHANNEL: flags.channel ?? (isChannel(tag) ? tag : DEFAULT_CHANNEL),
    KORTIX_AUTO_UPDATE: flags.autoUpdate === undefined ? DEFAULT_AUTO_UPDATE : flags.autoUpdate ? 'true' : 'false',
    KORTIX_UPDATE_INTERVAL: flags.updateInterval ?? DEFAULT_UPDATE_INTERVAL_SECONDS,
    KORTIX_DOMAIN: '',
    KORTIX_API_DOMAIN: '',
    KORTIX_ACME_EMAIL: '',
    PUBLIC_URL: DEFAULT_PUBLIC_URL,
    API_PUBLIC_URL: DEFAULT_API_URL,
    SUPABASE_PUBLIC_URL: 'http://localhost:13740',
    FRONTEND_PORT: '13737',
    API_PORT: '13738',
    SUPABASE_PORT: '13740',
    POSTGRES_PORT: '13741',
    POOLER_PORT: '13742',
    SUPABASE_POSTGRES_INTERNAL_PORT: '5432',
    FRONTEND_IMAGE: `${DEFAULT_FRONTEND_IMAGE_REPO}:${tag}`,
    API_IMAGE: `${DEFAULT_API_IMAGE_REPO}:${tag}`,
    GATEWAY_IMAGE: `${DEFAULT_GATEWAY_IMAGE_REPO}:${tag}`,
    SANDBOX_IMAGE: `${DEFAULT_SANDBOX_IMAGE_REPO}:${tag}`,
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
    // Auth + agent sandbox defaults shared with every self-host flavor — see
    // shared-runtime-defaults.ts for why these must not be duplicated here.
    ...SHARED_SELF_HOST_DEFAULTS,
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
    DAYTONA_API_KEY: '',
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

function writeCompose(instance: string, env: SelfHostEnv): void {
  const root = instanceDir(instance);
  writeSupabaseVendorAssets(root);
  writeKortixRuntimeAssets(root);
  writeFileSync(
    composePath(instance),
    renderFullDockerCompose(composeProject(instance), { domainConfigured: Boolean(env.KORTIX_DOMAIN?.trim()) }),
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

  // Public domain + TLS (opt-in): when KORTIX_DOMAIN is set, the bundled Caddy
  // service fronts the stack on 80/443 and every public URL becomes the real
  // domain instead of a loopback port. api.<domain> is the default API host;
  // an explicit KORTIX_API_DOMAIN overrides it. Supabase's data-plane routes
  // live on the same host as the frontend (see assets/Caddyfile.txt), so the
  // browser-facing Supabase URL is the frontend domain too.
  if (env.KORTIX_DOMAIN?.trim()) {
    env.KORTIX_API_DOMAIN ||= `api.${env.KORTIX_DOMAIN}`;
    env.KORTIX_ACME_EMAIL ||= `admin@${env.KORTIX_DOMAIN}`;
    env.PUBLIC_URL = `https://${env.KORTIX_DOMAIN}`;
    env.API_PUBLIC_URL = `https://${env.KORTIX_API_DOMAIN}`;
    env.SUPABASE_PUBLIC_URL = `https://${env.KORTIX_DOMAIN}`;
  }

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
  return configInstanceDir(instance);
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
