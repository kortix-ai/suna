import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { getHost, upsertHost, type Host } from '../api/config.ts';
import { confirm, prompt, selectFrom } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import {
  instanceDir as configInstanceDir,
  loadInstanceConfig,
  writeInstanceConfig,
} from '../self-host/config.ts';
import type { SelfHostCommandFlags } from '../self-host/types.ts';
import {
  LAPTOP_APP_REPLICAS,
  PROD_APP_REPLICAS,
  renderFullDockerCompose,
  writeKortixRuntimeAssets,
  writeSupabaseVendorAssets,
} from '../self-host/compose-assets.ts';
import { SHARED_SELF_HOST_DEFAULTS } from '../self-host/shared-runtime-defaults.ts';
import {
  CATEGORY_LABELS,
  groupSecretsByCategory,
  isUpdaterManagedKey,
  maskSecretValue,
  ROTATABLE_GENERATED_KEYS,
  SECRET_DEFS,
  secretDefFor,
  servicesForKeys,
  type SecretDef,
} from '../self-host/secrets-registry.ts';
import {
  namedTunnelConfigured,
  reachabilityMode,
  resolveTunnelUrl,
} from '../self-host/tunnel.ts';

const DEFAULT_INSTANCE = 'default';
const CHANNELS = ['stable', 'latest'] as const;
type Channel = (typeof CHANNELS)[number];
const DEFAULT_CHANNEL: Channel = 'stable';
const DEFAULT_AUTO_UPDATE = 'true';
// The auto-updater runs nightly at a fixed local clock time (not a rolling
// interval from container start) — see assets/updater.sh next_run_epoch().
const DEFAULT_UPDATE_TIME = '02:00';
const DEFAULT_UPDATE_TZ = 'America/New_York';
const UPDATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_HOST_NAME = 'selfhost';
const DEFAULT_PUBLIC_URL = 'http://localhost:13737';
const DEFAULT_API_URL = 'http://localhost:13738';
const DEFAULT_FRONTEND_IMAGE_REPO = 'kortix/kortix-frontend';
const DEFAULT_API_IMAGE_REPO = 'kortix/kortix-api';
const DEFAULT_GATEWAY_IMAGE_REPO = 'kortix/kortix-gateway';
const DEFAULT_SANDBOX_IMAGE_REPO = 'kortix/kortix-sandbox';
// Shown whenever an instance is (or is being configured) NOT reachable via a
// public domain — self-host is VPS-first, and tunnel/local-only are
// evaluation/development conveniences, not the recommended production setup.
const VPS_FIRST_NOTICE =
  'Self-host is designed VPS-first — for reliable production use, deploy on a VPS with a domain.';

const HELP = help`Usage: kortix self-host <subcommand> [options]

Run Kortix on your own VPS — a domain is the production path; laptop modes
(tunnel/local) are for evaluation only. Docs: kortix.com/docs/self-hosting

Subcommands:
  init                    Create/refresh this instance's Compose + env config.
  start                   Pull images and start the stack.
  update | reconcile      Pull + apply the configured channel/version now.
  version                 Show the running version and image tags.
  stop | restart          Stop / restart the stack.
  status                  Show container status.
  doctor                  Validate Docker tooling and the Compose config.
  logs [service]          Tail logs.
  open                    Open the dashboard in a browser.
  configure               Re-run the guided setup.
  env ls | set K=V        Show / update persistent environment values.
  secrets ls              Show every secret, grouped by category (masked).
  secrets set K=V ...     Set secrets, restarting only affected services.
  secrets rotate KEY      Regenerate a rotatable secret (or --all-generated).

Options:
  --instance <name>       Instance name (default: ${DEFAULT_INSTANCE}).
  --domain <domain>       Public domain reachability (recommended, production).
  --tunnel cloudflare     Cloudflare-tunnel reachability (laptop, evaluation).
  --version <ref>         Pin a release/channel/dev build. Alias: --tag/--release.
  --channel <name>        stable|latest to track (default: stable).
  --auto-update <on|off>  Override the default (ON everywhere except --local-images).
  --update-time <HH:MM> / --update-tz <tz>   Auto-updater schedule.
  --allow-downtime        Accept a brief downtime window for a breaking migration.
  --local-images          Run locally-built images (dev mode); forces auto-update off.
  --single-account        Hide multi-account/team UI.
  --enterprise-license    Unlock SSO/SCIM/RBAC/audit (kortix.com/enterprise).
  --allow-missing-secrets Proceed without the sandbox-provider key (evaluation only).
  --admin-email <email>   Grant platform-admin to this account.
  --json                  Machine-readable output where supported.
  --yes                   Accept defaults non-interactively.
  -h, --help              Show this help.

Examples:
  kortix self-host init
  kortix self-host start
  kortix self-host init --domain kortix.example.com
  kortix self-host init --tunnel cloudflare
  kortix self-host update --channel latest
  kortix self-host secrets set DAYTONA_API_KEY=dtn_...
  kortix hosts ls
`;

type GlobalFlags = SelfHostCommandFlags;

interface SelfHostEnv {
  KORTIX_VERSION: string;
  KORTIX_CHANNEL: string;
  KORTIX_AUTO_UPDATE: string;
  KORTIX_UPDATE_TIME: string;
  KORTIX_UPDATE_TZ: string;
  KORTIX_ALLOW_DOWNTIME: string;
  // The app-tier replica count updater.sh rolls to — 2 in domain/prod mode,
  // 1 in laptop mode. Recomputed from KORTIX_DOMAIN on every write (see
  // normalizeFullSupabaseEnv), not operator-set.
  KORTIX_APP_REPLICAS: string;
  KORTIX_DOMAIN: string;
  KORTIX_API_DOMAIN: string;
  KORTIX_ACME_EMAIL: string;
  // Reachability: how cloud (Daytona) sandboxes and other external callers
  // reach this instance's API — see reachabilityMode() in self-host/tunnel.ts.
  // KORTIX_DOMAIN set always means "domain" mode regardless of this value;
  // otherwise it's the persisted tunnel-vs-local preference (default local,
  // matching every self-host instance created before this field existed).
  KORTIX_REACHABILITY_MODE: string;
  // Public origin cloud sandboxes and webhook/OAuth callers reach this
  // instance on — see the KORTIX_URL comment in assets/kortix-compose.yml.
  // Computed by normalizeFullSupabaseEnv() per reachability mode; in tunnel
  // mode only reconcileTunnelReachability() (post `docker compose up`, since
  // the URL doesn't exist until cloudflared boots) overwrites it.
  KORTIX_URL: string;
  // Cloudflare named-tunnel opt-in (tunnel mode only): both set = a stable
  // hostname instead of the zero-config ephemeral quick tunnel.
  CLOUDFLARE_TUNNEL_TOKEN: string;
  CLOUDFLARE_TUNNEL_HOSTNAME: string;
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
  // DAYTONA_TARGET, KORTIX_SINGLE_ACCOUNT_MODE, KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE,
  // KORTIX_PUBLIC_DISABLE_LANDING_PAGE, ENTERPRISE_LICENSE_AVAILABLE,
  // KORTIX_BILLING_INTERNAL_ENABLED, KORTIX_PUBLIC_BILLING_ENABLED, and
  // KORTIX_PUBLIC_CONNECTORS_ENABLED are covered by the [key: string] index
  // signature below — their defaults come from the SHARED_SELF_HOST_DEFAULTS
  // spread in defaultEnv() (see shared-runtime-defaults.ts), not a literal
  // here, so TS can't see them as named properties.
  GATEWAY_INTERNAL_TOKEN: string;
  OPENROUTER_API_KEY: string;
  POSTGRES_PASSWORD: string;
  SUPABASE_JWT_SECRET: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INTERNAL_SERVICE_KEY: string;
  API_KEY_SECRET: string;
  TUNNEL_SIGNING_SECRET: string;
  // GoTrue SAML SSO — enabled by default so an operator flipping
  // --enterprise-license (ENTERPRISE_LICENSE_AVAILABLE) is the only step left
  // to light up the enterprise SSO/SCIM surface; SAML_PRIVATE_KEY is generated
  // once at `init` (samlPrivateKeyDer()) and persisted, never regenerated on a
  // later `init`/`update` (see defaultEnv()/writeEnv()). Do not rotate it once
  // an IdP is registered — see the compose asset comment for why.
  SAML_ENABLED: string;
  SAML_PRIVATE_KEY: string;
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
    case 'connect-github':
      return selfHostConnectGithub(args, flags);
    case 'env':
      return selfHostEnv(args, flags);
    case 'secrets':
      return selfHostSecrets(args, flags);
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
  const updateTime = takeFlagValue(args, ['--update-time']);
  const updateTz = takeFlagValue(args, ['--update-tz']);
  const allowDowntime = takeFlagBool(args, ['--allow-downtime']);
  const singleAccount = takeFlagBool(args, ['--single-account']);
  const enterpriseLicense = takeFlagBool(args, ['--enterprise-license']);
  const allowMissingSecrets = takeFlagBool(args, ['--allow-missing-secrets']);
  const localImages = takeFlagBool(args, ['--local-images', '--no-pull']);
  const domain = takeFlagValue(args, ['--domain']);
  const tunnelRaw = takeFlagValue(args, ['--tunnel']);
  const adminEmail = takeFlagValue(args, ['--admin-email']);
  if (channelRaw !== undefined && !isChannel(channelRaw)) {
    throw new Error(`--channel must be "stable" or "latest", got "${channelRaw}"`);
  }
  if (autoUpdateRaw !== undefined && autoUpdateRaw !== 'on' && autoUpdateRaw !== 'off') {
    throw new Error(`--auto-update must be "on" or "off", got "${autoUpdateRaw}"`);
  }
  if (updateTime !== undefined && !UPDATE_TIME_PATTERN.test(updateTime)) {
    throw new Error('--update-time must be HH:MM in 24h format, e.g. 02:00');
  }
  if (updateTz !== undefined && updateTz.trim() === '') {
    throw new Error('--update-tz must not be empty');
  }
  if (tunnelRaw !== undefined && tunnelRaw !== 'cloudflare') {
    throw new Error(`--tunnel only supports "cloudflare", got "${tunnelRaw}"`);
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
    updateTime,
    updateTz,
    allowDowntime: allowDowntime || undefined,
    singleAccount: singleAccount || undefined,
    enterpriseLicense: enterpriseLicense || undefined,
    allowMissingSecrets: allowMissingSecrets || undefined,
    localImages: localImages || undefined,
    domain,
    tunnel: tunnelRaw as 'cloudflare' | undefined,
    adminEmail,
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
  applyFeatureFlags(env, flags);
  applyReachabilityFlags(env, flags);
  applyAdminEmail(env, flags);

  // The complete guided `init` flow, in this exact order and no other
  // questions (everything else is dashboard/env-only — see
  // configureIntegrations()'s own doc comment): 1) reachability — the first
  // real decision, since it decides whether agent sandboxes can work at all;
  // 2) admin email; 3) deployment shape (single-account, enterprise
  // license); 4) sandbox provider + its key; 5) Pipedream (optional); 6) a
  // compact update-policy block. Only walk through it on a genuinely
  // first-time init (no prior .env) — a refresh of an already-configured
  // instance shouldn't re-ask any of this every time `init` happens to run
  // again. `configure` always asks (see below), using its own fuller
  // update-policy interrogation (configureUpdatePolicy) instead of this
  // compact block.
  if (shouldPrompt(flags) && existing === null) {
    await promptReachability(env, flags, true);
    await promptAdminEmail(env, flags);
    await promptFeatureFlags(env, flags);
  }
  if (shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env, flags);
  }
  if (shouldPrompt(flags) && existing === null) {
    await promptUpdatePolicyCompact(env, flags);
  }

  // Required secrets — just the agent sandbox runtime (Daytona) now; see
  // missingRequiredSecrets(). Managed git and the LLM key are configured in
  // the dashboard after `start`, not gated here. Interactively this drives the
  // guided flow until satisfied; non-interactively (or --yes) it fails loudly
  // instead of silently producing a box that can't run agents. Persist
  // whatever was collected either way so a follow-up `secrets set` /
  // `configure` has something to build on.
  const secretsExit = await ensureRequiredSecrets(env, flags);

  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  // Reloaded AFTER ensureRequiredSecrets (which may itself have just persisted
  // allow_missing_secrets via recordAllowMissingSecrets) so this write below
  // preserves it instead of clobbering it back to unset.
  const existingConfig = loadInstanceConfig(flags.instance);
  writeInstanceConfig({
    schema_version: 1,
    instance: flags.instance,
    ...(flags.release || existingConfig?.release ? { release: flags.release ?? existingConfig?.release } : {}),
    ...(existingConfig?.allow_missing_secrets ? { allow_missing_secrets: true } : {}),
  });
  if (secretsExit !== 0) return secretsExit;
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
  process.stdout.write(`  ${C.dim}Channel   ${C.reset}${env.KORTIX_CHANNEL}${C.dim} (auto-update: ${env.KORTIX_AUTO_UPDATE === 'true' ? 'on' : 'off'}, nightly at ${env.KORTIX_UPDATE_TIME} ${env.KORTIX_UPDATE_TZ})${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Reachability ${C.reset}${describeReachability(env)}\n`);
  if (reachabilityMode(env) !== 'domain') {
    process.stdout.write(`  ${C.dim}${VPS_FIRST_NOTICE}${C.reset}\n`);
  }
  process.stdout.write('\n');
  renderIntegrationSummary(env);
  process.stdout.write(`  ${C.dim}Start      ${C.reset}${C.cyan}kortix self-host start${instance === DEFAULT_INSTANCE ? '' : ` --instance ${instance}`}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Configure  ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} or ${C.reset}${C.cyan}kortix self-host env set KEY=VALUE${C.reset}\n`);
  process.stdout.write(`  ${C.dim}Switch API  ${C.reset}${C.cyan}kortix hosts use selfhost${C.reset}${C.dim} / ${C.reset}${C.cyan}kortix hosts use cloud${C.reset}\n\n`);
  renderAfterStartNote();
}

async function selfHostStart(flags: GlobalFlags): Promise<number> {
  if (!existsSync(envPath(flags.instance)) || !existsSync(composePath(flags.instance))) {
    const code = await selfHostInit(flags);
    if (code !== 0) return code;
  }

  const env = loadEnvWithDefaults(flags)!;
  if (shouldPrompt(flags) && integrationReviewNeeded(env)) {
    await configureIntegrations(env, flags);
  }

  // `init` and `start` can run on separate invocations (init non-interactively,
  // start later) — guard here too instead of trusting init already enforced it.
  const secretsExit = await ensureRequiredSecrets(env, flags);
  if (secretsExit !== 0) {
    writeEnv(flags.instance, env);
    writeCompose(flags.instance, env);
    return secretsExit;
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
    const provider = sandboxProviders(env)[0] ?? 'daytona';
    const key = SANDBOX_PROVIDER_KEY[provider] ?? 'DAYTONA_API_KEY';
    process.stdout.write(
      `${C.yellow}  warning${C.reset}  ${C.dim}sandbox runtime not configured — agent sessions will fail to start.${C.reset}\n`,
    );
    process.stdout.write(
      `${C.dim}           run ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} to set ${C.reset}${key}${C.dim}.${C.reset}\n\n`,
    );
  }

  if (!gitProviderConfigured(env)) {
    process.stdout.write(
      `${C.dim}  note     managed git not configured yet — connect GitHub in the dashboard (Settings → Git) before creating projects.${C.reset}\n\n`,
    );
  }

  if (reachabilityMode(env) === 'local') {
    process.stdout.write(
      `${C.yellow}  warning${C.reset}  ${C.dim}local-only reachability — agent sandboxes and other external callers${C.reset}\n`,
    );
    process.stdout.write(
      `${C.dim}           (webhooks, Slack/Teams OAuth, git-proxy clone) cannot reach this instance.${C.reset}\n`,
    );
    process.stdout.write(
      `${C.dim}           run ${C.reset}${C.cyan}kortix self-host configure${C.reset}${C.dim} to set up a domain or Cloudflare tunnel.${C.reset}\n\n`,
    );
  }

  // Dev mode (--local-images / KORTIX_IMAGE_PULL=never): the Kortix app
  // images were built locally and were never pushed to any registry, so a
  // blanket `docker compose pull` fails outright (`manifest unknown`) instead
  // of just skipping those services — `docker compose pull` has no per-service
  // "skip this one" short of a compose-level pull_policy this generic compose
  // file doesn't set. Skip the whole pull step here, exactly like updater.sh's
  // perform_update() already does for the same flag (see assets/updater.sh) —
  // `up -d` below still pulls any *other* (e.g. Supabase/cloudflared) image
  // that isn't already present locally, since its default pull_policy is
  // "missing", not "never".
  if (shouldPullImages(env)) {
    const pull = compose(flags.instance, ['pull']);
    if (pull !== 0) return pull;
  }
  const up = compose(flags.instance, ['up', '-d']);
  if (up !== 0) return up;
  const refreshApp = compose(flags.instance, ['up', '-d', '--force-recreate', '--no-deps', 'kortix-api', 'frontend']);
  if (refreshApp !== 0) return refreshApp;

  // Tunnel reachability mode only: the cloudflared quick-tunnel URL is
  // ephemeral (a fresh one every restart) and doesn't exist until the
  // container has actually booted, so this can only happen post-`up`, not at
  // config-write time. Non-fatal on timeout — the stack still comes up, just
  // unreachable for sandboxes until the next start/update.
  const tunnelCode = await reconcileTunnelReachability(flags.instance, env);
  if (tunnelCode !== 0) return tunnelCode;

  registerLocalHost(DEFAULT_HOST_NAME, env.API_PUBLIC_URL, env.PUBLIC_URL);
  process.stdout.write(`${status.ok('Self-hosted Kortix is starting')}\n`);
  process.stdout.write(`${C.dim}  Dashboard: ${C.reset}${C.cyan}${env.PUBLIC_URL}${C.reset}\n`);
  process.stdout.write(`${C.dim}  Logs:      ${C.reset}${C.cyan}kortix self-host logs${C.reset}\n\n`);
  renderIntegrationSummary(env);
  renderAfterStartNote();
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
 * explicit version), then run a zero-downtime rollout. This shells out to the
 * exact same updater.sh the in-compose auto-updater runs nightly (see
 * assets/updater.sh) with a one-shot `once` argument, so a manual, on-demand
 * `update`/`reconcile` gets the identical start-first rolling swap — migrate
 * first, new replicas healthy before old ones stop, a failed rollout leaves
 * the previous version serving — instead of the stop-everything-then-start
 * cycle a naive restart would do. The Postgres volume is untouched either way.
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
  // Runtime feature flags (single-account/enterprise-license) and
  // reachability (domain/tunnel/local) are ordinary env — an update only ever
  // moves image tags, so an explicit flag is honored (non-interactively;
  // `update` never prompts) but nothing here resets a value the operator
  // already set via `configure`/`env set`.
  applyFeatureFlags(env, flags);
  applyReachabilityFlags(env, flags);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);

  process.stdout.write(`  ${C.dim}version  ${C.reset}${oldVersion} ${C.dim}→${C.reset} ${C.cyan}${env.KORTIX_VERSION}${C.reset}\n\n`);

  // Ensure Supabase/Caddy/cloudflared (and any not-yet-created app-tier
  // container) exist without recreating anything already running —
  // `--no-recreate` is the key: it never touches an existing
  // kortix-api/llm-gateway/frontend container even though writeCompose() just
  // changed its image tag. The zero-downtime rollout below is what actually
  // rolls those forward.
  const base = compose(flags.instance, ['up', '-d', '--no-recreate']);
  if (base !== 0) return base;

  const rollout = compose(flags.instance, ['run', '--rm', '--no-deps', 'kortix-updater', 'once']);
  if (rollout !== 0) return rollout;

  // Tunnel reachability mode only, and deliberately AFTER the zero-downtime
  // rollout above (not before): recreating kortix-api early to pick up a
  // changed KORTIX_URL would bypass updater.sh's start-first health-checked
  // swap and apply the new image tag as an ungated forced recreate instead.
  // Once the rollout is done, kortix-api is already on the new version, so
  // this is just a fast in-place recreate (like `secrets set` triggers) to
  // pick up KORTIX_URL — no separate rollout semantics needed for that.
  return reconcileTunnelReachability(flags.instance, env);
}

/** Resolve the image tag to apply: an explicit pin wins, else the channel. */
function resolveTag(flags: GlobalFlags, existing: SelfHostEnv | null): string {
  return flags.tag ?? flags.release ?? flags.channel ?? existing?.KORTIX_CHANNEL ?? DEFAULT_CHANNEL;
}

/**
 * Default auto-update policy for a given resolved tag, absent an explicit
 * --auto-update. Defaults ON everywhere, including a pinned tag (a specific
 * released version or a `dev-<sha>` build): the nightly updater re-pulling
 * the SAME immutable pinned tag is a harmless no-op (nothing to roll — see
 * updater.sh's service_up_to_date() check), not silent drift, so there's no
 * real reason to default it off just because a tag is pinned. The one actual
 * exception is `--local-images` (a locally-built image never pushed to any
 * registry) — applyChannelAndUpdatePolicy()/defaultEnv() force it off
 * unconditionally for that case, regardless of this default. An explicit
 * --auto-update still always wins over both (see call sites below).
 */
function defaultAutoUpdateFor(_tag: string): 'true' | 'false' {
  return DEFAULT_AUTO_UPDATE as 'true' | 'false';
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
  env.KORTIX_AUTO_UPDATE ||= defaultAutoUpdateFor(tag);
  if (flags.updateTime) env.KORTIX_UPDATE_TIME = flags.updateTime;
  env.KORTIX_UPDATE_TIME ||= DEFAULT_UPDATE_TIME;
  if (flags.updateTz) env.KORTIX_UPDATE_TZ = flags.updateTz;
  env.KORTIX_UPDATE_TZ ||= DEFAULT_UPDATE_TZ;
  if (flags.allowDowntime !== undefined) env.KORTIX_ALLOW_DOWNTIME = flags.allowDowntime ? '1' : '0';
  env.KORTIX_ALLOW_DOWNTIME ||= '0';

  // Dev mode: locally-built images aren't on any registry — the updater
  // can't pull them, so it must not try, and it must never auto-move a local
  // dev box. --local-images always wins over channel defaults and even an
  // explicit --auto-update, since "on" would just fail against no registry.
  if (flags.localImages) {
    env.KORTIX_IMAGE_PULL = 'never';
    env.KORTIX_AUTO_UPDATE = 'false';
  }
}

/**
 * Apply --domain / --tunnel onto env, non-interactively. Each only overwrites
 * when the flag was actually passed (undefined = "not passed"), so a bare
 * `init`/`update`/`configure` never resets a reachability mode the operator
 * already set via a prior run or `configure`'s interactive prompt — same
 * convention as applyChannelAndUpdatePolicy/applyFeatureFlags above.
 * `--domain ""` explicitly clears a previously configured domain (falls back
 * to whatever KORTIX_REACHABILITY_MODE otherwise resolves to — tunnel or
 * local); `--tunnel cloudflare` only ever sets tunnel mode, it never turns
 * itself off (switch to domain via --domain, or to local via
 * `env set KORTIX_REACHABILITY_MODE=local` — there's no "un-tunnel" flag
 * because domain/tunnel/local is a single three-way choice, not independent
 * toggles). KORTIX_REACHABILITY_MODE always ends up non-empty so
 * reachabilityMode() never has to guess.
 */
function applyReachabilityFlags(env: SelfHostEnv, flags: GlobalFlags): void {
  if (flags.domain !== undefined) {
    env.KORTIX_DOMAIN = flags.domain;
    if (flags.domain.trim()) env.KORTIX_REACHABILITY_MODE = 'domain';
  }
  if (flags.tunnel !== undefined) env.KORTIX_REACHABILITY_MODE = 'tunnel';
  env.KORTIX_REACHABILITY_MODE ||= 'local';
}

/**
 * Interactive follow-up to applyReachabilityFlags: ask how this instance is
 * reachable from the internet — the setting that decides whether agent
 * sandboxes (which always run on a remote cloud Daytona VM) can call back to
 * it at all. Self-host is VPS-first: the domain path is the recommended,
 * production-ready default. On a genuinely fresh init (`isFreshInit`) the
 * picker itself defaults to "domain"; otherwise (e.g. `configure` on an
 * already-set-up instance) it defaults to whatever is already configured, so
 * re-running `configure` doesn't reset a prior answer. No-ops under --yes /
 * non-TTY.
 */
async function promptReachability(env: SelfHostEnv, flags: GlobalFlags, isFreshInit = false): Promise<void> {
  if (!shouldPrompt(flags)) return;

  process.stdout.write(`\n  ${C.bold}Reachability${C.reset}\n`);
  process.stdout.write(
    `  ${C.dim}Kortix self-host is VPS-first: agent sandboxes run on a remote cloud${C.reset}\n` +
      `  ${C.dim}(Daytona) VM and must call back to this API over the public internet —${C.reset}\n` +
      `  ${C.dim}a loopback/internal URL can never work.${C.reset}\n\n` +
      `  ${C.cyan}domain${C.reset}  ${C.dim}Enter your domain (recommended — VPS + DNS, the production path)${C.reset}\n` +
      `  ${C.cyan}tunnel${C.reset}  ${C.dim}Cloudflare tunnel — evaluation on a laptop (ephemeral URL, not for production)${C.reset}\n` +
      `  ${C.cyan}local ${C.reset}  ${C.dim}Local-only — development only, agent sandboxes will NOT work${C.reset}\n`,
  );

  const mode = await selectFrom(
    'How is this instance reachable from the internet?',
    ['domain', 'tunnel', 'local'] as const,
    isFreshInit ? 'domain' : reachabilityMode(env),
  );

  if (mode === 'domain') {
    env.KORTIX_DOMAIN = await prompt('Enter your domain (recommended — VPS + DNS; its A/AAAA record — and the API subdomain\'s — must already point at this box)', env.KORTIX_DOMAIN || '');
    env.KORTIX_REACHABILITY_MODE = 'domain';
    // Both have sane derived defaults (see normalizeFullSupabaseEnv) — asked
    // here, with the derived value pre-filled, so enter-to-accept just works.
    env.KORTIX_API_DOMAIN = await prompt('API subdomain (its own A/AAAA record must also point here)', env.KORTIX_API_DOMAIN || `api.${env.KORTIX_DOMAIN}`);
    env.KORTIX_ACME_EMAIL = await prompt('ACME email (renewal/expiry notices for the automatic TLS certificate)', env.KORTIX_ACME_EMAIL || `admin@${env.KORTIX_DOMAIN}`);
  } else if (mode === 'tunnel') {
    env.KORTIX_DOMAIN = '';
    env.KORTIX_REACHABILITY_MODE = 'tunnel';
    const useNamed = await confirm(
      'Use a stable named Cloudflare tunnel? (needs a token from the Cloudflare Zero Trust dashboard; otherwise a free zero-config quick tunnel is used, but its URL changes every restart)',
      namedTunnelConfigured(env),
    );
    if (useNamed) {
      env.CLOUDFLARE_TUNNEL_TOKEN = await promptSecret('Cloudflare tunnel token', env.CLOUDFLARE_TUNNEL_TOKEN);
      env.CLOUDFLARE_TUNNEL_HOSTNAME = await prompt('Public hostname bound to that tunnel', env.CLOUDFLARE_TUNNEL_HOSTNAME || '');
    } else {
      env.CLOUDFLARE_TUNNEL_TOKEN = '';
      env.CLOUDFLARE_TUNNEL_HOSTNAME = '';
    }
    process.stdout.write(`\n  ${C.dim}${VPS_FIRST_NOTICE}${C.reset}\n\n`);
  } else {
    env.KORTIX_DOMAIN = '';
    env.KORTIX_REACHABILITY_MODE = 'local';
    process.stdout.write(
      `\n  ${C.yellow}warning${C.reset}  ${C.dim}Local-only: agent sandboxes and other external callers (webhooks,${C.reset}\n` +
        `           ${C.dim}Slack/Teams OAuth, git-proxy clone URLs) will NOT be reachable — only${C.reset}\n` +
        `           ${C.dim}browser-local flows (e.g. creating a GitHub App) still work.${C.reset}\n\n`,
    );
    process.stdout.write(`  ${C.dim}${VPS_FIRST_NOTICE}${C.reset}\n\n`);
  }
}

/** Apply --admin-email onto env, non-interactively — only overwrites when the
 *  flag was actually passed, same "explicit flag always wins, bare re-init
 *  never resets" convention as every other apply* helper here. */
function applyAdminEmail(env: SelfHostEnv, flags: GlobalFlags): void {
  if (flags.adminEmail !== undefined) env.KORTIX_PLATFORM_ADMIN_EMAILS = flags.adminEmail;
}

/**
 * Interactive follow-up to applyAdminEmail: which account(s) become platform
 * admins on this self-host, able to configure server-wide settings (managed
 * GitHub, SSO, etc.) in the dashboard. Optional — blank just means "no
 * platform admin yet," which is fine for evaluation but blocks some in-app
 * server settings until set (via a later `env set` or `configure`).
 */
async function promptAdminEmail(env: SelfHostEnv, flags: GlobalFlags): Promise<void> {
  if (!shouldPrompt(flags)) return;

  const answer = await prompt(
    'Admin email (grants platform-admin so you can configure GitHub etc. in the dashboard; blank to skip)',
    env.KORTIX_PLATFORM_ADMIN_EMAILS || '',
  );
  env.KORTIX_PLATFORM_ADMIN_EMAILS = answer;
  if (!answer.trim()) {
    process.stdout.write(
      `  ${C.yellow}warning${C.reset}  ${C.dim}No admin email set — some in-app server settings (e.g. Settings → Git)${C.reset}\n` +
        `           ${C.dim}need at least one platform admin. Set later: ${C.reset}${C.cyan}kortix self-host env set KORTIX_PLATFORM_ADMIN_EMAILS=you@example.com${C.reset}\n\n`,
    );
  }
}

/**
 * Apply --single-account / --enterprise-license onto env, non-interactively.
 * Each only overwrites when the flag was actually passed (undefined = "not
 * passed", never a literal false — see parseGlobalFlags), so a bare
 * `init`/`update` with no flags never resets a value the operator set via
 * `configure` or `env set`. Applied on every init/configure/update so an
 * explicit flag always wins, same convention as applyChannelAndUpdatePolicy
 * above.
 *
 * The marketing landing page is NOT a guided-flow question (there's no
 * `--landing`/`--no-landing` flag either) — it's just an env var
 * (KORTIX_PUBLIC_DISABLE_LANDING_PAGE, defaulted 'true' in
 * SHARED_SELF_HOST_DEFAULTS) an operator flips directly:
 * `kortix self-host env set KORTIX_PUBLIC_DISABLE_LANDING_PAGE=false`. It
 * isn't a decision that needs asking — self-host is an app deployment, not a
 * marketing site, full stop.
 */
function applyFeatureFlags(env: SelfHostEnv, flags: GlobalFlags): void {
  if (flags.singleAccount !== undefined) {
    env.KORTIX_SINGLE_ACCOUNT_MODE = flags.singleAccount ? 'true' : 'false';
    env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE = env.KORTIX_SINGLE_ACCOUNT_MODE;
  }
  if (flags.enterpriseLicense !== undefined) {
    env.ENTERPRISE_LICENSE_AVAILABLE = flags.enterpriseLicense ? 'true' : 'false';
  }
}

/**
 * Interactive follow-up to applyFeatureFlags: the two real deployment-shape
 * y/n questions — single-account mode, Enterprise license — asked in order,
 * defaulting to whatever is currently in .env (so re-running `configure`
 * doesn't reset a prior answer). No-ops under --yes / non-TTY (see
 * shouldPrompt).
 */
async function promptFeatureFlags(env: SelfHostEnv, flags: GlobalFlags): Promise<void> {
  if (!shouldPrompt(flags)) return;

  process.stdout.write(`\n  ${C.bold}Deployment shape${C.reset}\n`);

  const singleAccount = await selectFrom(
    'Single-account mode? (no teams — hides "New account" and team management)',
    ['no', 'yes'] as const,
    env.KORTIX_SINGLE_ACCOUNT_MODE === 'true' ? 'yes' : 'no',
  );
  env.KORTIX_SINGLE_ACCOUNT_MODE = singleAccount === 'yes' ? 'true' : 'false';
  env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE = env.KORTIX_SINGLE_ACCOUNT_MODE;

  const enterpriseLicense = await selectFrom(
    'Do you have an Enterprise license? (SSO / RBAC / Directory Sync / Groups — kortix.com/enterprise)',
    ['no', 'yes'] as const,
    env.ENTERPRISE_LICENSE_AVAILABLE === 'true' ? 'yes' : 'no',
  );
  env.ENTERPRISE_LICENSE_AVAILABLE = enterpriseLicense === 'yes' ? 'true' : 'false';
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
  process.stdout.write(`  ${C.dim}channel  ${C.reset}${env.KORTIX_CHANNEL || DEFAULT_CHANNEL}${C.dim} (auto-update: ${env.KORTIX_AUTO_UPDATE === 'true' ? 'on' : 'off'}, nightly at ${env.KORTIX_UPDATE_TIME} ${env.KORTIX_UPDATE_TZ})${C.reset}\n`);

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

// ── kortix self-host secrets ────────────────────────────────────────────────
//
// `env ls`/`env set` above are the generic escape hatch for the whole .env;
// `secrets` is the secret-aware surface on top of secrets-registry.ts's
// SECRET_DEFS: grouped-by-category listing with masking, refusing to
// hand-set updater-managed keys, and restarting only the Compose services a
// changed/rotated key actually affects (servicesForKeys) instead of the
// whole stack.

function selfHostSecrets(args: string[], flags: GlobalFlags): Promise<number> | number {
  const action = args.shift() ?? 'ls';
  switch (action) {
    case 'ls':
    case 'list':
      return selfHostSecretsLs(args, flags);
    case 'set':
      return selfHostSecretsSet(args, flags);
    case 'rotate':
      return selfHostSecretsRotate(args, flags);
    default:
      process.stderr.write(`${status.err(`unknown secrets subcommand "${action}"`)}\n`);
      return 2;
  }
}

function selfHostSecretsLs(args: string[], flags: GlobalFlags): number {
  const show = takeFlagBool(args, ['--show']);
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  const groups = groupSecretsByCategory(env);
  const missing = missingRequiredSecrets(env);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          instance: flags.instance,
          categories: groups.map((group) => ({
            category: group.category,
            label: group.label,
            secrets: group.rows.map((row) => ({
              ...row,
              value: show ? env[row.key] ?? '' : undefined,
            })),
          })),
          missing_required: missing,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`\n  ${C.bold}kortix self-host secrets${C.reset}${show ? C.dim + '  (values revealed — do not paste this output anywhere public)' + C.reset : ''}\n`);
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    process.stdout.write(`\n  ${C.white}${C.bold}${group.label}${C.reset}\n`);
    for (const row of group.rows) {
      const rawValue = env[row.key] ?? '';
      const displayValue = show ? rawValue : row.masked;
      const setMark = row.configured ? `${C.green}set${C.reset}` : row.required ? `${C.red}unset${C.reset}` : `${C.dim}unset${C.reset}`;
      const kindMark = row.kind === 'generated' ? 'generated' : 'operator';
      const rotatableMark = row.rotatable ? 'rotatable' : '-';
      const managedNote = row.updaterManaged ? ` ${C.yellow}(updater-managed — use --tag/--channel/--release)${C.reset}` : '';
      process.stdout.write(
        `    ${pad(row.key, 34)} ${pad(row.required ? 'required' : 'optional', 9)} ${pad(setMark, 12)} ${pad(kindMark, 10)} ${pad(rotatableMark, 10)} ${C.dim}${displayValue || '(unset)'}${C.reset}${managedNote}\n`,
      );
    }
  }

  process.stdout.write('\n');
  if (missing.length > 0) {
    process.stdout.write(`  ${C.yellow}Missing required:${C.reset}\n`);
    for (const item of missing) process.stdout.write(`    ${C.dim}- ${C.reset}${item.label}\n`);
    process.stdout.write(`\n  ${C.dim}Fix: ${C.reset}${C.cyan}kortix self-host secrets set KEY=VALUE${C.reset}${C.dim} or ${C.reset}${C.cyan}kortix self-host configure${C.reset}\n\n`);
  } else {
    process.stdout.write(`  ${status.ok('All required secrets are set.')}\n\n`);
  }
  return 0;
}

function refuseUpdaterManagedKeyMessage(key: string): string {
  return `${status.err(`"${key}" is managed by the updater and can't be hand-set.`)} Use ${C.cyan}--tag${C.reset}/${C.cyan}--channel${C.reset}/${C.cyan}--release${C.reset} on \`init\`/\`update\` instead.\n`;
}

/** Restart exactly the services a changed key set affects (or tell the
 *  operator the stack isn't running yet, so changes apply on next `start`).
 *  Filters out services that are opt-in and not currently rendered into this
 *  instance's Compose file (`caddy` without a domain, `cloudflared` outside
 *  tunnel mode) — `docker compose up --no-deps <service>` errors on a service
 *  name absent from the Compose file, which would otherwise turn e.g.
 *  `secrets set CLOUDFLARE_TUNNEL_TOKEN=...` (settable ahead of actually
 *  switching to tunnel mode) into a hard failure instead of a silent no-op. */
function restartServicesForKeys(instance: string, env: SelfHostEnv, keys: readonly string[]): number {
  const domainConfigured = Boolean(env.KORTIX_DOMAIN?.trim());
  const tunnelActive = reachabilityMode(env) === 'tunnel';
  const services = servicesForKeys(keys).filter((service) => {
    if (service === 'caddy') return domainConfigured;
    if (service === 'cloudflared') return tunnelActive;
    return true;
  });
  if (services.length === 0) {
    process.stdout.write(`${C.dim}  not active in the current reachability mode — nothing to restart.${C.reset}\n\n`);
    return 0;
  }
  if (!composeHasRunningServices(instance)) {
    process.stdout.write(`${C.dim}  stack isn't running — this takes effect on the next ${C.reset}${C.cyan}kortix self-host start${C.reset}\n\n`);
    return 0;
  }
  const code = compose(instance, ['up', '-d', '--force-recreate', '--no-deps', ...services]);
  if (code !== 0) return code;
  process.stdout.write(`${C.dim}  restarted: ${C.reset}${services.join(', ')}\n\n`);
  return 0;
}

async function selfHostSecretsSet(args: string[], flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  if (args.length === 0) {
    process.stderr.write(`${status.err('Pass KEY=VALUE pairs, or a bare KEY to be prompted.')}\n`);
    return 2;
  }

  const changedKeys: string[] = [];

  // `secrets set KEY` (no '=') — prompt interactively for exactly one key.
  if (args.length === 1 && !args[0]!.includes('=')) {
    const key = args[0]!;
    if (isUpdaterManagedKey(key)) {
      process.stderr.write(refuseUpdaterManagedKeyMessage(key));
      return 2;
    }
    if (!shouldPrompt(flags)) {
      process.stderr.write(`${status.err(`"${key}" needs a value.`)} Pass ${C.cyan}${key}=VALUE${C.reset}, or run this interactively.\n`);
      return 2;
    }
    if (!secretDefFor(key)) {
      process.stdout.write(`  ${C.yellow}note${C.reset}  "${key}" isn't a known secret — setting it anyway.\n`);
    }
    env[key] = await promptSecret(key, env[key] ?? '');
    changedKeys.push(key);
  } else {
    for (const pair of args) {
      const idx = pair.indexOf('=');
      if (idx <= 0) {
        process.stderr.write(`${status.err(`Invalid assignment: ${pair}. Use KEY=VALUE.`)}\n`);
        return 2;
      }
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (isUpdaterManagedKey(key)) {
        process.stderr.write(refuseUpdaterManagedKeyMessage(key));
        return 2;
      }
      if (!secretDefFor(key)) {
        process.stdout.write(`  ${C.yellow}note${C.reset}  "${key}" isn't a known secret — setting it anyway.\n`);
      }
      env[key] = value;
      changedKeys.push(key);
    }
  }

  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  process.stdout.write(`${status.ok(`Updated ${changedKeys.join(', ')}`)}\n`);
  return restartServicesForKeys(flags.instance, env, changedKeys);
}

// Generated secrets whose rotation cascades into a derived value elsewhere in
// .env — rotating SUPABASE_JWT_SECRET without re-deriving the anon/service-role
// JWTs it signs would leave the Supabase clients holding tokens signed with a
// secret the server no longer recognizes. Returns the extra keys touched (for
// restart-service accumulation); the primary key's own value is always
// (re)generated by the caller first.
function cascadeRotatedSecret(env: SelfHostEnv, key: string, freshValue: string): string[] {
  env[key] = freshValue;
  if (key === 'SUPABASE_JWT_SECRET') {
    env.JWT_SECRET = freshValue;
    env.SUPABASE_ANON_KEY = supabaseJwt('anon', freshValue);
    env.SUPABASE_SERVICE_ROLE_KEY = supabaseJwt('service_role', freshValue);
    env.ANON_KEY = env.SUPABASE_ANON_KEY;
    env.SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    return ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  }
  return [];
}

/** Fresh crypto-random bytes sized the same as this key's original generator
 *  in defaultEnv() (see `token()` calls there) — kept in one place so rotate
 *  can't silently drift from init's own generation. */
function freshTokenFor(key: string): string {
  switch (key) {
    case 'SUPABASE_JWT_SECRET':
      return token(64);
    case 'DASHBOARD_PASSWORD':
      return token(24);
    case 'POSTGRES_PASSWORD':
    case 'S3_PROTOCOL_ACCESS_KEY_SECRET':
    case 'GATEWAY_INTERNAL_TOKEN':
    case 'INTERNAL_SERVICE_KEY':
    case 'API_KEY_SECRET':
    case 'TUNNEL_SIGNING_SECRET':
      return token(32);
    case 'S3_PROTOCOL_ACCESS_KEY_ID':
      return token(16);
    default:
      return token(32);
  }
}

/** Reasons a `generated` secret is deliberately excluded from rotation —
 *  mirrors the comment on SECRET_DEFS in secrets-registry.ts. Anything
 *  `operator`-kind gets a generic "use secrets set" refusal instead. */
const NON_ROTATABLE_GENERATED_REASONS: Record<string, string> = {
  SECRET_KEY_BASE: 'internal Supabase-infra encryption key — rotating it would invalidate already-issued sessions.',
  REALTIME_DB_ENC_KEY: 'internal Supabase Realtime encryption key — rotating it would leave existing encrypted state undecryptable.',
  VAULT_ENC_KEY: 'Postgres pgsodium vault encryption key — rotating it would leave already-encrypted data undecryptable.',
  PG_META_CRYPTO_KEY: 'internal pg-meta crypto key — rotating it would leave already-encrypted data undecryptable.',
  LOGFLARE_PUBLIC_ACCESS_TOKEN: 'internal Supabase Logflare access token — not a user-facing credential, rotation unsupported.',
  LOGFLARE_PRIVATE_ACCESS_TOKEN: 'internal Supabase Logflare access token — not a user-facing credential, rotation unsupported.',
  SUPABASE_ANON_KEY: 'derived from SUPABASE_JWT_SECRET — run `secrets rotate SUPABASE_JWT_SECRET` instead.',
  SUPABASE_SERVICE_ROLE_KEY: 'derived from SUPABASE_JWT_SECRET — run `secrets rotate SUPABASE_JWT_SECRET` instead.',
  DASHBOARD_USERNAME: 'not a rotation target — use `secrets set DASHBOARD_USERNAME=<value>` to change it.',
  SAML_PRIVATE_KEY: 'the SAML SP signing key — rotating it changes your SP identity and breaks every already-registered IdP until you re-register with them. Set a new one deliberately with `secrets set SAML_PRIVATE_KEY=<base64-der>` if you understand that tradeoff.',
};

function refuseRotateMessage(key: string, def: SecretDef | undefined): string {
  const reason =
    NON_ROTATABLE_GENERATED_REASONS[key] ??
    (def
      ? `${key} is an operator-supplied secret — use \`secrets set ${key}=<value>\` instead.`
      : `"${key}" is not a known secret.`);
  return `${status.err(`Refusing to rotate ${key}`)}: ${C.dim}${reason}${C.reset}\n`;
}

async function selfHostSecretsRotate(args: string[], flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }

  const allGenerated = takeFlagBool(args, ['--all-generated']);
  if (allGenerated && args.length > 0) {
    process.stderr.write(`${status.err('Pass either a key or --all-generated, not both.')}\n`);
    return 2;
  }
  if (!allGenerated && args.length !== 1) {
    process.stderr.write(`${status.err('Usage: kortix self-host secrets rotate <KEY> | --all-generated')}\n`);
    return 2;
  }
  const keys = allGenerated ? [...ROTATABLE_GENERATED_KEYS] : [args[0]!];

  const rotated = new Set<string>();
  const refused: string[] = [];
  for (const key of keys) {
    const def = secretDefFor(key);
    if (!def || def.kind !== 'generated' || !def.rotatable) {
      // --all-generated only ever iterates already-rotatable keys, so this
      // branch is reachable there only if the registry itself is inconsistent;
      // for an explicit single-key rotate it's the normal refusal path.
      if (!allGenerated) process.stderr.write(refuseRotateMessage(key, def));
      refused.push(key);
      continue;
    }
    rotated.add(key);
    for (const extra of cascadeRotatedSecret(env, key, freshTokenFor(key))) rotated.add(extra);
  }

  if (rotated.size === 0) {
    process.stderr.write(`${status.err('Nothing rotated.')}\n`);
    return 2;
  }

  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  process.stdout.write(`${status.ok(`Rotated ${[...rotated].join(', ')}`)}\n`);
  if (refused.length > 0) {
    process.stdout.write(`${C.dim}  skipped (not rotatable): ${C.reset}${refused.join(', ')}\n`);
  }
  return restartServicesForKeys(flags.instance, env, [...rotated]);
}

async function selfHostConfigure(flags: GlobalFlags): Promise<number> {
  const env = loadEnvWithDefaults(flags);
  if (!env) {
    process.stderr.write(`${status.err('Self-host is not initialized. Run `kortix self-host init` first.')}\n`);
    return 1;
  }
  // Same ordering as `init`: reachability first (the decision that determines
  // whether agent sandboxes can work at all), then feature flags, then
  // integrations (Daytona) — see selfHostInit() for the full rationale.
  applyFeatureFlags(env, flags);
  applyReachabilityFlags(env, flags);
  await promptReachability(env, flags);
  await promptFeatureFlags(env, flags);
  await configureIntegrations(env, flags);
  await configureUpdatePolicy(env, flags);
  writeEnv(flags.instance, env);
  writeCompose(flags.instance, env);
  process.stdout.write(`${status.ok('Updated self-host integration config')}\n`);
  process.stdout.write(`  ${C.dim}Reachability ${C.reset}${describeReachability(env)}\n`);
  if (reachabilityMode(env) !== 'domain') {
    process.stdout.write(`  ${C.dim}${VPS_FIRST_NOTICE}${C.reset}\n`);
  }
  process.stdout.write('\n');
  renderIntegrationSummary(env);
  return 0;
}

/**
 * `kortix self-host connect-github` — DEPRECATED. The GitHub App manifest
 * flow it used to run never worked reliably from a laptop (GitHub rejects the
 * flow's hook/callback URLs when they aren't reachable over the public
 * internet: "Hook url is not supported because it isn't reachable over the
 * public Internet"), while the frontend's in-app GitHub connection flow
 * (Settings → Git) works everywhere the dashboard itself loads — including
 * from a laptop, since it's the browser (not this CLI) driving the OAuth
 * dance. Kept as a no-op alias, not removed outright, so an existing script
 * that calls it doesn't hard-fail; it prints where to go instead and exits 0.
 */
async function selfHostConnectGithub(_args: string[], _flags: GlobalFlags): Promise<number> {
  process.stdout.write(
    `\n  ${C.yellow}kortix self-host connect-github is deprecated.${C.reset}\n` +
      `  ${C.dim}GitHub (projects) is configured in the dashboard: Settings → Git.${C.reset}\n\n`,
  );
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
  const updateTime = await prompt('Daily update time (HH:MM, 24h)', env.KORTIX_UPDATE_TIME || DEFAULT_UPDATE_TIME);
  env.KORTIX_UPDATE_TIME = UPDATE_TIME_PATTERN.test(updateTime) ? updateTime : DEFAULT_UPDATE_TIME;
  const updateTz = await prompt('Timezone for that time (IANA, e.g. UTC)', env.KORTIX_UPDATE_TZ || DEFAULT_UPDATE_TZ);
  env.KORTIX_UPDATE_TZ = updateTz.trim() || DEFAULT_UPDATE_TZ;
}

/**
 * The guided `init` flow's compact update-policy step — one y/n plus an
 * opt-in follow-up, NOT the fuller interrogation configureUpdatePolicy()
 * (channel/time/tz every time) that `configure` runs. Channel is deliberately
 * not asked here at all: it stays whatever it already resolved to (stable by
 * default) — power users pin a channel/version via --channel/--version
 * instead of being asked on every init.
 */
async function promptUpdatePolicyCompact(env: SelfHostEnv, flags: GlobalFlags): Promise<void> {
  if (!shouldPrompt(flags)) return;

  process.stdout.write(`\n  ${C.bold}Updates${C.reset}\n`);
  const autoUpdate = await confirm(
    `Auto-update nightly at ${env.KORTIX_UPDATE_TIME || DEFAULT_UPDATE_TIME} ${env.KORTIX_UPDATE_TZ || DEFAULT_UPDATE_TZ}?`,
    env.KORTIX_AUTO_UPDATE !== 'false',
  );
  env.KORTIX_AUTO_UPDATE = autoUpdate ? 'true' : 'false';
  if (!autoUpdate) return;

  const customize = await confirm('Change the update time/timezone?', false);
  if (!customize) return;
  const updateTime = await prompt('Daily update time (HH:MM, 24h)', env.KORTIX_UPDATE_TIME || DEFAULT_UPDATE_TIME);
  env.KORTIX_UPDATE_TIME = UPDATE_TIME_PATTERN.test(updateTime) ? updateTime : DEFAULT_UPDATE_TIME;
  const updateTz = await prompt('Timezone (IANA, e.g. UTC)', env.KORTIX_UPDATE_TZ || DEFAULT_UPDATE_TZ);
  env.KORTIX_UPDATE_TZ = updateTz.trim() || DEFAULT_UPDATE_TZ;
}

const SANDBOX_PROVIDER_CHOICES = ['daytona', 'e2b', 'platinum'] as const;
type SandboxProviderChoice = (typeof SANDBOX_PROVIDER_CHOICES)[number];

/**
 * The CLI's guided-integrations step: the two things that genuinely cannot
 * be set any other way — the agent sandbox runtime (an env-only credential
 * the API reads at boot, no in-app settings surface exists for it) and
 * Pipedream's OPERATOR-level OAuth app credentials (also env-only — the
 * database only ever holds each user's own per-connector bindings, never the
 * platform's Pipedream app itself). Everything else that used to live here —
 * GitHub/managed-git, the LLM key — is configured in the web dashboard after
 * `start` instead (GitHub at Settings → Git, the LLM key as BYOK via the
 * model picker). "The full flow needs to be perfect, all the other bullshit
 * needs to be removed" — this function IS that trim.
 */
async function configureIntegrations(env: SelfHostEnv, flags: GlobalFlags): Promise<void> {
  process.stdout.write(`\n  ${C.bold}Agent sandbox runtime${C.reset}\n`);
  const currentProvider = sandboxProviders(env)[0];
  const provider = shouldPrompt(flags)
    ? await selectFrom(
        'Sandbox provider',
        SANDBOX_PROVIDER_CHOICES,
        (SANDBOX_PROVIDER_CHOICES as readonly string[]).includes(currentProvider ?? '')
          ? (currentProvider as SandboxProviderChoice)
          : 'daytona',
      )
    : ((currentProvider as SandboxProviderChoice) ?? 'daytona');
  env.ALLOWED_SANDBOX_PROVIDERS = provider;

  if (provider === 'daytona') {
    process.stdout.write(`  ${C.dim}Daytona (https://app.daytona.io)${C.reset}\n`);
    env.DAYTONA_API_KEY = await promptSecret('Daytona API key', env.DAYTONA_API_KEY);
    env.DAYTONA_SERVER_URL = await prompt('Daytona server URL', env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api');
    env.DAYTONA_TARGET = await prompt('Daytona target/region', env.DAYTONA_TARGET || 'us');
  } else if (provider === 'e2b') {
    process.stdout.write(`  ${C.dim}E2B (https://e2b.dev)${C.reset}\n`);
    env.E2B_API_KEY = await promptSecret('E2B API key', env.E2B_API_KEY);
  } else {
    process.stdout.write(`  ${C.dim}Platinum (Kortix's own microVM sandbox provider)${C.reset}\n`);
    env.PLATINUM_API_KEY = await promptSecret('Platinum API key', env.PLATINUM_API_KEY);
    env.PLATINUM_API_URL = await prompt('Platinum API URL', env.PLATINUM_API_URL || 'https://api.platinum.dev');
    env.PLATINUM_TEMPLATE = await prompt('Platinum template (optional — leave blank for the platform default)', env.PLATINUM_TEMPLATE);
  }

  // Pipedream (optional, default skip): the ONE other env-only credential
  // that belongs here — the platform-level OAuth app Pipedream issues per
  // operator, not a per-user connection (those live in the DB and are
  // configured per-project in the app). Never gates init/start either way;
  // KORTIX_PUBLIC_CONNECTORS_ENABLED is re-derived from whatever ends up set
  // here on every write (see normalizeFullSupabaseEnv), so skipping just
  // leaves connectors hidden in the frontend rather than half-configured.
  if (shouldPrompt(flags)) {
    const pdMode = await selectFrom(
      'Pipedream connectors (optional, powers the 3,000+ app catalog): configure/skip',
      ['skip', 'configure'] as const,
      pipedreamConfigured(env) ? 'configure' : 'skip',
    );
    if (pdMode === 'configure') {
      env.INTEGRATION_AUTH_PROVIDER = 'pipedream';
      env.PIPEDREAM_CLIENT_ID = await prompt('Pipedream client ID', env.PIPEDREAM_CLIENT_ID);
      env.PIPEDREAM_CLIENT_SECRET = await promptSecret('Pipedream client secret', env.PIPEDREAM_CLIENT_SECRET);
      env.PIPEDREAM_PROJECT_ID = await prompt('Pipedream project ID', env.PIPEDREAM_PROJECT_ID);
      env.PIPEDREAM_ENVIRONMENT = await selectFrom('Pipedream environment', ['development', 'production'] as const, env.PIPEDREAM_ENVIRONMENT === 'development' ? 'development' : 'production');
      env.PIPEDREAM_WEBHOOK_SECRET = await promptSecret('Pipedream webhook secret (optional)', env.PIPEDREAM_WEBHOOK_SECRET);
    }
  }

  env.KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED = 'true';
}

// Managed git (GitHub) is deliberately NOT configured from this guided flow
// anymore — see configureIntegrations() above. It's configured in-app instead
// (Settings → Git, DB-backed) after `start`. The old configureManagedGit()/
// runConnectGithubInteractive()/describeGithubMode()/inferGithubMode() guided
// wizard was removed along with it; `connect-github` (the standalone
// subcommand) is now a deprecated alias — see selfHostConnectGithub() below —
// that also points at the dashboard instead of running the manifest flow,
// which never worked reliably on a laptop anyway (GitHub rejects hook/
// callback URLs that aren't reachable over the public internet).

async function promptSecret(label: string, current: string): Promise<string> {
  const answer = await prompt(current ? `${label} (already set, enter to keep)` : label);
  return answer || current;
}

function pipedreamConfigured(env: SelfHostEnv): boolean {
  return !!(env.PIPEDREAM_CLIENT_ID || env.PIPEDREAM_CLIENT_SECRET || env.PIPEDREAM_PROJECT_ID);
}

/**
 * Whether `start` should run `docker compose pull` at all. False for
 * KORTIX_IMAGE_PULL=never (set by --local-images — see applyChannelAndUpdatePolicy)
 * since those images were built locally and were never pushed to any
 * registry, so a blanket pull fails outright (`manifest unknown`) instead of
 * skipping just the local ones. Mirrors updater.sh's perform_update(), which
 * already skips its own pull step under the same flag.
 */
export function shouldPullImages(env: Record<string, string>): boolean {
  return env.KORTIX_IMAGE_PULL !== 'never';
}

export function sandboxProviders(env: Record<string, string>): string[] {
  return (env.ALLOWED_SANDBOX_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The key each sandbox provider needs to be considered "ready" — mirrors
 *  isProviderEnabled() in apps/api/src/config.ts. */
const SANDBOX_PROVIDER_KEY: Record<string, string> = {
  daytona: 'DAYTONA_API_KEY',
  e2b: 'E2B_API_KEY',
  platinum: 'PLATINUM_API_KEY',
};

/** A configured sandbox provider is one named in ALLOWED_SANDBOX_PROVIDERS
 *  whose required key is actually set — whichever of daytona/e2b/platinum was
 *  chosen at `init`/`configure` (see configureIntegrations()). */
export function sandboxProviderConfigured(env: Record<string, string>): boolean {
  return sandboxProviders(env).some((provider) => !!env[SANDBOX_PROVIDER_KEY[provider] ?? '']);
}

/** Managed git provider configured? Required to create/CRUD projects. */
export function gitProviderConfigured(env: Record<string, string>): boolean {
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

// Registry keys already covered by one of the composite checks above — a
// scalar per-key "is it set" pass over SECRET_DEFS would either double-report
// (e.g. MANAGED_GIT_GITHUB_OWNER alone) or under-report (a PAT-mode operator
// never sets the App fields, and vice versa) the real requirement, which is
// "git is configured EITHER via PAT OR via App", not "every one of these
// fields is set". Skip them in the scalar pass; the composite checks report
// the one accurate item instead.
const GIT_AND_SANDBOX_SECRET_KEYS: ReadonlySet<string> = new Set([
  'DAYTONA_API_KEY',
  'MANAGED_GIT_GITHUB_OWNER',
  'MANAGED_GIT_GITHUB_TOKEN',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
  'KORTIX_GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
]);

/** Friendlier labels for required secrets whose bare key name isn't obvious
 *  in a "what do I need to fix" message. Anything not listed falls back to
 *  `KEY (Category label)`. */
const REQUIRED_SECRET_LABELS: Record<string, string> = {
  OPENROUTER_API_KEY: 'OpenRouter API key (LLM)',
  POSTGRES_PASSWORD: 'Postgres password (auto-generated — regenerate via `secrets rotate`)',
  SUPABASE_JWT_SECRET: 'Supabase JWT secret (auto-generated — regenerate via `secrets rotate`)',
  SUPABASE_ANON_KEY: 'Supabase anon key (auto-generated, derived from the JWT secret)',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service role key (auto-generated, derived from the JWT secret)',
  DASHBOARD_USERNAME: 'Supabase Studio dashboard username (auto-generated)',
  DASHBOARD_PASSWORD: 'Supabase Studio dashboard password (auto-generated — regenerate via `secrets rotate`)',
  GATEWAY_INTERNAL_TOKEN: 'Gateway internal token (auto-generated — regenerate via `secrets rotate`)',
  INTERNAL_SERVICE_KEY: 'Internal service key (auto-generated — regenerate via `secrets rotate`)',
  API_KEY_SECRET: 'API key secret (auto-generated — regenerate via `secrets rotate`)',
  TUNNEL_SIGNING_SECRET: 'Tunnel signing secret (auto-generated — regenerate via `secrets rotate`)',
};

export interface MissingSecretItem {
  /** Human-readable description of what's missing. */
  label: string;
  /** Exact command(s) to fix it. */
  hint: string;
}

/**
 * Every required secret this instance is still missing. The CLI's init-time
 * gate is deliberately narrow now: ONLY the agent sandbox runtime (Daytona) is
 * a "cannot proceed without it" secret — it's the one thing that genuinely
 * can't be set any other way (it's an env-only credential the API reads at
 * boot, there is no in-app settings surface for it). Managed git (GitHub) and
 * the LLM key are BOTH configured after `start`, in the web dashboard —
 * managed git at Settings → Git (DB-backed, not env/CLI-owned) and the LLM key
 * as BYOK via the model picker — so neither blocks `init`/`start` here
 * anymore; see gitProviderConfigured()/renderIntegrationSummary() for the
 * (non-blocking) status display. Reconciled against sandboxProviderConfigured
 * so a Daytona key configured via any accepted shape reports as satisfied.
 * Pure function of `env` — no filesystem/process access — so it's safe to
 * call from `init`/`start` before anything is written and to unit-test
 * directly.
 */
export function missingRequiredSecrets(env: Record<string, string>): MissingSecretItem[] {
  const missing: MissingSecretItem[] = [];

  if (!sandboxProviderConfigured(env)) {
    // Name whichever provider is actually configured (ALLOWED_SANDBOX_PROVIDERS),
    // defaulting to Daytona's hint when nothing has been chosen yet (a bare
    // `init --yes` with no prior .env) — matches the guided flow's own default.
    const provider = sandboxProviders(env)[0] ?? 'daytona';
    const key = SANDBOX_PROVIDER_KEY[provider] ?? 'DAYTONA_API_KEY';
    missing.push({
      label: `Agent sandbox runtime (${provider} API key)`,
      hint: `kortix self-host secrets set ${key}=<key>`,
    });
  }

  for (const def of SECRET_DEFS) {
    if (!def.required || GIT_AND_SANDBOX_SECRET_KEYS.has(def.key)) continue;
    const value = env[def.key] ?? '';
    if (value.trim() !== '') continue;
    missing.push({
      label: REQUIRED_SECRET_LABELS[def.key] ?? `${def.key} (${CATEGORY_LABELS[def.category]})`,
      hint: `kortix self-host secrets set ${def.key}=<value>`,
    });
  }

  return missing;
}

/**
 * Whether this instance has ever had `--allow-missing-secrets` used against
 * it — persisted in instance.json (see SelfHostInstanceConfig) so the choice
 * survives across separate CLI invocations. See recordAllowMissingSecrets()
 * for why this exists.
 */
function persistedAllowMissingSecrets(instance: string): boolean {
  return loadInstanceConfig(instance)?.allow_missing_secrets === true;
}

/**
 * Persist that this instance has been explicitly allowed to run with
 * required secrets missing, so a LATER invocation that omits the flag isn't
 * re-blocked for a decision the operator already made. Confirmed friction
 * live: `init --allow-missing-secrets` succeeds, but the very next `start`
 * (with no flags) re-validates independently (ensureRequiredSecrets runs on
 * every init/start) and hard-fails again unless the flag is repeated. Merges
 * into whatever instance.json already has (release, etc.) rather than
 * clobbering it. No-op (doesn't write) if already persisted.
 */
function recordAllowMissingSecrets(instance: string): void {
  if (persistedAllowMissingSecrets(instance)) return;
  const existing = loadInstanceConfig(instance);
  writeInstanceConfig({
    schema_version: 1,
    instance,
    ...(existing?.release ? { release: existing.release } : {}),
    allow_missing_secrets: true,
  });
}

/**
 * Enforce that required secrets are actually set before this instance can be
 * considered usable — the CLI's primary guarantee: a box never comes up
 * silently unable to run agents. Interactive TTY: drive the guided
 * integrations flow until satisfied or the operator opts out. Non-interactive
 * (`--yes` / no TTY / CI): fail loudly with an itemized list and exact fix
 * commands instead of proceeding into a broken deployment.
 * `--allow-missing-secrets` downgrades the non-interactive failure to a loud
 * warning — local experimentation only — and that choice is remembered (see
 * recordAllowMissingSecrets) so a later bare `start`/`update` doesn't
 * re-demand the same flag for the same still-missing secret.
 *
 * Returns 0 to proceed, non-zero to stop (caller still persists whatever was
 * collected along the way).
 */
async function ensureRequiredSecrets(env: SelfHostEnv, flags: GlobalFlags): Promise<number> {
  let missing = missingRequiredSecrets(env);
  if (missing.length === 0) return 0;

  if (shouldPrompt(flags)) {
    process.stdout.write(`\n  ${C.yellow}Required secrets are missing:${C.reset}\n`);
    for (const item of missing) process.stdout.write(`    ${C.dim}- ${C.reset}${item.label}\n`);
    process.stdout.write(`\n  ${C.dim}Let's set them now.${C.reset}\n`);

    while (missing.length > 0) {
      await configureIntegrations(env, flags);
      missing = missingRequiredSecrets(env);
      if (missing.length === 0) break;
      process.stdout.write(`\n  ${C.yellow}Still missing:${C.reset}\n`);
      for (const item of missing) process.stdout.write(`    ${C.dim}- ${C.reset}${item.label}\n`);
      const keepGoing = await confirm('Configure the remaining required secrets now?', true);
      if (!keepGoing) break;
    }
  }

  missing = missingRequiredSecrets(env);
  if (missing.length === 0) return 0;

  const lines = missing.map((item) => `    ${C.dim}- ${C.reset}${item.label}\n        ${C.cyan}${item.hint}${C.reset}`).join('\n');

  if (flags.allowMissingSecrets || persistedAllowMissingSecrets(flags.instance)) {
    recordAllowMissingSecrets(flags.instance);
    process.stdout.write(
      `\n${status.warn('Proceeding with required secrets missing (--allow-missing-secrets):')}\n${lines}\n\n` +
        `  ${C.dim}This deployment will not be able to run agents until they are set.${C.reset}\n\n`,
    );
    return 0;
  }

  process.stderr.write(
    `\n${status.err('Required secrets are missing — refusing to proceed:')}\n${lines}\n\n` +
      `  ${C.dim}Set them and re-run, or pass ${C.reset}${C.cyan}--allow-missing-secrets${C.reset}${C.dim} for local experimentation only.${C.reset}\n\n`,
  );
  return 1;
}

function integrationReviewNeeded(env: SelfHostEnv): boolean {
  // The sandbox runtime (Daytona) is the only CLI-required integration left —
  // the API won't boot agent sessions without it, and there is no in-app
  // settings surface for it (unlike managed git/LLM, both configured in the
  // dashboard after `start`). A missing key always warrants the wizard, even
  // after a prior review.
  if (!sandboxProviderConfigured(env)) return true;
  if (env.KORTIX_SELF_HOST_INTEGRATIONS_REVIEWED === 'true') return false;
  return true;
}

function shouldPrompt(flags: GlobalFlags): boolean {
  return !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function renderIntegrationSummary(env: SelfHostEnv): void {
  // The ONLY row gated as configured/missing here is the sandbox runtime — the
  // one integration the CLI still requires (see missingRequiredSecrets()).
  // Everything else (managed git, LLM key, connectors, SMTP) is dashboard
  // territory — see renderAfterStartNote() below, not a CLI configured/missing
  // gate that would incorrectly suggest a CLI fix is needed.
  const provider = sandboxProviders(env)[0];
  const rows = [
    {
      name: `Agent sandbox runtime (${sandboxProviders(env).join(',') || 'none'})`,
      configured: sandboxProviderConfigured(env),
      hint: `${SANDBOX_PROVIDER_KEY[provider ?? 'daytona'] ?? 'DAYTONA_API_KEY'} (via kortix self-host configure)`,
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

/**
 * Everything that happens AFTER `start`, in the dashboard, not the CLI — the
 * other half of "the CLI only handles what can't be configured in the web
 * dashboard." Printed at the end of both `init` (renderInitSummary) and
 * `start` (selfHostStart) so it's the last thing an operator reads either way.
 */
function renderAfterStartNote(): void {
  process.stdout.write(
    `  ${C.dim}After start ${C.reset}Sign in → Settings → Git to connect GitHub (projects) · connect your model key in the app (BYOK) · optional: connectors, SMTP — all in the dashboard.${C.reset}\n\n`,
  );
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

export function findFreePort(): Promise<number> {
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
  // Pin implies no drift (see defaultAutoUpdateFor): a channel tracks and
  // defaults on; a specific pinned/dev/local ref defaults off. --local-images
  // always forces this off, even over an explicit --auto-update — "on" would
  // just fail against images that were never pushed to any registry.
  const autoUpdate = flags.localImages
    ? 'false'
    : flags.autoUpdate === undefined
      ? defaultAutoUpdateFor(tag)
      : flags.autoUpdate
        ? 'true'
        : 'false';
  return {
    KORTIX_VERSION: tag,
    KORTIX_CHANNEL: flags.channel ?? (isChannel(tag) ? tag : DEFAULT_CHANNEL),
    KORTIX_AUTO_UPDATE: autoUpdate,
    // Dev mode only: locally-built images the updater must never try to pull
    // from a registry. Empty/unset = normal pull behavior.
    KORTIX_IMAGE_PULL: flags.localImages ? 'never' : '',
    KORTIX_UPDATE_TIME: flags.updateTime ?? DEFAULT_UPDATE_TIME,
    KORTIX_UPDATE_TZ: flags.updateTz ?? DEFAULT_UPDATE_TZ,
    KORTIX_ALLOW_DOWNTIME: flags.allowDowntime ? '1' : '0',
    // Recomputed from KORTIX_DOMAIN on every write in normalizeFullSupabaseEnv;
    // this initial value only matters before that first normalize pass.
    KORTIX_APP_REPLICAS: String(LAPTOP_APP_REPLICAS),
    KORTIX_DOMAIN: '',
    KORTIX_API_DOMAIN: '',
    KORTIX_ACME_EMAIL: '',
    // Reachability preference (tunnel vs local; domain mode is inferred from
    // KORTIX_DOMAIN instead — see reachabilityMode() in self-host/tunnel.ts).
    // Defaults to 'local', matching every self-host instance created before
    // this feature existed — a bare `init` with no flags never silently
    // starts provisioning a tunnel.
    KORTIX_REACHABILITY_MODE: flags.tunnel ? 'tunnel' : 'local',
    // Recomputed per reachability mode in normalizeFullSupabaseEnv; this
    // initial value only matters before that first normalize pass (and, in
    // tunnel mode, until the first `start` captures the real tunnel URL).
    KORTIX_URL: DEFAULT_API_URL,
    CLOUDFLARE_TUNNEL_TOKEN: '',
    CLOUDFLARE_TUNNEL_HOSTNAME: '',
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
    // GoTrue SAML SSO — always on so the enterprise entitlement
    // (--enterprise-license) is the only remaining step to unlock the SAML SSO
    // + SCIM surface (Account → Settings → Identity). The private key is a
    // per-instance RSA-2048 keypair generated once here and persisted like
    // SUPABASE_JWT_SECRET/POSTGRES_PASSWORD — see samlPrivateKeyDer() and the
    // `existing` override in loadEnvWithDefaults()/selfHostInit().
    SAML_ENABLED: 'true',
    SAML_PRIVATE_KEY: samlPrivateKeyDer(),
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
    // Sandboxes run on a real provider, just like Kortix Cloud — Daytona,
    // E2B, or Kortix's own Platinum (SandboxProviderName in
    // apps/api/src/config.ts); `kortix self-host configure` asks which one
    // and collects only that provider's key(s).
    DAYTONA_API_KEY: '',
    E2B_API_KEY: '',
    PLATINUM_API_KEY: '',
    PLATINUM_API_URL: '',
    PLATINUM_TEMPLATE: '',
    PLATINUM_WEBHOOK_SECRET: '',
    KORTIX_GITHUB_APP_ID: '',
    KORTIX_GITHUB_APP_PRIVATE_KEY: '',
    KORTIX_GITHUB_APP_SLUG: '',
    KORTIX_GITHUB_TOKEN: '',
    KORTIX_GITHUB_OWNER: '',
    MANAGED_GIT_PROVIDER: 'github',
    MANAGED_GIT_GITHUB_TOKEN: '',
    MANAGED_GIT_GITHUB_OWNER: '',
    MANAGED_GIT_GITHUB_INSTALL_ID: '',
    // Operator admin allowlist — these emails are platform admins on this
    // self-host (so they can configure the managed GitHub App etc. in-app).
    // Set at init via --admin-email or the guided prompt; the API reads it.
    KORTIX_PLATFORM_ADMIN_EMAILS: flags.adminEmail ?? '',
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
    renderFullDockerCompose(composeProject(instance), {
      domainConfigured: Boolean(env.KORTIX_DOMAIN?.trim()),
      tunnelConfigured: reachabilityMode(env) === 'tunnel',
      namedTunnelConfigured: namedTunnelConfigured(env),
    }),
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

  // Frontend "Connect your tools" / connector-catalogue UI mirrors whether
  // Pipedream is FULLY configured — same three fields
  // apps/api/src/executor/pipedream.ts's own pipedreamConfigured() requires.
  // Recomputed on every write (not just when the now-removed guided-init
  // Pipedream question used to run) so setting/clearing PIPEDREAM_CLIENT_ID
  // et al. via `env set`/`secrets set` directly keeps this in sync too.
  env.KORTIX_PUBLIC_CONNECTORS_ENABLED = pipedreamConfigured(env) ? 'true' : 'false';

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

  // The app-tier replica count the auto-updater rolls to: 2 (behind Caddy,
  // no host ports) once a domain is configured, else 1 (loopback host ports,
  // no LB) — must always track KORTIX_DOMAIN, the same signal
  // renderFullDockerCompose() uses to decide the Compose-side topology.
  env.KORTIX_APP_REPLICAS = String(env.KORTIX_DOMAIN?.trim() ? PROD_APP_REPLICAS : LAPTOP_APP_REPLICAS);

  // KORTIX_URL — the PUBLIC origin cloud (Daytona) sandboxes and other
  // external callers (webhooks, Slack/Teams OAuth, git-proxy clone) reach this
  // instance on. Computed per reachability mode (see reachabilityMode() in
  // self-host/tunnel.ts):
  //   - domain:  the same https://api.<domain> origin API_PUBLIC_URL was just
  //              set to above — Caddy already routes its /v1* paths.
  //   - local:   the loopback API_PUBLIC_URL, same as historical behavior.
  //              Sandboxes can never reach this — see the `start` warning —
  //              but it is at least a real, resolvable, honestly-loopback URL
  //              instead of the old hardcoded internal Docker hostname
  //              (`http://kortix-api:8008`, unresolvable from outside the
  //              compose network and NOT recognized as loopback by the API's
  //              own sandboxCallbackUnreachableReason() guard — so it used to
  //              fail mysteriously ~60s later instead of failing fast).
  //   - tunnel:  intentionally left ALONE here. The cloudflared tunnel's
  //              public URL doesn't exist until its container has actually
  //              booted (and is ephemeral for the zero-config quick tunnel —
  //              a fresh one every restart), so only
  //              reconcileTunnelReachability() (post `docker compose up`) may
  //              set it; overwriting it here would clobber a value captured
  //              moments ago by that same `start`/`update` run.
  const mode = reachabilityMode(env);
  if (mode !== 'tunnel') {
    env.KORTIX_URL = env.API_PUBLIC_URL;
  } else {
    env.KORTIX_URL ||= env.API_PUBLIC_URL;
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

/** Read the `cloudflared` service's logs (stdout+stderr) so
 *  reconcileTunnelReachability can scrape the ephemeral quick-tunnel URL out
 *  of them. Best-effort: an empty/error result just means "no match yet",
 *  which the caller's polling loop (see resolveTunnelUrl) already handles. */
function readComposeLogs(instance: string, service: string): string {
  const result = spawnSync(
    'docker',
    [
      'compose', '--project-name', composeProject(instance),
      '--env-file', envPath(instance), '-f', composePath(instance),
      'logs', '--no-color', '--no-log-prefix', service,
    ],
    { cwd: instanceDir(instance), encoding: 'utf8' },
  );
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * Tunnel reachability mode only (no-op otherwise): capture the cloudflared
 * tunnel's public URL — instant for a named tunnel (the hostname IS the URL),
 * polled from the `cloudflared` container's logs for the zero-config quick
 * tunnel — and rewire KORTIX_URL to it, recreating kortix-api so it actually
 * picks up the change (env_file is only read at container creation, not
 * live). Must run on every `start`/`update`, not just the first one: the
 * quick-tunnel URL is EPHEMERAL — a fresh one is minted whenever the
 * `cloudflared` container itself restarts (e.g. after `stop`/`start`), even
 * though an already-running cloudflared container (a plain re-`start` with
 * nothing stopped) keeps the same URL and this is then a no-op diff.
 *
 * Non-fatal on timeout: the stack is still up, just unreachable for
 * sandboxes until the operator re-runs `start`/`update` (or checks
 * `kortix self-host logs cloudflared`).
 */
async function reconcileTunnelReachability(instance: string, env: SelfHostEnv): Promise<number> {
  if (reachabilityMode(env) !== 'tunnel') return 0;

  process.stdout.write(`  ${C.dim}Cloudflare tunnel (agent sandbox callback)...${C.reset}\n`);
  const result = await resolveTunnelUrl(env, () => readComposeLogs(instance, 'cloudflared'));
  if (!result.ok) {
    process.stdout.write(`${C.yellow}  warning${C.reset}  ${C.dim}${result.error}${C.reset}\n\n`);
    return 0;
  }

  const ephemeralNote = namedTunnelConfigured(env) ? '' : `${C.dim} (ephemeral — changes on next restart)${C.reset}`;
  process.stdout.write(`  ${C.dim}KORTIX_URL -> ${C.reset}${C.cyan}${result.url}${C.reset}${ephemeralNote}\n\n`);

  if (env.KORTIX_URL === result.url) return 0;

  env.KORTIX_URL = result.url!;
  writeEnv(instance, env);
  writeCompose(instance, env);
  return compose(instance, ['up', '-d', '--force-recreate', '--no-deps', 'kortix-api']);
}

/** Human-readable one-line summary of the resolved reachability mode, for
 *  `init`/`configure` summaries. */
function describeReachability(env: SelfHostEnv): string {
  const mode = reachabilityMode(env);
  if (mode === 'domain') return `${C.green}domain${C.reset}${C.dim} — ${env.API_PUBLIC_URL}${C.reset}`;
  if (mode === 'tunnel') {
    const via = namedTunnelConfigured(env) ? 'named Cloudflare tunnel (stable)' : 'Cloudflare quick tunnel (ephemeral)';
    const known = env.KORTIX_URL && !isLocalhostUrlOnPort(env.KORTIX_URL, Number(env.API_PORT)) ? env.KORTIX_URL : '(captured on next start)';
    return `${C.green}tunnel${C.reset}${C.dim} — ${via} — ${known}${C.reset}`;
  }
  return `${C.yellow}local-only${C.reset}${C.dim} — agent sandboxes and external callbacks will not work${C.reset}`;
}

/**
 * Register (or refresh) the CLI's built-in `selfhost` host entry so
 * `kortix hosts use selfhost` + `kortix login` work against this stack
 * out of the box.
 *
 * Also stamps `dashboard_url` with this instance's own frontend origin
 * (`PUBLIC_URL` — loopback port on a laptop, `https://<domain>` once
 * `KORTIX_DOMAIN` is set). Without it, `kortix login`'s browser flow has to
 * *guess* the frontend from the API URL's shape (see web-url.ts), which
 * assumes cloud conventions (`api.<domain>` → `<domain>`, `:8008` → `:3000`)
 * — a guess that is simply wrong for a self-host stack on non-default ports
 * (the laptop default is API `:13738` / dashboard `:13737`, not `:3000`).
 * Storing the real value here means login never has to guess for a host
 * this CLI itself stood up.
 */
function registerLocalHost(name: string, apiUrl: string, dashboardUrl: string): void {
  const existing = getHost(name);
  const sameHost = existing?.url === apiUrl;
  const host: Host = {
    url: apiUrl,
    token: sameHost ? existing?.token ?? '' : '',
    user_id: sameHost ? existing?.user_id ?? '' : '',
    user_email: sameHost ? existing?.user_email ?? '' : '',
    account_id: sameHost ? existing?.account_id ?? '' : '',
    dashboard_url: dashboardUrl,
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

/**
 * A fresh RSA-2048 private key, PKCS#1/DER, base64-encoded — the exact shape
 * GoTrue's GOTRUE_SAML_PRIVATE_KEY requires. Verified against a real GoTrue
 * boot: PKCS8/DER is REJECTED ("SAML private key not in PKCS#1 format",
 * fatal, crash-loops the container) even though it's the more common modern
 * encoding and what openssl's `genpkey` (PKCS8 by default) produces — GoTrue
 * specifically wants the legacy `openssl genrsa`/PKCS#1 container. See
 * https://supabase.com/docs/guides/self-hosting/self-hosted-saml-sso.
 * GoTrue uses this key to sign every outgoing SAML AuthnRequest/metadata
 * document, so it doubles as the self-host instance's SAML SP identity —
 * generated once at `init` and persisted (like SUPABASE_JWT_SECRET), not
 * regenerated on every run.
 */
function samlPrivateKeyDer(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'der' },
  });
  return Buffer.from(privateKey).toString('base64');
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

export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
