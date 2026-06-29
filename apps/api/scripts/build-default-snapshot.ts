/**
 * Build (and pre-warm) the platform DEFAULT sandbox snapshot via the same
 * module the API uses at startup. This is the "bake-warm instance" snapshot
 * (RUNTIME_LAYER_VERSION = baked-oc-instance-warm-v10), NOT the experimental
 * memory-state warm snapshot (that's bake-warm-snapshot.ts).
 *
 *   cd apps/api && \
 *     KORTIX_URL=x pnpm exec dotenvx run -f .env -- bun run scripts/build-default-snapshot.ts
 *
 * Because the local .env points at dev's Daytona org and the snapshot name is
 * content-addressed (same fingerprint as the running dev API), building it here
 * lands the snapshot in dev's org and dev reuses it on the next session boot.
 */
import { resolveDefaultTemplate, computeTemplateIdentity } from '../src/snapshots/templates';
import { ensurePlatformDefaultImage } from '../src/snapshots/builder';
import { listDaytonaSnapshots } from '../src/shared/daytona';

const PLATFORM_PROJECT_SHELL = {
  projectId: '',
  repoUrl: '',
  defaultBranch: '',
  manifestPath: '',
} as const;

async function main() {
  console.log('=== resolving expected default (v10) snapshot identity ===');
  const tpl = await resolveDefaultTemplate();
  const id = await computeTemplateIdentity(PLATFORM_PROJECT_SHELL as any, tpl);
  console.log(`  expected snapshot name : ${id.snapshotName}`);
  console.log(`  runtime fingerprint    : ${id.runtimeFingerprint}`);

  const snaps = await listDaytonaSnapshots();
  const existing = snaps.find((s) => s.name === id.snapshotName);
  if (existing) {
    console.log(`\n  ALREADY EXISTS: ${existing.name} | ${existing.state} | ${existing.createdAt}`);
    console.log('  → dev is already serving v10. Nothing to build.');
    return;
  }
  console.log(`\n  NOT FOUND in org → building now (instance-warm bake runs at image build time)…`);

  const t = Date.now();
  const res = await ensurePlatformDefaultImage({ source: 'manual' });
  const mins = ((Date.now() - t) / 60000).toFixed(1);
  console.log(`\n=== build complete in ${mins}m ===`);
  console.log(`  snapshotName : ${res.snapshotName}`);
  console.log(`  built        : ${res.built}`);
  console.log(`  contentHash  : ${res.contentHash}`);
  console.log(`  isDefault    : ${res.isDefault}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nbuild-default-snapshot failed:', err instanceof Error ? (err.stack || err.message) : err);
    process.exit(1);
  });
