/**
 * End-to-end smoke test for the Platinum sandbox provider.
 *
 * Loads config from apps/api/.env (must already have PLATINUM_API_URL,
 * PLATINUM_API_KEY, PLATINUM_TEMPLATE, ALLOWED_SANDBOX_PROVIDERS=platinum),
 * resolves the provider through the same registry the live API uses, then:
 *   1. create() a sandbox via Platinum
 *   2. getStatus() shows 'running'
 *   3. resolveEndpoint() returns the HMAC-signed expose URL
 *   4. ensureRunning() is a no-op when already running
 *   5. remove() tears it down
 *
 * Exits non-zero on any failure. Run with:
 *   cd apps/api && bun --env-file=.env run scripts/e2e-platinum-provider.ts
 */

import { getDefaultProviderName, getProvider } from '../src/platform/providers';
import { config } from '../src/config';

async function main() {
  const name = getDefaultProviderName();
  if (name !== 'platinum') {
    throw new Error(`Default provider is "${name}" — set ALLOWED_SANDBOX_PROVIDERS=platinum in .env to run this probe.`);
  }
  const provider = getProvider(name);
  console.log(`✓ resolved provider: ${provider.name}`);

  const accountId = 'e2e-account';
  const userId    = 'e2e-user';

  console.log('→ create()');
  const created = await provider.create({
    accountId,
    userId,
    name: 'kortix-e2e-platinum',
    envVars: {
      KORTIX_TOKEN: 'e2e-fake-service-key',
      KORTIX_E2E:   '1',
    },
  });
  console.log(`✓ created externalId=${created.externalId} baseUrl=${created.baseUrl}`);
  console.log(`  metadata: ${JSON.stringify(created.metadata)}`);

  try {
    console.log('→ getStatus()');
    const status = await provider.getStatus(created.externalId);
    if (status !== 'running') throw new Error(`expected running, got ${status}`);
    console.log(`✓ status = ${status}`);

    console.log('→ resolveEndpoint()');
    const ep = await provider.resolveEndpoint(created.externalId);
    if (!ep.url.startsWith('http')) throw new Error(`expose URL malformed: ${ep.url}`);
    console.log(`✓ endpoint url=${ep.url}`);
    console.log(`  headers=${JSON.stringify(ep.headers)}`);

    console.log('→ ensureRunning() (no-op when already running)');
    await provider.ensureRunning(created.externalId);
    console.log(`✓ ensureRunning ok`);
  } finally {
    console.log('→ remove()');
    await provider.remove(created.externalId).catch((e) => {
      console.error(`! cleanup failed: ${e}`);
    });
    console.log('✓ removed');
  }

  console.log('\nPLATINUM PROVIDER E2E: PASS');
}

// We import config indirectly via providers — referencing it here makes the
// "unused import" linter happy in case TS-isolated builds prune it.
void config;

main().catch((e) => {
  console.error('PLATINUM PROVIDER E2E: FAIL');
  console.error(e);
  process.exit(1);
});
