#!/usr/bin/env bun
/**
 * Create or update the Composio project's webhook subscription that feeds
 * app-event triggers (`POST /v1/webhooks/events/composio`).
 *
 * Idempotent. One webhook URL exists per Composio project. The script reads
 * the project's subscription, then creates it (V3, three enabled events) or
 * patches its URL/events. Composio returns the signing secret only on
 * creation, so the script prints it only then, with the exact dotenvx command.
 *
 *   cd apps/api && npx -y @dotenvx/dotenvx run -f .env.<env> -- \
 *     bun scripts/composio-webhook-subscription.ts \
 *     --url https://<api-host>/v1/webhooks/events/composio [--env-file .env.<env>] [--dry-run]
 *
 * Needs COMPOSIO_API_KEY in the environment. The key is never printed.
 * `--dry-run` only reads; it prints the plan and writes nothing.
 */
import { parseArgs } from 'node:util';

const BASE = (process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev').replace(/\/+$/, '');
const PATH = '/api/v3.1/webhook_subscriptions';
const ENABLED_EVENTS = ['composio.trigger.message', 'composio.trigger.disabled', 'composio.connected_account.expired'];

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'env-file': { type: 'string', default: '.env.dev' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) fail('COMPOSIO_API_KEY is not set. Run through dotenvx with the target env file.');
if (!values.url) fail('--url is required, e.g. https://<api-host>/v1/webhooks/events/composio');
const url = values.url;
if (!/^https:\/\/\S+$/.test(url)) fail('--url must be an https URL');
const envFile = values['env-file']!;
const dryRun = values['dry-run']!;

async function call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-api-key': apiKey!, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const existing = ((await call('GET', `${PATH}?limit=1`)).items ?? [])[0] as Record<string, any> | undefined;
const body = { webhook_url: url, enabled_events: ENABLED_EVENTS, version: 'V3' };
const upToDate =
  existing &&
  existing.webhook_url === url &&
  existing.version === 'V3' &&
  ENABLED_EVENTS.every((e) => (existing.enabled_events ?? []).includes(e));

console.log(`composio base:  ${BASE}`);
console.log(`existing:       ${existing ? `${existing.id} -> ${existing.webhook_url}` : 'none'}`);
const plan = !existing ? 'create' : upToDate ? 'none (already up to date)' : 'update';
console.log(`plan:           ${plan}`);
console.log(`target:         ${url}`);
console.log(`events:         ${ENABLED_EVENTS.join(', ')}`);

if (dryRun) {
  console.log('dry run: nothing written');
} else if (!existing) {
  const created = await call('POST', PATH, body);
  console.log(`created:        ${created.id}`);
  if (!created.secret) fail('Composio returned no secret on creation. Rotate it in the Composio dashboard.');
  console.log('\nStore the signing secret now. Composio does not show it again:');
  console.log(`  dotenvx set COMPOSIO_WEBHOOK_SECRET '${created.secret}' -f apps/api/${envFile}`);
} else if (!upToDate) {
  await call('PATCH', `${PATH}/${encodeURIComponent(existing.id)}`, body);
  console.log(`updated:        ${existing.id}`);
  console.log('The secret is unchanged. COMPOSIO_WEBHOOK_SECRET stays as is.');
}
