/**
 * Probe: does the Daytona *ad-hoc* declarative build path (create-from-image)
 * consume the org-wide named-snapshot quota (the 100/org hard cap), or only the
 * per-runner build cache?
 *
 * This is the single unknown gating a migration away from pre-built named
 * snapshots (`daytona.snapshot.create` + create-from-snapshot, what the builder
 * does today — see src/snapshots/builder.ts) toward ad-hoc
 * `daytona.create({ image })` for the long tail of projects. The declarative-
 * builder docs say on-the-fly images are 24h-cached per runner and not named
 * snapshots; they do NOT state whether they still tick the org cap. We measure.
 *
 *   cd apps/api && bun run scripts/probe-adhoc-snapshot-quota.ts
 *
 * Env knobs:
 *   COUNT=3                 how many ad-hoc sandboxes to spin up (same image,
 *                           so #2..N exercise the build cache)
 *   CLEANUP_SNAPSHOTS=1     also best-effort delete any snapshot that appeared
 *                           during the run (default: report only, don't delete)
 *
 * What it does:
 *   1. Snapshot the full set of Daytona snapshots (before).
 *   2. Create N sandboxes via the ad-hoc image path, timing each (cold build
 *      vs warm cache hit shows up here).
 *   3. Re-list snapshots → report anything that appeared while sandboxes lived.
 *   4. Delete the N sandboxes.
 *   5. Re-list once more → report whether sandbox deletion reaped any snapshot.
 *
 * Interpretation:
 *   - Snapshot count FLAT across all phases → ad-hoc does NOT touch the named
 *     quota → green-light the migration.
 *   - Snapshot count CLIMBS (and stays up) → ad-hoc charges the cap internally
 *     → the only real lever is a quota increase. Premise collapses.
 */
import { Image } from '@daytonaio/sdk';
import {
  getDaytona,
  isDaytonaConfigured,
  listDaytonaSnapshots,
  deleteDaytonaSnapshotById,
  type DaytonaSnapshotSummary,
} from '../src/shared/daytona';

const COUNT = Math.max(1, Number.parseInt(process.env.COUNT || '3', 10) || 3);
const CLEANUP_SNAPSHOTS = process.env.CLEANUP_SNAPSHOTS === '1';

function fmt(s: DaytonaSnapshotSummary): string {
  return `    ${s.name}  [${s.state}]  id=${s.id}`;
}

async function listOrThrow(label: string): Promise<Map<string, DaytonaSnapshotSummary>> {
  const list = await listDaytonaSnapshots();
  const kortixSnap = list.filter((s) => s.name.startsWith('kortix-snap-')).length;
  console.log(
    `  [${label}] total snapshots: ${list.length}  (kortix-snap-* named: ${kortixSnap})`,
  );
  return new Map(list.map((s) => [s.id, s]));
}

function diff(
  before: Map<string, DaytonaSnapshotSummary>,
  after: Map<string, DaytonaSnapshotSummary>,
): { appeared: DaytonaSnapshotSummary[]; vanished: DaytonaSnapshotSummary[] } {
  const appeared = [...after.values()].filter((s) => !before.has(s.id));
  const vanished = [...before.values()].filter((s) => !after.has(s.id));
  return { appeared, vanished };
}

async function main() {
  if (!isDaytonaConfigured()) {
    console.error('DAYTONA_API_KEY not set (check apps/api/.env). Aborting.');
    process.exit(1);
  }

  const daytona = getDaytona();
  const runId = `adhoc-probe-${Date.now().toString(36)}`;
  console.log(`\n=== Ad-hoc declarative-build snapshot-quota probe (${runId}) ===`);
  console.log(`Creating ${COUNT} sandbox(es) from the same ad-hoc image.\n`);

  // A tiny image with one real RUN layer so it genuinely *builds* (not just a
  // registry pull). runId is baked in so the build is cold for create #1 of THIS
  // run; #2..N reuse the same Dockerfile and should hit the per-runner cache.
  const image = Image.base('ubuntu:24.04').dockerfileCommands([
    `RUN echo "kortix ad-hoc probe ${runId}" > /etc/kortix-probe`,
  ]);

  const before = await listOrThrow('before');

  const createdIds: string[] = [];
  for (let i = 1; i <= COUNT; i++) {
    const t = Date.now();
    try {
      const sandbox = await daytona.create(
        {
          image,
          labels: { 'kortix-adhoc-probe': runId },
          autoStopInterval: 5,
          public: false,
        },
        {
          timeout: 300,
          onSnapshotCreateLogs: (chunk) => {
            const line = chunk.trim();
            if (line) console.log(`      build#${i}> ${line}`);
          },
        },
      );
      createdIds.push(sandbox.id);
      console.log(
        `  create #${i}: ${((Date.now() - t) / 1000).toFixed(1)}s  (sandbox ${sandbox.id}, state=${sandbox.state})`,
      );
    } catch (err) {
      console.error(
        `  create #${i} FAILED after ${((Date.now() - t) / 1000).toFixed(1)}s:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log('');
  const during = await listOrThrow('after creates (sandboxes still live)');
  const d1 = diff(before, during);
  if (d1.appeared.length) {
    console.log(`  ⚠️  ${d1.appeared.length} snapshot(s) APPEARED during the run:`);
    d1.appeared.forEach((s) => console.log(fmt(s)));
  } else {
    console.log('  ✅ no new snapshots appeared while ad-hoc sandboxes were live.');
  }

  // Tear down the sandboxes we created.
  console.log(`\n  Deleting ${createdIds.length} probe sandbox(es)...`);
  for (const id of createdIds) {
    try {
      const sb = await daytona.get(id);
      await daytona.delete(sb);
      console.log(`    deleted sandbox ${id}`);
    } catch (err) {
      console.warn(`    failed to delete sandbox ${id}:`, err instanceof Error ? err.message : err);
    }
  }

  // Give Daytona a beat to reap any snapshot tied to a deleted sandbox.
  await new Promise((r) => setTimeout(r, 3000));
  console.log('');
  const after = await listOrThrow('after sandbox deletion');
  const d2 = diff(before, after);

  console.log('\n=== Verdict ===');
  if (d2.appeared.length === 0) {
    console.log('  ✅ Snapshot count returned to baseline. Ad-hoc builds do NOT');
    console.log('     leave named snapshots behind → they do not consume the');
    console.log('     org named-snapshot quota. Safe to migrate the long tail.');
  } else {
    console.log(`  ⚠️  ${d2.appeared.length} snapshot(s) PERSIST after sandbox deletion:`);
    d2.appeared.forEach((s) => console.log(fmt(s)));
    console.log('     → ad-hoc builds DO materialize lingering snapshots. Confirm');
    console.log('       with Daytona whether these tick the 100/org cap before');
    console.log('       migrating; if they do, the premise collapses.');
    if (CLEANUP_SNAPSHOTS) {
      console.log('\n  CLEANUP_SNAPSHOTS=1 → deleting the persisted snapshots...');
      for (const s of d2.appeared) {
        const ok = await deleteDaytonaSnapshotById(s.id);
        console.log(`    ${ok ? 'deleted' : 'FAILED  '} ${s.name} (${s.id})`);
      }
    } else {
      console.log('\n  (re-run with CLEANUP_SNAPSHOTS=1 to delete them, or remove in the dashboard.)');
    }
  }
  if (d2.vanished.length) {
    console.log(`\n  note: ${d2.vanished.length} pre-existing snapshot(s) vanished during the run (likely unrelated reconciliation).`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
