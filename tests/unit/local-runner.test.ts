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

  it('adds every app and package test plus publish checks without running SDK twice', () => {
    const plan = buildLocalTestPlan(['--full']);

    expect(plan.mode).toBe('full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'api-cli-flows',
      'flow-runner-unit',
      'route-coverage',
      'worktree-unit',
      'browser',
      'package-quality',
    ]);
    expect(plan.lanes.at(-1)?.command).toEqual(['bun', 'tests/bin/package-quality.ts']);
    expect(plan.stages.map((stage) => stage.map((lane) => lane.name))).toEqual([
      ['api-cli-flows', 'flow-runner-unit', 'route-coverage', 'worktree-unit'],
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
    expect(resolveBrowserWorkers(undefined, false)).toBe(4);
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

  it('rejects conflicting modes', () => {
    expect(() => buildLocalTestPlan(['--full', '--sdk-only'])).toThrow('choose only one');
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
