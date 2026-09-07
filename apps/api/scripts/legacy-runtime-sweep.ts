/**
 * Operator sweep: converge sandboxes whose daemon predates runtime convergence.
 *
 *   dotenvx run -f apps/api/.env.prod -- bun run apps/api/scripts/legacy-runtime-sweep.ts --session <id> [--session <id>…] [--force] [--dry-run]
 *   dotenvx run -f apps/api/.env.prod -- bun run apps/api/scripts/legacy-runtime-sweep.ts --running [--limit 20] [--dry-run]
 *
 * `--dry-run` classifies (health probe) and prints, never execs.
 * Runs the same code path the reaper schedules; the only difference is that
 * an operator asks for the truth now (`--force` skips the 6 h recent-check TTL).
 */
import { sessionSandboxes } from '@kortix/db';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../src/shared/db';
import {
  buildLegacyBootstrapDeps,
  runLegacyRuntimeBootstrap,
  type LegacyBootstrapRow,
} from '../src/projects/lib/legacy-runtime-bootstrap-wiring';
import { classifyDaemonHealth } from '../src/projects/lib/legacy-runtime-bootstrap';

function args() {
  const out: { sessions: string[]; running: boolean; limit: number; force: boolean; dryRun: boolean } = {
    sessions: [],
    running: false,
    limit: 20,
    force: false,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') out.sessions.push(argv[++i]);
    else if (a === '--running') out.running = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown arg ${a}`);
  }
  return out;
}

async function main() {
  const opts = args();
  const projection = {
    sandboxId: sessionSandboxes.sandboxId,
    sessionId: sessionSandboxes.sessionId,
    accountId: sessionSandboxes.accountId,
    projectId: sessionSandboxes.projectId,
    provider: sessionSandboxes.provider,
    externalId: sessionSandboxes.externalId,
    metadata: sessionSandboxes.metadata,
    status: sessionSandboxes.status,
    lastUsedAt: sessionSandboxes.lastUsedAt,
  };
  const rows = opts.sessions.length
    ? await db.select(projection).from(sessionSandboxes).where(inArray(sessionSandboxes.sessionId, opts.sessions))
    : await db
        .select(projection)
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.status, 'active'),
            isNotNull(sessionSandboxes.externalId),
            gt(sessionSandboxes.lastUsedAt, new Date(Date.now() - 7 * 24 * 3600 * 1000)),
          ),
        )
        .limit(opts.limit);
  console.log(`[sweep] ${rows.length} sandbox row(s)${opts.dryRun ? ' (dry run)' : ''}`);
  for (const r of rows) {
    if (!r.externalId) continue;
    const row: LegacyBootstrapRow = {
      sandboxId: r.sandboxId,
      sessionId: r.sessionId,
      accountId: r.accountId,
      projectId: r.projectId,
      provider: r.provider,
      externalId: r.externalId,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    };
    const label = `${r.sessionId} ${r.provider}/${r.externalId} status=${r.status}`;
    if (opts.dryRun) {
      const deps = buildLegacyBootstrapDeps(row);
      const c = classifyDaemonHealth(await deps.fetchHealth());
      const status = c.klass === 'legacy' ? await deps.fetchOpencodeStatus() : null;
      console.log(`[sweep] ${label} → ${c.klass} build=${c.runtimeBuild ?? '-'} opencode=${c.opencode ?? '-'}${c.klass === 'legacy' ? ` idle=${status ? Object.keys(status).length === 0 : 'unknown'}` : ''}`);
      continue;
    }
    const started = Date.now();
    try {
      const result = await runLegacyRuntimeBootstrap(row, 'sweep', { force: opts.force });
      console.log(`[sweep] ${label} → ${result.outcome}${result.detail ? ` (${result.detail})` : ''} in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      console.log(`[sweep] ${label} → threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sweep] failed:', err);
    process.exit(1);
  });
