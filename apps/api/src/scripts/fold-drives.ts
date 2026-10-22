/**
 * Fold the earlier personal, company and agent drives into each project's
 * Files (see drives/fold.ts for what lands where and with which access).
 *
 *   bun run src/scripts/fold-drives.ts --plan [--account <id>]   # print targets, change nothing
 *   bun run src/scripts/fold-drives.ts [--account <id>]          # copy + grant; safe to re-run
 *   bun run src/scripts/fold-drives.ts --retire [--account <id>] # delete source rows every target finished
 *
 * The copy never overwrites a file already at the destination and writes a
 * marker per (source, project), so an interrupted run resumes where it
 * stopped. Source volumes are deleted only by --retire, through the drives
 * delete trigger and the volume cleanup worker.
 */

import { drives } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { foldAll, foldTargets, retireFolded } from '../drives/fold';
import { db } from '../shared/db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const accountId = arg('--account');
  if (process.argv.includes('--plan')) {
    const sources = await db
      .select()
      .from(drives)
      .where(and(inArray(drives.kind, ['personal', 'company', 'agent']), accountId ? eq(drives.accountId, accountId) : undefined));
    for (const s of sources) {
      for (const t of await foldTargets(s)) {
        console.log(
          `${s.kind.padEnd(8)} ${s.driveId} "${s.name}" -> project ${t.projectId} ${t.path || '/Users/<owner>'}  grants: ${t.grants.map((g) => `${g.principal.type}:${g.principal.id}=${g.level}`).join(', ') || '-'}`,
        );
      }
    }
    return;
  }
  if (process.argv.includes('--retire')) {
    const retired = await retireFolded({ accountId });
    console.log(`retired ${retired.length} source drive(s); their volumes are queued for deletion`);
    return;
  }
  const reports = await foldAll({
    accountId,
    log: (r) =>
      console.log(
        `${r.kind.padEnd(8)} ${r.source} -> ${r.projectId || '-'} ${r.path || '-'}  ${r.skipped ?? `copied ${r.copied}, kept ${r.kept}, grants ${r.grants}`}`,
      ),
  });
  console.log(`done: ${reports.length} target(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
