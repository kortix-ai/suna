/**
 * Operator: move project Files (drives) to another Platinum region, or purge
 * the old volumes of finished moves. How a move works and why it never loses a
 * file: src/drives/region-move.ts.
 *
 *   dotenvx run -f apps/api/.env.dev -- bun run apps/api/scripts/move-drives-region.ts move --env dev --to us-east [--drive <id>…] [--apply]
 *   dotenvx run -f apps/api/.env.dev -- bun run apps/api/scripts/move-drives-region.ts purge --env dev [--older-than-days 14] [--apply]
 *   dotenvx run -f apps/api/.env.dev -- bun run apps/api/scripts/move-drives-region.ts abort --env dev --drive <id>
 *
 * Without `--apply` it only reads and prints the plan. `--env` must equal the
 * environment the loaded profile names (INTERNAL_KORTIX_ENV), so a profile
 * mix-up cannot move another environment's Files. `move` without `--drive`
 * takes every project drive not in the target region, one at a time, paced
 * far below Platinum's write budget. A drive a running box mounts is skipped
 * and listed; run the command again later for those. `abort` lifts the fence
 * of a move whose process died, and the drive stays where it was.
 */
import { drives } from '@kortix/db';
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { config } from '../src/config';
import { abortDriveMove, moveDriveToRegion, purgeMovedVolumes, type DriveMoveReport, type MoveTarget } from '../src/drives/region-move';
import { db } from '../src/shared/db';

const PACE_MS = 2_000;

function args() {
  const argv = process.argv.slice(2);
  const out = { command: argv[0] ?? '', env: '', to: '' as string, drives: [] as string[], apply: false, olderThanDays: 14 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i] ?? '';
    else if (a === '--to') out.to = argv[++i] ?? '';
    else if (a === '--drive') out.drives.push(argv[++i] ?? '');
    else if (a === '--apply') out.apply = true;
    else if (a === '--older-than-days') out.olderThanDays = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

function line(r: DriveMoveReport): string {
  return `${r.outcome.padEnd(7)} drive ${r.driveId} ${r.from.name}@${r.from.region ?? 'home'} -> ${r.to.name}@${r.to.region ?? 'home'} ` +
    `files=${r.files} dirs=${r.dirs} ${mib(r.bytes)} stopped-box-mounts=${r.detached} ${r.ms}ms${r.reason ? ` (${r.reason})` : ''}`;
}

async function main() {
  const opts = args();
  if (!opts.env || opts.env !== config.INTERNAL_KORTIX_ENV) {
    throw new Error(`--env ${opts.env || '(missing)'} does not match the loaded profile's environment (${config.INTERNAL_KORTIX_ENV})`);
  }
  if (opts.command === 'move') {
    if (!opts.to) throw new Error('--to <region|home> is required');
    const to: MoveTarget = opts.to === 'home' ? null : opts.to;
    if (to !== null && !/^[a-z]{2,8}-[a-z]{2,12}$/.test(to)) throw new Error(`--to ${opts.to} is not a region key`);
    const ids = opts.drives.length
      ? opts.drives
      : (await db
          .select({ driveId: drives.driveId })
          .from(drives)
          .where(and(
            eq(drives.kind, 'project'),
            to === null ? isNotNull(drives.platinumVolumeRegion) : or(isNull(drives.platinumVolumeRegion), ne(drives.platinumVolumeRegion, to)),
          ))
          .orderBy(sql`${drives.createdAt}`)).map((r) => r.driveId);
    console.log(`[move] ${ids.length} drive(s) -> ${to ?? 'home'}${opts.apply ? '' : ' (plan only; add --apply to move)'}`);
    const reports: DriveMoveReport[] = [];
    for (const id of ids) {
      const r = await moveDriveToRegion(id, to, { apply: opts.apply });
      reports.push(r);
      console.log(line(r));
      if (opts.apply && r.outcome === 'moved') await Bun.sleep(PACE_MS);
    }
    const by = (o: DriveMoveReport['outcome']) => reports.filter((r) => r.outcome === o);
    console.log(
      `[move] planned=${by('planned').length} moved=${by('moved').length} skipped=${by('skipped').length} failed=${by('failed').length} ` +
        `files=${reports.reduce((n, r) => n + r.files, 0)} ${mib(reports.reduce((n, r) => n + r.bytes, 0))}`,
    );
    if (by('failed').length) process.exitCode = 1;
    return;
  }
  if (opts.command === 'purge') {
    if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays < 1) throw new Error('--older-than-days must be at least 1');
    const reports = await purgeMovedVolumes({ olderThanMs: opts.olderThanDays * 24 * 3600_000, apply: opts.apply });
    for (const r of reports) console.log(`${r.outcome.padEnd(7)} drive ${r.driveId} ${r.volume.name}@${r.volume.region ?? 'home'}${r.reason ? ` (${r.reason})` : ''}`);
    console.log(`[purge] ${reports.filter((r) => r.outcome === 'purged').length} purged, ${reports.filter((r) => r.outcome === 'kept').length} kept${opts.apply ? '' : ' (plan only; add --apply to delete)'}`);
    return;
  }
  if (opts.command === 'abort') {
    if (!opts.drives.length) throw new Error('--drive <id> is required');
    for (const id of opts.drives) console.log(`[abort] drive ${id}: ${await abortDriveMove(id)}`);
    return;
  }
  throw new Error('usage: move-drives-region.ts move|purge|abort --env <env> …');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
