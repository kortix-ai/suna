import { describe, expect, it } from 'vitest';
import { buildLocalTestPlan } from '../src/core/local-runner';

describe('local test runner', () => {
  it('runs the REST flows, SDK, runner unit tests, and route coverage concurrently by default', () => {
    const plan = buildLocalTestPlan([]);

    expect(plan.mode).toBe('core');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'api-cli-flows',
      'sdk',
      'flow-runner-unit',
      'route-coverage',
    ]);
  });

  it('runs one filtered flow without paying the SDK or unit-test cost', () => {
    const plan = buildLocalTestPlan(['--id', 'ACC-4']);

    expect(plan.mode).toBe('flows');
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]?.command.slice(-2)).toEqual(['--id', 'ACC-4']);
  });

  it('adds every app and package test in full mode without running SDK twice', () => {
    const plan = buildLocalTestPlan(['--full']);

    expect(plan.mode).toBe('full');
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      'api-cli-flows',
      'flow-runner-unit',
      'route-coverage',
      'browser',
      'apps-packages',
    ]);
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

  it('rejects conflicting modes', () => {
    expect(() => buildLocalTestPlan(['--full', '--sdk-only'])).toThrow('choose only one');
  });
});
