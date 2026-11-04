#!/usr/bin/env bun
/**
 * Configure a deployment's Kortix Discord application from its bot token.
 * A person creates the app in the Discord Developer Portal and stores two
 * values; this script does the rest, and says what the portal still lacks.
 *
 *   1. In the portal: New Application. Bot: Reset Token, turn on "Requires
 *      OAuth2 Code Grant". OAuth2: Reset Secret, add the redirect
 *      `<api>/v1/webhooks/discord/oauth/callback`. Installation: Install Link
 *      "None", untick User Install.
 *   2. Store the two values (never in a shell history):
 *        dotenvx set DISCORD_BOT_TOKEN '<token>' -f .env.<env>
 *        dotenvx set DISCORD_CLIENT_SECRET '<secret>' -f .env.<env>
 *   3. Check the app, and write DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY
 *      (Discord answers both for the token):
 *        cd apps/api && npx -y @dotenvx/dotenvx run -f .env.<env> -- \
 *          bun scripts/discord-app-setup.ts --api https://<api-host> --env-file .env.<env>
 *   4. A deployed env reads its secrets from AWS Secrets Manager. With AWS
 *      credentials, merge the four keys into the env's blob, then deploy:
 *        … --push-sm kortix-<env>-env --region <region>
 *   5. After the deploy serves them, point Discord at the interactions
 *      webhook. Discord sends it a signed PING first, so this proves the key:
 *        … --interactions
 *
 * Reads DISCORD_BOT_TOKEN and DISCORD_CLIENT_SECRET from the environment.
 * Never prints a token, a secret or a blob. `--dry-run` reads only.
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const DISCORD = (process.env.DISCORD_API_URL || 'https://discord.com/api/v10').replace(/\/+$/, '');
const KEYS = ['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] as const;

const { values: args } = parseArgs({
  options: {
    api: { type: 'string' },
    'env-file': { type: 'string' },
    'push-sm': { type: 'string' },
    region: { type: 'string' },
    interactions: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const api = (args.api ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(api)) fail('--api must be the API origin, such as https://dev-api.kortix.com');
const token = process.env.DISCORD_BOT_TOKEN ?? '';
if (!token) fail('DISCORD_BOT_TOKEN is not set: store it with dotenvx and run this under `dotenvx run -f .env.<env>`');

interface Application {
  id: string;
  name: string;
  verify_key: string;
  redirect_uris?: string[];
  bot_public?: boolean;
  bot_require_code_grant?: boolean;
  interactions_endpoint_url?: string | null;
  integration_types_config?: Record<string, unknown>;
}

async function discord<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DISCORD}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'DiscordBot (https://kortix.com, 1)' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => null)) as (T & { message?: string; code?: number; errors?: unknown }) | null;
  if (!res.ok) fail(`Discord ${method} ${path} answered ${res.status}: ${data?.message ?? 'no message'}${data?.errors ? ` ${JSON.stringify(data.errors)}` : ''}`);
  return data as T;
}

const app = await discord<Application>('GET', '/applications/@me');
console.log(`Discord application "${app.name}" (${app.id})`);

// What the install and the webhook need from the portal.
const redirect = `${api}/v1/webhooks/discord/oauth/callback`;
const problems: string[] = [];
if (!(app.redirect_uris ?? []).includes(redirect)) problems.push(`OAuth2 → Redirects: add ${redirect}`);
if (!app.bot_require_code_grant) problems.push('Bot → turn on "Requires OAuth2 Code Grant": without it Discord adds the bot before Kortix knows the project');
if (app.bot_public === false) problems.push('Bot → turn on "Public Bot": otherwise only the app owner can add it to a server');
if (app.integration_types_config && '1' in app.integration_types_config) problems.push('Installation → untick "User Install": Kortix installs the app in servers only');
for (const p of problems) console.log(`  ! ${p}`);
if (!problems.length) console.log('  ✓ redirect, code grant and installation are set');
if (!process.env.DISCORD_CLIENT_SECRET) console.log('  ! DISCORD_CLIENT_SECRET is not set: the install cannot exchange its code');

if (args['env-file'] && !args['dry-run']) {
  for (const [key, value] of [['DISCORD_APPLICATION_ID', app.id], ['DISCORD_PUBLIC_KEY', app.verify_key]] as const) {
    const set = spawnSync('npx', ['-y', '@dotenvx/dotenvx', 'set', key, value, '-f', args['env-file']], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (set.status !== 0) fail(`dotenvx set ${key} failed`);
    console.log(`  ✓ ${key} written to ${args['env-file']} (encrypted)`);
  }
}

if (args['push-sm']) {
  const region = args.region ?? fail('--push-sm needs --region (dev: us-east-2, staging and prod: eu-west-2)');
  const values: Record<string, string> = {
    DISCORD_APPLICATION_ID: app.id,
    DISCORD_PUBLIC_KEY: app.verify_key,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ?? '',
    DISCORD_BOT_TOKEN: token,
  };
  if (!values.DISCORD_CLIENT_SECRET) fail('DISCORD_CLIENT_SECRET is not set: nothing pushed');
  const read = spawnSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', args['push-sm'], '--region', region, '--query', 'SecretString', '--output', 'text'], {
    encoding: 'utf8',
  });
  if (read.status !== 0) fail(`could not read ${args['push-sm']}: ${read.stderr.trim().split('\n').at(-1)}`);
  const blob = JSON.parse(read.stdout) as Record<string, string>;
  const changed = KEYS.filter((k) => blob[k] !== values[k]);
  if (!changed.length) console.log(`  ✓ ${args['push-sm']} already holds the four keys`);
  else if (args['dry-run']) console.log(`  would set in ${args['push-sm']}: ${changed.join(', ')}`);
  else {
    const put = spawnSync('aws', ['secretsmanager', 'put-secret-value', '--secret-id', args['push-sm'], '--region', region, '--secret-string', 'file:///dev/stdin'], {
      input: JSON.stringify({ ...blob, ...values }),
      encoding: 'utf8',
    });
    if (put.status !== 0) fail(`could not write ${args['push-sm']}: ${put.stderr.trim().split('\n').at(-1)}`);
    console.log(`  ✓ ${args['push-sm']}: set ${changed.join(', ')}. Deploy the API so it reads them.`);
  }
}

if (args.interactions) {
  const url = `${api}/v1/webhooks/discord`;
  if (app.interactions_endpoint_url === url) console.log(`  ✓ Interactions Endpoint URL is ${url}`);
  else if (args['dry-run']) console.log(`  would set Interactions Endpoint URL to ${url}`);
  else {
    // Discord PINGs the URL with a signed request first and refuses it unless Kortix answers with the app's key.
    await discord('PATCH', '/applications/@me', { interactions_endpoint_url: url });
    console.log(`  ✓ Interactions Endpoint URL set to ${url}: Discord's signed PING was answered`);
  }
}

if (problems.length) process.exit(2);
