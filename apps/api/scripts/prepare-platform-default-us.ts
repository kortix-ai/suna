#!/usr/bin/env bun
/** Run inside the new API image with the Dev runtime environment installed by Docker. */
import { config } from '../src/config';
import { closeDatabase } from '../src/shared/db';
import { preparePlatformDefaultImageInUs } from '../src/snapshots/builder';

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: bun scripts/prepare-platform-default-us.ts');
    }
    if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for the image release gate');
    const image = await preparePlatformDefaultImageInUs();
    console.log(`[prepare-us] ready: ${image.snapshotName} (${image.contentHash}), template ${image.templateId}, region ${image.region}`);
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error('[prepare-us] failed:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
