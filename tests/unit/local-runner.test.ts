import { describe, expect, it } from 'vitest';
import { resolveBrowserWorkers } from '../playwright.config';
import { buildLocalTestPlan, waitForLocalWeb } from '../src/core/local-runner';

describe('local test runner', () => {
  it('runs the REST flows, SDK, runner unit tests, and route coverage concurrently by default', () => {
    const plan = buildLocalTestPlan([]);

    expect(plan.mode).toBe('core');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'api-cli-flows',
      'sdk',
      'flow-runner-unit',
      'route-coverage',
      'worktree-unit',
    ]);
  });

  it('runs one filtered flow without paying the SDK or unit-test cost', () => {
    const plan = buildLocalTestPlan(['--id', 'ACC-4']);

    expect(plan.mode).toBe('flows');
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]?.command.slice(-2)).toEqual(['--id', 'ACC-4']);
  });

  it('runs the SDK explicitly and suppresses its duplicate package invocation in full mode', () => {
    const plan = buildLocalTestPlan(['--full']);

    expect(plan.mode).toBe('full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'api-cli-flows',
      'sdk',
      'flow-runner-unit',
      'route-coverage',
      'worktree-unit',
      'browser',
      'package-quality',
    ]);
    expect(plan.lanes.at(-1)).toEqual({
      name: 'package-quality',
      command: ['bun', 'tests/bin/package-quality.ts'],
      env: { KORTIX_PACKAGE_SKIP_SDK_TESTS: '1' },
    });
    expect(plan.stages.map((stage) => stage.map((lane) => lane.name))).toEqual([
      ['api-cli-flows', 'sdk', 'flow-runner-unit', 'route-coverage', 'worktree-unit'],
      ['browser'],
      ['package-quality'],
    ]);
    expect(plan.stages[0]?.[0]?.command.slice(-2)).toEqual(['--api-workers', '4']);
    expect(plan.lanes.find((lane) => lane.name === 'browser')?.env).toBeUndefined();
  });

  it('runs browser journeys through the same root command', () => {
    const plan = buildLocalTestPlan(['--browser-only']);

    expect(plan.mode).toBe('browser');
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]?.name).toBe('browser');
    expect(plan.lanes[0]).toEqual({
      name: 'browser',
      command: ['bun', 'run', 'test:browser'],
      cwd: 'tests',
    });
  });

  it('runs one browser shard through the same root command', () => {
    const plan = buildLocalTestPlan(['--browser-only', '--browser-shard=1/2']);

    expect(plan.mode).toBe('browser');
    expect(plan.lanes[0]?.command).toEqual([
      'bun',
      'run',
      'test:browser',
      '--',
      '--shard=1/2',
    ]);
  });

  it('rejects invalid browser shards', () => {
    expect(() => buildLocalTestPlan(['--browser-only', '--browser-shard='])).toThrow(
      'CURRENT/TOTAL',
    );
    expect(() => buildLocalTestPlan(['--browser-only', '--browser-shard=0/2'])).toThrow(
      'CURRENT/TOTAL',
    );
    expect(() => buildLocalTestPlan(['--browser-only', '--browser-shard=3/2'])).toThrow(
      'CURRENT/TOTAL',
    );
    expect(() => buildLocalTestPlan(['--browser-shard=1/2'])).toThrow(
      'requires --browser-only',
    );
  });

  it('uses one CI browser worker and preserves explicit concurrency', () => {
    expect(resolveBrowserWorkers(undefined, true)).toBe(1);
    expect(resolveBrowserWorkers(undefined, false)).toBe(2);
    expect(resolveBrowserWorkers('2', true)).toBe(2);
  });

  it('runs app and package tests without starting the product stack', () => {
    const plan = buildLocalTestPlan(['--packages-only']);

    expect(plan.mode).toBe('packages');
    expect(plan.lanes).toEqual([
      {
        name: 'package-quality',
        command: ['bun', 'tests/bin/package-quality.ts'],
      },
    ]);
  });

  it('runs deployed API and browser smoke through the same root command', () => {
    const plan = buildLocalTestPlan(['--target-smoke']);

    expect(plan.mode).toBe('target');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'target-api-smoke',
      'target-browser-smoke',
    ]);
    expect(plan.lanes[0]?.command).toEqual(['bun', 'tests/bin/ke2e.ts', 'run', '--smoke']);
    expect(plan.lanes[0]?.env).toEqual({ KE2E_FLOW_TIMEOUT_MS: '180000' });
    expect(plan.lanes[1]?.command).toEqual([
      'bun',
      'run',
      'test:browser',
      '--',
      '--grep',
      '@target-smoke',
    ]);
  });

  it('runs every deployed API flow and browser journey through the release command', () => {
    const plan = buildLocalTestPlan(['--target-full']);

    expect(plan.mode).toBe('target-full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual(['target-api-full', 'target-browser-full']);
    expect(plan.lanes[0]?.command).toEqual(['bun', 'tests/bin/ke2e.ts', 'run', '--require-all']);
    expect(plan.lanes[1]).toEqual({
      name: 'target-browser-full',
      command: ['bun', 'run', 'test:browser'],
      cwd: 'tests',
      env: {
        E2E_BROWSER_WORKERS: '2',
        E2E_ENABLE_SDK_ONLY_SESSION: '1',
        E2E_ENABLE_SANDBOX_TEMPLATE_BUILD: '1',
        E2E_OAUTH_PROVIDER_INITIATION: '1',
        E2E_ENABLE_BILLING_JOURNEY: '1',
        E2E_REQUIRE_ALL_BROWSER: '1',
      },
    });
  });

  it('keeps strict browser coverage but records the authorized preview OAuth exclusion', () => {
    const previous = process.env.KE2E_TARGET;
    process.env.KE2E_TARGET = 'preview';
    try {
      const plan = buildLocalTestPlan(['--target-full']);
      expect(plan.lanes[1]?.env).toEqual({
        E2E_BROWSER_WORKERS: '2',
        E2E_ENABLE_SDK_ONLY_SESSION: '1',
        E2E_ENABLE_SANDBOX_TEMPLATE_BUILD: '1',
        E2E_OAUTH_PROVIDER_INITIATION: '0',
        E2E_ENABLE_BILLING_JOURNEY: '1',
        E2E_REQUIRE_ALL_BROWSER: '1',
        E2E_ALLOW_PREVIEW_OAUTH_EXCLUSION: '1',
      });
    } finally {
      if (previous === undefined) delete process.env.KE2E_TARGET;
      else process.env.KE2E_TARGET = previous;
    }
  });

  it('raises the deployed API lane to six workers, still overridable by env', () => {
    const previous = process.env.KE2E_API_WORKERS;
    delete process.env.KE2E_API_WORKERS;
    try {
      // 3 workers left measured parallelism at 1.43x because the real ceiling is
      // provision.ts's global semaphore, not the worker count.
      expect(buildLocalTestPlan(['--target-full']).lanes[0]?.env).toEqual({
        KE2E_API_WORKERS: '6',
        KE2E_SANDBOX_WORKERS: '3',
        KE2E_FLOW_TIMEOUT_MS: '180000',
      });
      process.env.KE2E_API_WORKERS = '3';
      expect(buildLocalTestPlan(['--target-full']).lanes[0]?.env?.KE2E_API_WORKERS).toBe('3');
    } finally {
      if (previous === undefined) delete process.env.KE2E_API_WORKERS;
      else process.env.KE2E_API_WORKERS = previous;
    }
  });

  it('gives every deployed lane a 180s flow budget, still overridable by env', () => {
    // Run 32231251280 lost ~50% of its flows to `exceeded 120000ms` against live
    // staging. The 120s runner default is a LOCAL-stack number.
    const previous = process.env.KE2E_FLOW_TIMEOUT_MS;
    delete process.env.KE2E_FLOW_TIMEOUT_MS;
    try {
      for (const args of [['--target-smoke'], ['--target-api-full'], ['--target-full']]) {
        expect(buildLocalTestPlan(args).lanes[0]?.env?.KE2E_FLOW_TIMEOUT_MS).toBe('180000');
      }
      process.env.KE2E_FLOW_TIMEOUT_MS = '240000';
      expect(buildLocalTestPlan(['--target-api-full']).lanes[0]?.env?.KE2E_FLOW_TIMEOUT_MS).toBe(
        '240000',
      );
    } finally {
      if (previous === undefined) delete process.env.KE2E_FLOW_TIMEOUT_MS;
      else process.env.KE2E_FLOW_TIMEOUT_MS = previous;
    }
  });

  it('never raises the flow budget on a local lane', () => {
    // The local stack keeps the 120s default; only deployed targets pay the
    // Cloudflare + real-cloud-sandbox tax.
    for (const args of [[], ['--browser-only'], ['--full'], ['--id', 'ACC-4']]) {
      for (const lane of buildLocalTestPlan(args).lanes) {
        expect(lane.env?.KE2E_FLOW_TIMEOUT_MS).toBeUndefined();
      }
    }
  });

  it('runs one deployed API shard through the release gate command', () => {
    const plan = buildLocalTestPlan(['--target-api-full', '--api-shard=2/4']);

    expect(plan.mode).toBe('target-api-full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual(['target-api-full']);
    expect(plan.lanes[0]?.command).toEqual([
      'bun',
      'tests/bin/ke2e.ts',
      'run',
      '--require-all',
      '--shard',
      '2/4',
    ]);
  });

  it('runs one deployed browser shard through the release gate command', () => {
    const plan = buildLocalTestPlan(['--target-browser-full', '--browser-shard=3/3']);

    expect(plan.mode).toBe('target-browser-full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual(['target-browser-full']);
    expect(plan.lanes[0]?.command).toEqual([
      'bun',
      'run',
      'test:browser',
      '--',
      '--shard=3/3',
    ]);
    expect(plan.lanes[0]?.env?.E2E_REQUIRE_ALL_BROWSER).toBe('1');
  });

  it('runs each deployed lane unsharded when no shard is given', () => {
    expect(buildLocalTestPlan(['--target-api-full']).lanes[0]?.command).toEqual([
      'bun',
      'tests/bin/ke2e.ts',
      'run',
      '--require-all',
    ]);
    expect(buildLocalTestPlan(['--target-browser-full']).lanes[0]?.command).toEqual([
      'bun',
      'run',
      'test:browser',
    ]);
  });

  it('rejects a shard flag that has no lane to shard', () => {
    expect(() => buildLocalTestPlan(['--api-shard=1/2'])).toThrow(
      '--api-shard requires --target-api-full',
    );
    expect(() => buildLocalTestPlan(['--target-api-full', '--browser-shard=1/2'])).toThrow(
      '--browser-shard requires --browser-only or --target-browser-full',
    );
    expect(() => buildLocalTestPlan(['--target-api-full', '--api-shard=3/2'])).toThrow(
      '--api-shard must use CURRENT/TOTAL',
    );
  });

  it('rejects conflicting modes', () => {
    expect(() => buildLocalTestPlan(['--full', '--sdk-only'])).toThrow('choose only one');
    expect(() => buildLocalTestPlan(['--target-full', '--target-api-full'])).toThrow(
      'choose only one',
    );
  });

  it('retries a cold local web route until it is ready', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await waitForLocalWeb('http://127.0.0.1:24000', {
      timeoutMs: 1_000,
      probe: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('compiling');
        return new Response(null, { status: 200 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 250]);
  });
});
