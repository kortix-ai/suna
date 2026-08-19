import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL_AUTH_EMAIL_HOOK_SECRET, localWebUrl } from './local-profile';
import {
  type LocalStackHandle,
  type LocalSupabaseHandle,
  assertLoopbackHttpUrl,
  ensureLocalMigrations,
  ensureLocalStack,
  ensureLocalSupabase,
  ensureLocalWeb,
  readLocalSupabaseEnvironment,
  resolveLocalTopology,
} from './local-stack';
import { assertTargetSmokeHealth, resolveTargetSmokeConfig } from './target-smoke';

export interface LocalTestLane {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface LocalTestPlan {
  mode:
    | 'core'
    | 'flows'
    | 'sdk'
    | 'browser'
    | 'packages'
    | 'target'
    | 'target-full'
    | 'target-api-full'
    | 'target-browser-full'
    | 'full';
  lanes: LocalTestLane[];
  stages: LocalTestLane[][];
}

/** Modes that assert the deployed target's health and SHA before running. */
const DEPLOYED_TARGET_MODES = new Set<LocalTestPlan['mode']>([
  'target',
  'target-full',
  'target-api-full',
  'target-browser-full',
]);

/**
 * Per-flow wall-clock floor for every lane that runs against a DEPLOYED target.
 *
 * The runner's own default is 120 s (`flow.ts:DEFAULT_FLOW_TIMEOUT_MS`), sized
 * for the local stack. A deployed target is a different machine: every request
 * crosses Cloudflare and a live ALB, and sandbox-backed flows provision real
 * cloud VMs. Run 32231251280 lost roughly half its flows to
 * `flow X exceeded 120000ms` on staging for that reason alone.
 *
 * 180 s is a FLOOR, not an override — `flow.ts:resolveFlowTimeoutMs` keeps any
 * larger declared `meta.timeoutMs` (session and CLI flows declare 300 s–20 min).
 * It lives here, not in `tests-release.yml`, so every caller of
 * `--target-smoke` / `--target-api-full` / `--target-full` inherits it and no
 * workflow has to know the number.
 */
export const DEPLOYED_FLOW_TIMEOUT_MS = '180000';

function deployedFlowTimeoutMs(): string {
  const override = process.env.KE2E_FLOW_TIMEOUT_MS;
  return override === undefined || override === '' ? DEPLOYED_FLOW_TIMEOUT_MS : override;
}

const flowFilterFlags = new Set(['--domain', '--id', '--tag', '--smoke']);

function hasFlowFilter(args: string[]): boolean {
  return args.some((arg) => {
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    return flowFilterFlags.has(name);
  });
}

function assertShardValue(value: string | undefined, flag: string): void {
  const match = value?.match(/^(\d+)\/(\d+)$/);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || total < 2 || current > total) {
    throw new Error(`${flag} must use CURRENT/TOTAL with 1 <= CURRENT <= TOTAL`);
  }
}

export function buildLocalTestPlan(args: string[]): LocalTestPlan {
  const full = args.includes('--full');
  const flowsOnly = args.includes('--flows-only') || hasFlowFilter(args);
  const sdkOnly = args.includes('--sdk-only');
  const browserOnly = args.includes('--browser-only');
  const packagesOnly = args.includes('--packages-only');
  const targetSmoke = args.includes('--target-smoke');
  const targetFull = args.includes('--target-full');
  // The release gate runs the two deployed lanes as SEPARATE GitHub jobs, each
  // sharded, so `max(api, browser)` replaces a contended sum on one 2-vCPU
  // runner. `--target-full` still runs both lanes in one process for
  // deploy-preview (one sandbox origin, one job by construction) and local use.
  const targetApiFullOnly = args.includes('--target-api-full');
  const targetBrowserFullOnly = args.includes('--target-browser-full');
  const browserShardArgs = args.filter((arg) => arg.startsWith('--browser-shard='));
  const apiShardArgs = args.filter((arg) => arg.startsWith('--api-shard='));
  const modes = [
    full,
    flowsOnly,
    sdkOnly,
    browserOnly,
    packagesOnly,
    targetSmoke,
    targetFull,
    targetApiFullOnly,
    targetBrowserFullOnly,
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new Error(
      'choose only one of --full, --flows-only, --sdk-only, --browser-only, --packages-only, --target-smoke, --target-full, --target-api-full, or --target-browser-full',
    );
  }
  if (browserShardArgs.length > 1) {
    throw new Error('choose only one --browser-shard value');
  }
  if (apiShardArgs.length > 1) {
    throw new Error('choose only one --api-shard value');
  }
  const browserShard = browserShardArgs[0]?.slice('--browser-shard='.length);
  if (browserShardArgs.length === 1) {
    assertShardValue(browserShard, '--browser-shard');
    if (!browserOnly && !targetBrowserFullOnly) {
      throw new Error('--browser-shard requires --browser-only or --target-browser-full');
    }
  }
  const apiShard = apiShardArgs[0]?.slice('--api-shard='.length);
  if (apiShardArgs.length === 1) {
    assertShardValue(apiShard, '--api-shard');
    if (!targetApiFullOnly) {
      throw new Error('--api-shard requires --target-api-full');
    }
  }

  const flowArgs = args.filter(
    (arg) =>
      arg !== '--full' &&
      arg !== '--flows-only' &&
      arg !== '--sdk-only' &&
      arg !== '--browser-only' &&
      arg !== '--packages-only' &&
      arg !== '--target-smoke' &&
      arg !== '--target-full' &&
      arg !== '--target-api-full' &&
      arg !== '--target-browser-full' &&
      !arg.startsWith('--browser-shard=') &&
      !arg.startsWith('--api-shard='),
  );
  const flows: LocalTestLane = {
    name: 'api-cli-flows',
    command: ['bun', 'tests/bin/ke2e.ts', 'local', ...flowArgs],
  };
  const sdk: LocalTestLane = {
    name: 'sdk',
    command: ['pnpm', '--filter', '@kortix/sdk', 'test'],
  };
  const runnerUnit: LocalTestLane = {
    name: 'flow-runner-unit',
    command: ['pnpm', '--dir', 'tests', 'test:unit'],
  };
  const routeCoverage: LocalTestLane = {
    name: 'route-coverage',
    command: ['bun', 'tests/bin/ke2e.ts', 'coverage'],
  };
  const worktreeUnit: LocalTestLane = {
    name: 'worktree-unit',
    command: ['bun', 'test', 'scripts/worktree/__tests__/'],
  };
  const browser: LocalTestLane = {
    name: 'browser',
    command: [
      'bun',
      'run',
      'test:browser',
      ...(browserShard ? ['--', `--shard=${browserShard}`] : []),
    ],
    cwd: 'tests',
  };
  const packageQuality: LocalTestLane = {
    name: 'package-quality',
    command: ['bun', 'tests/bin/package-quality.ts'],
  };
  const targetApi: LocalTestLane = {
    name: 'target-api-smoke',
    command: ['bun', 'tests/bin/ke2e.ts', 'run', '--smoke'],
    env: { KE2E_FLOW_TIMEOUT_MS: deployedFlowTimeoutMs() },
  };
  const targetBrowser: LocalTestLane = {
    name: 'target-browser-smoke',
    command: ['bun', 'run', 'test:browser', '--', '--grep', '@target-smoke'],
    cwd: 'tests',
    env: { E2E_BROWSER_WORKERS: '1' },
  };
  const targetApiFull: LocalTestLane = {
    name: 'target-api-full',
    command: [
      'bun',
      'tests/bin/ke2e.ts',
      'run',
      '--require-all',
      ...(apiShard ? ['--shard', apiShard] : []),
    ],
    // KE2E_API_WORKERS was 3. `provision.ts`'s global KE2E_PROVISION_CONCURRENCY
    // semaphore — not the worker count — is the real ceiling, so 3 workers left
    // measured parallelism at 1.43x. 6 is the paired half of raising provision
    // concurrency to 4; raising either alone does almost nothing. Sandbox
    // workers stay at 3 because those boot real cloud sandboxes.
    // The release gate's shards override BOTH so the fleet total stays bounded
    // — see the arithmetic in tests-release.yml.
    env: {
      KE2E_API_WORKERS: process.env.KE2E_API_WORKERS ?? '6',
      KE2E_SANDBOX_WORKERS: process.env.KE2E_SANDBOX_WORKERS ?? '3',
      KE2E_FLOW_TIMEOUT_MS: deployedFlowTimeoutMs(),
    },
  };
  const targetBrowserFull: LocalTestLane = {
    name: 'target-browser-full',
    command: [
      'bun',
      'run',
      'test:browser',
      ...(browserShard ? ['--', `--shard=${browserShard}`] : []),
    ],
    cwd: 'tests',
    env: {
      E2E_BROWSER_WORKERS: process.env.E2E_BROWSER_WORKERS ?? '2',
      E2E_ENABLE_SDK_ONLY_SESSION: '1',
      E2E_ENABLE_SANDBOX_TEMPLATE_BUILD: '1',
      E2E_OAUTH_PROVIDER_INITIATION: process.env.KE2E_TARGET === 'preview' ? '0' : '1',
      E2E_ENABLE_BILLING_JOURNEY: '1',
      E2E_REQUIRE_ALL_BROWSER: '1',
      ...(process.env.KE2E_TARGET === 'preview'
        ? { E2E_ALLOW_PREVIEW_OAUTH_EXCLUSION: '1' }
        : {}),
    },
  };

  if (flowsOnly) return { mode: 'flows', lanes: [flows], stages: [[flows]] };
  if (sdkOnly) return { mode: 'sdk', lanes: [sdk], stages: [[sdk]] };
  if (browserOnly) return { mode: 'browser', lanes: [browser], stages: [[browser]] };
  if (packagesOnly) {
    return { mode: 'packages', lanes: [packageQuality], stages: [[packageQuality]] };
  }
  if (targetSmoke) {
    const lanes = [targetApi, targetBrowser];
    return { mode: 'target', lanes, stages: [lanes] };
  }
  if (targetApiFullOnly) {
    return { mode: 'target-api-full', lanes: [targetApiFull], stages: [[targetApiFull]] };
  }
  if (targetBrowserFullOnly) {
    return {
      mode: 'target-browser-full',
      lanes: [targetBrowserFull],
      stages: [[targetBrowserFull]],
    };
  }
  if (targetFull) {
    // Lanes run CONCURRENTLY (one stage). A serialize experiment was tried to
    // fix RUN-*/SESS-* "session runtime ready" timeouts, but that was a
    // MISDIAGNOSIS: the flow lane ALONE (serialized, browser idle) still timed
    // out, and a live probe showed staging session-provisioning was in a
    // transient ~2h outage during that window (sessions stuck 'provisioning',
    // never reaching a sandbox). When staging is healthy a fresh session reaches
    // 'running' in ~21s, so both lanes provision fine concurrently (as they did
    // before the outage). Concurrent keeps the run ~75m within the 90m cap and
    // the 2h token lifetime. If staging provisioning is genuinely down, the gate
    // SHOULD fail — that's a real staging outage, not a test defect.
    const lanes = [targetApiFull, targetBrowserFull];
    return { mode: 'target-full', lanes, stages: [lanes] };
  }
  if (full) {
    const fullFlows: LocalTestLane = {
      ...flows,
      command: [...flows.command, '--api-workers', '4'],
    };
    const fullBrowser: LocalTestLane = { ...browser };
    const fullPackageQuality: LocalTestLane = {
      ...packageQuality,
      // Full mode runs the SDK as a named lane. Keep package-only mode complete,
      // but do not execute the same SDK tests twice inside one full run.
      env: { KORTIX_PACKAGE_SKIP_SDK_TESTS: '1' },
    };
    const lanes = [
      fullFlows,
      sdk,
      runnerUnit,
      routeCoverage,
      worktreeUnit,
      fullBrowser,
      fullPackageQuality,
    ];
    return {
      mode: 'full',
      lanes,
      // Four REST workers and four browsers contend for the same local API and
      // database. Keep browser verification after REST. Package quality stays
      // exclusive because concurrent package workers double both lane times.
      stages: [
        [fullFlows, sdk, runnerUnit, routeCoverage, worktreeUnit],
        [fullBrowser],
        [fullPackageQuality],
      ],
    };
  }
  const lanes = [flows, sdk, runnerUnit, routeCoverage, worktreeUnit];
  return {
    mode: 'core',
    lanes,
    stages: [lanes],
  };
}

interface LaneResult {
  name: string;
  command: string[];
  exitCode: number;
  durationMs: number;
}

export async function waitForLocalWeb(
  webUrl: string,
  options: {
    timeoutMs?: number;
    probe?: (url: string) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const checkedWebUrl = assertLoopbackHttpUrl(webUrl, 'local web').toString();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const probe =
    options.probe ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5_000) }));
  const sleep = options.sleep ?? Bun.sleep;
  do {
    try {
      const response = await probe(checkedWebUrl);
      if (response.ok) return;
    } catch {
      // The dev server can accept connections before its first route compiles.
    }
    await sleep(250);
  } while (performance.now() < deadline);
  throw new Error(`local web is not ready at ${webUrl} after ${timeoutMs}ms`);
}

async function runLane(root: string, lane: LocalTestLane): Promise<LaneResult> {
  const startedAt = performance.now();
  console.log(`\n[test] START ${lane.name}: ${lane.command.join(' ')}`);
  try {
    // Every lane can sign a Supabase auth-hook request: the local stack starts
    // the API with this same fixed secret (see local-stack.ts).
    // Widened explicitly: lanes append their own E2E_*/KE2E_* keys below, and
    // the inferred literal type would reject any key not present here (TS2353).
    let env: Record<string, string | undefined> = {
      ...process.env,
      KE2E_AUTH_EMAIL_HOOK_SECRET: LOCAL_AUTH_EMAIL_HOOK_SECRET,
      ...(lane.env ?? {}),
    };
    if (lane.name === 'browser') {
      const topology = resolveLocalTopology(root);
      const supabase = await readLocalSupabaseEnvironment(topology);
      const webPort = topology.marker?.ports.web ?? 3000;
      const webUrl = localWebUrl(webPort);
      await waitForLocalWeb(webUrl);
      if (
        !supabase.API_URL ||
        !supabase.DB_URL ||
        !supabase.ANON_KEY ||
        !supabase.SERVICE_ROLE_KEY
      ) {
        throw new Error('local Supabase environment is incomplete');
      }
      env = {
        ...env,
        E2E_BASE_URL: webUrl,
        E2E_API_URL: topology.apiUrl,
        E2E_SUPABASE_URL: supabase.API_URL,
        E2E_MAILPIT_URL: supabase.MAILPIT_URL ?? '',
        E2E_DATABASE_URL: supabase.DB_URL,
        KE2E_DATABASE_URL: supabase.DB_URL,
        DATABASE_URL: supabase.DB_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
      };
    } else if (lane.name === 'target-browser-full') {
      const required = [
        'KE2E_API_URL',
        'KE2E_SUPABASE_URL',
        'KE2E_SUPABASE_ANON_KEY',
        'KE2E_SUPABASE_SERVICE_ROLE_KEY',
        'KE2E_DATABASE_URL',
        'KE2E_STRIPE_SECRET_KEY',
        'KE2E_STRIPE_WEBHOOK_SECRET',
      ] as const;
      const missing = required.filter((name) => !process.env[name]?.trim());
      if (
        !process.env.E2E_AGENTMAIL_API_KEY?.trim() &&
        !process.env.E2E_MAILPIT_URL?.trim()
      ) {
        missing.push('E2E_AGENTMAIL_API_KEY or E2E_MAILPIT_URL' as never);
      }
      if (missing.length > 0) {
        throw new Error(`deployed browser suite requires ${missing.join(', ')}`);
      }
      const targetApiUrl = process.env.KE2E_API_URL ?? '';
      const targetSupabaseUrl = process.env.KE2E_SUPABASE_URL ?? '';
      const targetDatabaseUrl = process.env.KE2E_DATABASE_URL ?? '';
      const targetSupabaseAnonKey = process.env.KE2E_SUPABASE_ANON_KEY ?? '';
      const targetSupabaseServiceRoleKey = process.env.KE2E_SUPABASE_SERVICE_ROLE_KEY ?? '';
      env = {
        ...env,
        E2E_API_URL: targetApiUrl,
        E2E_SUPABASE_URL: targetSupabaseUrl,
        E2E_DATABASE_URL: targetDatabaseUrl,
        DATABASE_URL: targetDatabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: targetSupabaseAnonKey,
        SUPABASE_SERVICE_ROLE_KEY: targetSupabaseServiceRoleKey,
      };
    }
    const child = Bun.spawn(lane.command, {
      cwd: lane.cwd ? resolve(root, lane.cwd) : root,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    const durationMs = performance.now() - startedAt;
    console.log(
      `[test] ${exitCode === 0 ? 'PASS' : 'FAIL'} ${lane.name} ${(durationMs / 1000).toFixed(1)}s`,
    );
    return { ...lane, exitCode, durationMs };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    console.error(
      `[test] FAIL ${lane.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ...lane, exitCode: 1, durationMs };
  }
}

export async function runLocalTests(root: string, args: string[]): Promise<number> {
  const plan = buildLocalTestPlan(args);
  const startedAt = performance.now();
  let localSupabase: LocalSupabaseHandle | null = null;
  let localStack: LocalStackHandle | null = null;
  let localWeb: LocalStackHandle | null = null;
  console.log(`[test] mode=${plan.mode} lanes=${plan.lanes.map((lane) => lane.name).join(',')}`);
  const results: LaneResult[] = [];
  try {
    if (DEPLOYED_TARGET_MODES.has(plan.mode)) {
      const target = resolveTargetSmokeConfig();
      await assertTargetSmokeHealth(target);
      console.log(
        `[test] deployed-target api=${target.apiUrl} web=${target.webUrl} sha=${target.expectedSha}`,
      );
    }
    if (plan.mode === 'browser' || plan.mode === 'full') {
      const topology = resolveLocalTopology(root);
      localSupabase = await ensureLocalSupabase(topology, { autoStart: true });
      await ensureLocalMigrations(topology, localSupabase.environment);
      localStack = await ensureLocalStack(topology, {
        autoStart: true,
        supabase: localSupabase.environment,
      });
      localWeb = await ensureLocalWeb(topology, {
        autoStart: true,
        supabase: localSupabase.environment,
      });
      console.log(
        `[test] product-stack api=${localStack.started ? 'started' : 'reused'} web=${localWeb.started ? 'started' : 'reused'}`,
      );
    }

    for (const [index, stage] of plan.stages.entries()) {
      console.log(
        `[test] stage=${index + 1}/${plan.stages.length} lanes=${stage.map((lane) => lane.name).join(',')}`,
      );
      results.push(...(await Promise.all(stage.map((lane) => runLane(root, lane)))));
      if (plan.mode === 'full' && stage.some((lane) => lane.name === 'browser')) {
        if (localWeb?.started) await localWeb.stop();
        if (localStack?.started) await localStack.stop();
        if (localSupabase?.started) await localSupabase.stop();
        localWeb = null;
        localStack = null;
        localSupabase = null;
        console.log('[test] product-stack stopped before package-quality');
      }
    }
  } finally {
    if (localWeb?.started) await localWeb.stop();
    if (localStack?.started) await localStack.stop();
    if (localSupabase?.started) await localSupabase.stop();
  }
  const durationMs = performance.now() - startedAt;
  const failed = results.filter((result) => result.exitCode !== 0);
  const benchmark = {
    gitSha: (await Bun.$`git rev-parse --short=10 HEAD`.cwd(root).quiet().text()).trim(),
    mode: plan.mode,
    durationMs,
    passed: results.length - failed.length,
    failed: failed.length,
    lanes: results,
  };
  const outputDir = resolve(root, 'tests/test-results/local');
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `benchmark-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`);

  console.log(
    `\n[test] ${failed.length === 0 ? 'PASS' : 'FAIL'} ${plan.mode} ${(durationMs / 1000).toFixed(1)}s`,
  );
  for (const result of results) {
    console.log(
      `[test] ${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${result.name} ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(`[test] benchmark ${outputPath}`);
  return failed.length === 0 ? 0 : 1;
}
