import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localWebUrl } from './local-profile';
import {
  type LocalStackHandle,
  type LocalSupabaseHandle,
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
  mode: 'core' | 'flows' | 'sdk' | 'browser' | 'packages' | 'target' | 'full';
  lanes: LocalTestLane[];
  stages: LocalTestLane[][];
}

const flowFilterFlags = new Set(['--domain', '--id', '--tag', '--smoke']);

function hasFlowFilter(args: string[]): boolean {
  return args.some((arg) => {
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    return flowFilterFlags.has(name);
  });
}

export function buildLocalTestPlan(args: string[]): LocalTestPlan {
  const full = args.includes('--full');
  const flowsOnly = args.includes('--flows-only') || hasFlowFilter(args);
  const sdkOnly = args.includes('--sdk-only');
  const browserOnly = args.includes('--browser-only');
  const packagesOnly = args.includes('--packages-only');
  const targetSmoke = args.includes('--target-smoke');
  const modes = [full, flowsOnly, sdkOnly, browserOnly, packagesOnly, targetSmoke].filter(
    Boolean,
  ).length;
  if (modes > 1) {
    throw new Error(
      'choose only one of --full, --flows-only, --sdk-only, --browser-only, --packages-only, or --target-smoke',
    );
  }

  const flowArgs = args.filter(
    (arg) =>
      arg !== '--full' &&
      arg !== '--flows-only' &&
      arg !== '--sdk-only' &&
      arg !== '--browser-only' &&
      arg !== '--packages-only' &&
      arg !== '--target-smoke',
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
    command: ['bun', 'run', 'test:browser'],
    cwd: 'tests',
  };
  const packageQuality: LocalTestLane = {
    name: 'package-quality',
    command: ['bun', 'tests/bin/package-quality.ts'],
  };
  const targetApi: LocalTestLane = {
    name: 'target-api-smoke',
    command: ['bun', 'tests/bin/ke2e.ts', 'run', '--smoke'],
  };
  const targetBrowser: LocalTestLane = {
    name: 'target-browser-smoke',
    command: ['bun', 'run', 'test:browser', '--', '--grep', '@target-smoke'],
    cwd: 'tests',
    env: { E2E_BROWSER_WORKERS: '1' },
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
  if (full) {
    const fullFlows: LocalTestLane = {
      ...flows,
      command: [...flows.command, '--api-workers', '4'],
    };
    const fullBrowser: LocalTestLane = {
      ...browser,
      env: { E2E_BROWSER_WORKERS: '2' },
    };
    const lanes = [fullFlows, runnerUnit, routeCoverage, worktreeUnit, fullBrowser, packageQuality];
    return {
      mode: 'full',
      lanes,
      // Package quality saturates the machine and starts disposable PostgreSQL
      // containers. Give it an exclusive stage. Browser and four REST workers
      // can share the already-running product stack without starving either.
      stages: [[fullFlows, runnerUnit, routeCoverage, worktreeUnit, fullBrowser], [packageQuality]],
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
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const probe =
    options.probe ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(5_000) }));
  const sleep = options.sleep ?? Bun.sleep;
  do {
    try {
      const response = await probe(webUrl);
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
    let env = { ...process.env, ...(lane.env ?? {}) };
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
        E2E_DATABASE_URL: supabase.DB_URL,
        KE2E_DATABASE_URL: supabase.DB_URL,
        DATABASE_URL: supabase.DB_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
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
    if (plan.mode === 'target') {
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
