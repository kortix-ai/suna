#!/usr/bin/env bun
/**
 * ke2e — Kortix end-to-end REST API test runner.
 *
 *   ke2e run [--domain d] [--id ID] [--tag t] [--grep s] [--workers N]
 *            [--api-workers N] [--sandbox-workers N] [--smoke] [--shard i/N]
 *   ke2e local [same filters] [--no-start]
 *   ke2e list
 *   ke2e coverage
 *   ke2e gc [--older-than 2h] [--run-id ID] [--dry-run]
 *   ke2e report <results.json>
 */
import { resolve } from 'node:path';
import { writeCatalog } from '../src/core/catalog';
import { describeEnv, loadEnv } from '../src/core/env';
import { allFlows } from '../src/core/flow';
import { localEnvironmentOverrides, localRunExitCode } from '../src/core/local-profile';
import {
  type LocalStackHandle,
  type LocalSupabaseHandle,
  ensureLocalMigrations,
  ensureLocalStack,
  ensureLocalSupabase,
  resolveLocalTopology,
} from '../src/core/local-stack';
import { log } from '../src/core/log';
import { renderStepSummary, writeResults } from '../src/core/report';
import { runExitCode } from '../src/core/result';
import { discoverFlows, runSuite } from '../src/core/runner';
import { writeUiData } from '../src/core/ui-data';
import { runCoverage } from '../src/coverage/check-coverage';
import { runGc } from '../src/fixtures/gc';
import { parseShardSpec, planShard } from '../src/core/shard';

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function list(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function newRunId(): string {
  // KE2E_RUN_ID lets the caller PIN the id it will later sweep. The release
  // gate's matrix needs this: each shard must be able to reclaim exactly its
  // own principals in an `if: always()` step, and it cannot guess a random
  // suffix chosen inside this process.
  const pinned = process.env.KE2E_RUN_ID?.trim();
  if (pinned) return pinned;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${process.env.GITHUB_RUN_ID ?? ts}-${r}`;
}

/**
 * Resolve the flow ids belonging to `--shard i/N`.
 *
 * The partition is computed from the live registry (see `src/core/shard.ts`),
 * so every flow lands in exactly one shard and a newly added flow can never
 * fall out of the release gate. `--shard` selects flows on its own; combining
 * it with another selector would intersect two partitions and could silently
 * run nothing, so that is rejected.
 */
async function resolveShardIds(
  value: string,
  conflicting: Array<[string, unknown]>,
): Promise<string[]> {
  const used = conflicting.filter(([, v]) => v !== undefined && v !== false).map(([n]) => n);
  if (used.length > 0) {
    throw new Error(`--shard cannot be combined with ${used.map((n) => `--${n}`).join(', ')}`);
  }
  const spec = parseShardSpec(value);
  await discoverFlows();
  const plan = planShard(allFlows(), spec);
  if (plan.ids.length === 0) {
    throw new Error(`--shard ${value} selected no flows`);
  }
  log.info(
    `shard ${spec.current}/${spec.total}: ${plan.ids.length} flows · ` +
      `projected load ${plan.loads.map((ms) => `${(ms / 60_000).toFixed(0)}m`).join('/')}`,
  );
  return plan.ids;
}

async function main(): Promise<number> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] ?? 'run';

  if (cmd === 'list') {
    await discoverFlows();
    const flows = allFlows().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const f of flows) {
      const t = (f.meta.tags ?? []).join(',');
      console.log(`${f.id.padEnd(12)} ${f.meta.domain.padEnd(16)} ${t}`);
    }
    console.log(`\n${flows.length} flows`);
    return 0;
  }

  if (cmd === 'coverage') {
    const ok = await runCoverage({
      updateBaseline: !!flags['update-baseline'],
      json: !!flags.json,
    });
    return ok ? 0 : 1;
  }

  if (cmd === 'catalog') {
    const out = (flags.out as string) ?? resolve(import.meta.dir, '../test-results/catalog.html');
    const cat = await writeCatalog(out);
    log.info(`catalog → ${out}`);
    log.info(
      `${cat.totalFlows} flows · ${cat.totalSteps} cases · ${cat.totalRoutes} routes · ${cat.domains.length} domains`,
    );
    return 0;
  }

  if (cmd === 'ui-data') {
    const dir = (flags.out as string) ?? resolve(import.meta.dir, '../ui/data');
    const r = await writeUiData(dir);
    log.info(`ui data → ${dir}`);
    log.info(`${r.flows} flows (${r.passed} passed, ${r.skipped} gated/skipped)`);
    return 0;
  }

  if (cmd === 'gc') {
    const runIdFilter = typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined;
    const olderThan = typeof flags['older-than'] === 'string' ? flags['older-than'] : undefined;
    await runGc({
      // Age-only stays the default so `ke2e gc` keeps its old behaviour.
      olderThan: olderThan ?? (runIdFilter ? undefined : '2h'),
      runId: runIdFilter,
      dryRun: !!flags['dry-run'],
    });
    return 0;
  }

  if (cmd === 'report') {
    const file = _[1];
    if (!file) throw new Error('usage: ke2e report <results.json>');
    const jsonPath = resolve(file);
    const data = JSON.parse(await Bun.file(jsonPath).text());
    const out = jsonPath.replace(/\.json$/, '.html');
    writeResults(data, jsonPath, out);
    log.info(`report → ${out}`);
    return 0;
  }

  const localCommand = cmd === 'local';
  let localStack: LocalStackHandle | null = null;
  let localSupabase: LocalSupabaseHandle | null = null;
  try {
    if (localCommand) {
      const root = resolve(import.meta.dir, '../..');
      const topology = resolveLocalTopology(root);
      log.info(
        log.bold(
          `local stack ${topology.worktreeName ? `worktree=${topology.worktreeName}` : 'primary'} ` +
            `api=${topology.apiUrl}`,
        ),
      );
      localSupabase = await ensureLocalSupabase(topology, { autoStart: !flags['no-start'] });
      const supabase = localSupabase.environment;
      await ensureLocalMigrations(topology, supabase);
      localStack = await ensureLocalStack(topology, {
        autoStart: !flags['no-start'],
        supabase,
      });
      Object.assign(
        process.env,
        localEnvironmentOverrides({ worktree: topology.marker, supabase }),
      );
      log.info(
        log.dim(
          localStack.started
            ? 'local stack started by ke2e; it will stop after the run'
            : 'reusing the running local stack',
        ),
      );
    }

    const env = loadEnv();
    const runId = newRunId();
    (globalThis as typeof globalThis & { __KE2E_RUN_ID__: string }).__KE2E_RUN_ID__ = runId;
    // Deployed runs only. `ke2e local` targets a disposable local database, and
    // a developer's Ctrl+C should stay instant rather than wait on a sweep.
    if (!localCommand) installCancellationReclaim(runId);

    const shardIds =
      typeof flags.shard === 'string'
        ? await resolveShardIds(flags.shard, [
            ['id', flags.id],
            ['domain', flags.domain],
            ['tag', flags.tag],
            ['grep', flags.grep],
            ['smoke', flags.smoke],
          ])
        : undefined;
    const outDir = (flags.out as string) ?? resolve(import.meta.dir, '../test-results', runId);
    const gitSha = process.env.GITHUB_SHA ?? (await gitShaLocal());

    log.info(log.bold(`ke2e run ${runId}`));
    log.info(log.dim(describeEnv(env)));

    const result = await runSuite({
      profile: localCommand ? 'local' : 'all',
      ids: shardIds ?? list(flags.id),
      domains: list(flags.domain),
      tags: list(flags.tag),
      grep: typeof flags.grep === 'string' ? flags.grep : undefined,
      workers: flags.workers ? Number(flags.workers) : undefined,
      apiWorkers: flags['api-workers'] ? Number(flags['api-workers']) : undefined,
      sandboxWorkers: flags['sandbox-workers'] ? Number(flags['sandbox-workers']) : undefined,
      smoke: !!flags.smoke,
      runId,
      gitSha,
    });

    const jsonPath = resolve(outDir, 'results.json');
    const htmlPath = resolve(outDir, 'report.html');
    writeResults(result, jsonPath, htmlPath);

    const s = result.summary;
    log.info('');
    log.info(
      `${log.bold('results')}: ${s.passed}/${s.total} passed · ${s.failed} failed · ${s.skipped} skipped · ${s.todo} todo · ${(s.durationMs / 1000).toFixed(1)}s`,
    );
    log.info(log.dim(`report → ${htmlPath}`));

    if (process.env.GITHUB_STEP_SUMMARY) {
      await Bun.write(process.env.GITHUB_STEP_SUMMARY, renderStepSummary(result));
    }

    return localCommand
      ? localRunExitCode(s)
      : runExitCode(s, Boolean(flags['require-all']));
  } finally {
    if (localStack?.started) {
      log.info(log.dim('stopping the local stack started by ke2e'));
      await localStack.stop();
    }
    if (localSupabase?.started) {
      log.info(log.dim('stopping local Supabase started by ke2e'));
      await localSupabase.stop();
    }
  }
}

/**
 * Reclaim this run's principals when the process is cancelled.
 *
 * `runner.ts` tears the world down in a `finally`, which a killed process never
 * reaches — every cancelled GitHub job therefore leaked its whole world. The
 * runner owns the `World` handle and this binary cannot reach it, so the
 * handler reclaims the same thing the world's teardown tail reclaims: every
 * Supabase user named `e2e-<runId>-…` plus the accounts they own (which is what
 * stops their sandboxes). The durable path is still the workflow's
 * `if: always()` sweep step — this is defence in depth inside GitHub's short
 * pre-SIGKILL window, so it is hard-bounded and never blocks exit.
 *
 * The same signal shape the sandbox CI workers already use
 * (`daytona-ci.ts:785-788`, `platinum-ci.ts:1037-1040`).
 */
function installCancellationReclaim(runId: string): void {
  const budgetMs = Number(process.env.KE2E_CANCEL_RECLAIM_MS ?? 20_000);
  let reclaiming = false;
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (reclaiming) return;
    reclaiming = true;
    const code = signal === 'SIGINT' ? 130 : 143;
    if (!(budgetMs > 0)) {
      process.exit(code);
      return;
    }
    log.warn(`${signal}: reclaiming run ${runId} (up to ${(budgetMs / 1000).toFixed(0)}s)`);
    const bail = setTimeout(() => {
      log.warn(`${signal}: reclaim budget exhausted; leaving the rest to the workflow sweep`);
      process.exit(code);
    }, budgetMs);
    bail.unref?.();
    void runGc({ runId, dryRun: false })
      .then(() => log.info(`${signal}: reclaimed run ${runId}`))
      .catch((err) => log.warn(`${signal}: reclaim failed: ${String(err?.message ?? err)}`))
      .finally(() => {
        clearTimeout(bail);
        process.exit(code);
      });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}

async function gitShaLocal(): Promise<string | null> {
  try {
    const p = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe' });
    return (await new Response(p.stdout).text()).trim() || null;
  } catch {
    return null;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(String(err?.stack ?? err));
    process.exitCode = 2;
  });
