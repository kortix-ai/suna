import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLocalSupabaseEnvironment, resolveLocalTopology } from './local-stack';

export interface LocalTestLane {
  name: string;
  command: string[];
  cwd?: string;
}

export interface LocalTestPlan {
  mode: 'core' | 'flows' | 'sdk' | 'browser' | 'full';
  lanes: LocalTestLane[];
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
  const modes = [full, flowsOnly, sdkOnly, browserOnly].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('choose only one of --full, --flows-only, --sdk-only, or --browser-only');
  }

  const flowArgs = args.filter(
    (arg) =>
      arg !== '--full' &&
      arg !== '--flows-only' &&
      arg !== '--sdk-only' &&
      arg !== '--browser-only',
  );
  const flows: LocalTestLane = {
    name: 'api-cli-flows',
    command: [
      'pnpm',
      'exec',
      'dotenvx',
      'run',
      '-f',
      'apps/api/.env',
      '--',
      'bun',
      'tests/bin/ke2e.ts',
      'local',
      ...flowArgs,
    ],
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
  const browser: LocalTestLane = {
    name: 'browser',
    command: ['bun', 'run', 'test:browser'],
    cwd: 'tests',
  };

  if (flowsOnly) return { mode: 'flows', lanes: [flows] };
  if (sdkOnly) return { mode: 'sdk', lanes: [sdk] };
  if (browserOnly) return { mode: 'browser', lanes: [browser] };
  if (full) {
    return {
      mode: 'full',
      lanes: [
        flows,
        runnerUnit,
        routeCoverage,
        browser,
        {
          name: 'apps-packages',
          command: [
            'pnpm',
            '--filter',
            './packages/**',
            '--filter',
            './apps/**',
            '--if-present',
            'test',
          ],
        },
      ],
    };
  }
  return { mode: 'core', lanes: [flows, sdk, runnerUnit, routeCoverage] };
}

interface LaneResult {
  name: string;
  command: string[];
  exitCode: number;
  durationMs: number;
}

async function runLane(root: string, lane: LocalTestLane): Promise<LaneResult> {
  const startedAt = performance.now();
  console.log(`\n[test] START ${lane.name}: ${lane.command.join(' ')}`);
  try {
    let env = process.env;
    if (lane.name === 'browser') {
      const topology = resolveLocalTopology(root);
      const supabase = await readLocalSupabaseEnvironment(topology);
      const webPort = topology.marker?.ports.web ?? 3000;
      const webUrl = `http://127.0.0.1:${webPort}`;
      try {
        const response = await fetch(webUrl, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        throw new Error(`local web is not running at ${webUrl}; start it with pnpm dev`);
      }
      if (
        !supabase.API_URL ||
        !supabase.DB_URL ||
        !supabase.ANON_KEY ||
        !supabase.SERVICE_ROLE_KEY
      ) {
        throw new Error('local Supabase environment is incomplete');
      }
      env = {
        ...process.env,
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
  console.log(`[test] mode=${plan.mode} lanes=${plan.lanes.map((lane) => lane.name).join(',')}`);
  const results = await Promise.all(plan.lanes.map((lane) => runLane(root, lane)));
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
