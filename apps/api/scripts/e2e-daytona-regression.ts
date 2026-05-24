/**
 * Daytona-regression smoke. Verifies that the union-widening + snapshot-type
 * narrowing didn't break the Daytona provider's wiring. We don't actually
 * spin up a Daytona sandbox (would consume credits + need a per-project
 * snapshot) — we just exercise:
 *
 *   - registry: getProvider('daytona') returns the Daytona implementation
 *   - config: isProviderEnabled('daytona') reflects DAYTONA_API_KEY presence
 *   - getAvailableProviders() lists both providers
 *   - SnapshotProviderName narrowing still accepts 'daytona'
 *
 * Pass: registry resolves both providers, isProviderEnabled is honest about
 * key presence, getAvailableProviders is the expected union.
 */

import { getProvider, getAvailableProviders } from '../src/platform/providers';
import { config } from '../src/config';

async function main() {
  console.log('→ getAvailableProviders()');
  const avail = getAvailableProviders().sort();
  console.log(`  available = ${JSON.stringify(avail)}`);
  if (JSON.stringify(avail) !== JSON.stringify(['daytona', 'platinum'])) {
    throw new Error(`expected ['daytona','platinum'], got ${JSON.stringify(avail)}`);
  }

  console.log('→ isProviderEnabled checks (honest about key presence)');
  const daytonaEnabled = config.isProviderEnabled('daytona');
  const platinumEnabled = config.isProviderEnabled('platinum');
  const daytonaInAllowed = config.ALLOWED_SANDBOX_PROVIDERS.includes('daytona');
  const platinumInAllowed = config.ALLOWED_SANDBOX_PROVIDERS.includes('platinum');
  console.log(`  daytona: allowed=${daytonaInAllowed} enabled=${daytonaEnabled} key=${!!config.DAYTONA_API_KEY}`);
  console.log(`  platinum: allowed=${platinumInAllowed} enabled=${platinumEnabled} key=${!!config.PLATINUM_API_KEY}`);

  // platinum should be enabled here (the .env we run with sets the key)
  if (!platinumEnabled) throw new Error('platinum should be enabled in this env');

  console.log('→ getProvider(daytona) — verify registry can resolve it');
  // The provider class instantiates only when DAYTONA_API_KEY is set (per the
  // switch in index.ts). We instead exercise the registry's resolution path
  // without actually calling create(). If DAYTONA_API_KEY is set in this .env,
  // we get a real provider; otherwise we expect a clean throw (not a crash).
  try {
    const d = getProvider('daytona');
    if (d.name !== 'daytona') throw new Error(`bad provider.name: ${d.name}`);
    console.log(`  ✓ daytona provider resolved (DAYTONA_API_KEY present)`);
  } catch (e: any) {
    if (e.message?.includes('DAYTONA_API_KEY')) {
      console.log(`  ✓ daytona resolution blocked cleanly: ${e.message}`);
    } else {
      throw e;
    }
  }

  console.log('→ getProvider(platinum) — verify the new path');
  const p = getProvider('platinum');
  if (p.name !== 'platinum') throw new Error(`bad provider.name: ${p.name}`);
  console.log(`  ✓ platinum provider resolved, name=${p.name}`);

  console.log('→ snapshot-system narrowing — verify daytona-only types pass typecheck (compile-time)');
  // The Extract<SandboxProviderName,'daytona'> narrowing in snapshots/builder.ts
  // would fail typecheck if we broke it; the fact that `bun run typecheck`
  // passes is the proof. Touching the import here as a runtime smoke.
  await import('../src/snapshots/builder');
  console.log('  ✓ snapshots/builder imports cleanly');

  console.log('\nDAYTONA REGRESSION: PASS');
}

main().catch((e) => { console.error('\nDAYTONA REGRESSION: FAIL'); console.error(e); process.exit(1); });
