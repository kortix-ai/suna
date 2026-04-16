import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { StepResult } from '../update/types';

const execCalls: string[] = [];
let queuedResults: StepResult[] = [];
const realSetTimeout = globalThis.setTimeout;

mock.module('../update/exec', () => ({
  execOnHost: async (_endpoint: unknown, command: string) => {
    execCalls.push(command);
    return queuedResults.shift() ?? {
      success: false,
      stdout: '',
      stderr: 'missing mock result',
      exitCode: 1,
      durationMs: 0,
    };
  },
}));

const { VERIFY_CONTAINER_MAX_RETRIES, verifyContainer, ensureContainerRunning } = await import('../update/steps');

describe('verifyContainer', () => {
  beforeEach(() => {
    execCalls.length = 0;
    queuedResults = [];
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as never;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test('waits for the expected image to be running', async () => {
    queuedResults = [
      { success: true, stdout: 'kortix/computer:0.8.40|created|0|', stderr: '', exitCode: 0, durationMs: 0 },
      { success: true, stdout: 'kortix/computer:0.8.41|running|0|', stderr: '', exitCode: 0, durationMs: 0 },
    ];

    const result = await verifyContainer({} as never, 'kortix/computer:0.8.41', 'justavps-workload', 2);

    expect(result.success).toBe(true);
    expect(execCalls).toHaveLength(2);
  });

  test('fails fast with diagnostics after the capped retry count', async () => {
    queuedResults = [
      ...Array.from({ length: VERIFY_CONTAINER_MAX_RETRIES }, () => ({
        success: true,
        stdout: 'kortix/computer:0.8.40|exited|137|CrashLoopBackOff',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
      } satisfies StepResult)),
      {
        success: true,
        stdout: 'docker ps:\njustavps-workload|kortix/computer:0.8.40|Exited (137)\n\njustavps-docker logs:\nboom',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
      },
    ];

    const result = await verifyContainer({} as never, 'kortix/computer:0.8.41', 'justavps-workload');

    expect(result.success).toBe(false);
    expect(result.stderr).toContain(`after ${VERIFY_CONTAINER_MAX_RETRIES} retries`);
    expect(result.stderr).toContain('Last observed: image=kortix/computer:0.8.40, state=exited, exitCode=137, error=CrashLoopBackOff');
    expect(result.stderr).toContain('Diagnostics:');
    expect(result.stderr).toContain('docker ps:');
    expect(execCalls).toHaveLength(VERIFY_CONTAINER_MAX_RETRIES + 1);
  });
});

describe('ensureContainerRunning', () => {
  beforeEach(() => {
    execCalls.length = 0;
    queuedResults = [];
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as never;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test('restarts and verifies the container when it is missing', async () => {
    queuedResults = [
      { success: false, stdout: '', stderr: 'No such container', exitCode: 1, durationMs: 0 },
      { success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 },
      { success: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 },
      { success: true, stdout: 'kortix/computer:0.8.41|running|0|', stderr: '', exitCode: 0, durationMs: 0 },
    ];

    const result = await ensureContainerRunning({} as never, {
      image: 'kortix/computer:0.8.41',
      name: 'justavps-workload',
      volumes: [],
      ports: [],
      caps: [],
      shmSize: '2g',
      envFile: '/etc/justavps/env',
      securityOpt: [],
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('recovered');
    expect(execCalls).toHaveLength(4);
    expect(execCalls[1]).toContain('kortix-managed-restart');
  });
});
