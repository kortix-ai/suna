import { describe, expect, test } from 'vitest';
import {
  PLATINUM_CI_BUN_VERSION,
  PLATINUM_CI_NODE_IMAGE,
  PLATINUM_CI_PNPM_VERSION,
  PlatinumHttpError,
  buildPlatinumTemplateSpec,
  buildWorkerScript,
  isRetryablePlatinumError,
  observePlatinumWorker,
  platinumWorkerLaunchCommand,
  retryPlatinumOperation,
  selectReusablePlatinumTemplate,
  platinumTemplateName,
  validatePlatinumCiInput,
} from '../src/core/platinum-ci';

const sha = 'a'.repeat(40);
const lockHash = 'b'.repeat(64);

describe('Platinum CI worker plan', () => {
  test('uses one content-addressed template for one lockfile', () => {
    expect(platinumTemplateName(lockHash)).toBe('kortix-ci-v3-bbbbbbbbbbbbbbbb');
    const spec = buildPlatinumTemplateSpec({
      lockHash,
      repository: 'kortix-ai/suna',
      cacheSha: sha,
    });

    expect(spec.name).toBe(platinumTemplateName(lockHash));
    expect(spec.base_image).toBe(PLATINUM_CI_NODE_IMAGE);
    expect(spec.default_cpu).toBe(8);
    expect(spec.default_ram_mb).toBe(16_384);
    expect(spec.default_disk_gb).toBe(50);
    expect(JSON.stringify(spec.steps)).toContain(`bun@${PLATINUM_CI_BUN_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`pnpm@${PLATINUM_CI_PNPM_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`fetch --depth=1 origin ${sha}`);
    expect(JSON.stringify(spec.steps)).toContain('playwright install chromium');
    expect(spec.steps).toContainEqual({ op: 'kernel_modules', profile: 'container' });
    for (const step of spec.steps) {
      if (step.op === 'run') expect(step.cmd).not.toContain('\n');
    }
  });

  test('checks out the requested ref and rejects any SHA mismatch', () => {
    const script = buildWorkerScript({
      repository: 'kortix-ai/suna',
      ref: 'refs/pull/6260/head',
      sha,
      testArgs: ['--full'],
    });

    expect(script).toContain("'pnpm' 'test' '--' '--full'");
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain("fetch --depth=1 origin 'refs/pull/6260/head'");
    expect(script).toContain(`if [[ "$actual_sha" != '${sha}' ]]`);
    expect(script).toContain('nohup pnpm dev');
    expect(script).toContain('modprobe "$module"');
    expect(script).toContain('container_modules_ready=1');
    expect(script).toContain('seq 1 180');
    expect(script).toContain('docker_bridge_ready=1');
    expect(script).toContain('supabase_bridge_ready=1');
    expect(script).toContain('tar -C "$ROOT" -czf "$ARTIFACT" tests/test-results');
    expect(script).toContain('tests/test-results/platinum');
  });

  test('does not start the web stack for the default core run', () => {
    const script = buildWorkerScript({
      repository: 'kortix-ai/suna',
      ref: sha,
      sha,
      testArgs: [],
    });

    expect(script).toContain("'pnpm' 'test'");
    expect(script).not.toContain('nohup pnpm dev');
  });

  test('detaches the worker with the Platinum-supported setsid contract', () => {
    const command = platinumWorkerLaunchCommand();
    expect(command).toContain('setsid -f /workspace/run-kortix-tests.sh');
    expect(command).toContain('</dev/null');
    expect(command).not.toContain('nohup');
    expect(command).not.toMatch(/&\s*$/);
  });

  test('reuses the exact ready or building content-addressed template', () => {
    expect(selectReusablePlatinumTemplate([
      { id: 'failed', name: 'kortix-ci-v2-other', state: 'failed' },
      { id: 'ready', name: 'kortix-ci-v2-target', state: 'ready' },
    ], 'kortix-ci-v2-target')?.id).toBe('ready');
    expect(selectReusablePlatinumTemplate([
      { id: 'failed', name: 'kortix-ci-v2-target', state: 'failed' },
    ], 'kortix-ci-v2-target')).toBeNull();
  });

  test('retries only transient provider failures with bounded attempts', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryPlatinumOperation({
      label: 'test',
      attempts: 4,
      sleep: async (delay) => { delays.push(delay); },
      operation: async () => {
        calls += 1;
        if (calls < 3) throw new PlatinumHttpError('gateway timeout', 504);
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(isRetryablePlatinumError(new PlatinumHttpError('bad request', 400))).toBe(false);
    expect(isRetryablePlatinumError(
      new PlatinumHttpError('500: {"error":"The operation was aborted."}', 500),
    )).toBe(true);
    expect(isRetryablePlatinumError(new PlatinumHttpError('internal bug', 500))).toBe(false);
  });

  test('polls worker completion independently from optional log streaming', async () => {
    let now = 0;
    let statusChecks = 0;
    let logChecks = 0;
    const output: string[] = [];
    const warnings: string[] = [];
    const result = await observePlatinumWorker({
      startedAt: 0,
      timeoutMs: 100,
      pollMs: 1,
      now: () => now,
      sleep: async (delay) => { now += delay; },
      checkExitCode: async () => {
        statusChecks += 1;
        return statusChecks === 3 ? 0 : null;
      },
      statLog: async () => {
        logChecks += 1;
        if (logChecks < 3) {
          throw new PlatinumHttpError('500: {"error":"The operation was aborted."}', 500);
        }
        return { size: 4 };
      },
      readLog: async () => new TextEncoder().encode('done'),
      write: (chunk) => { output.push(chunk); },
      warn: (message) => { warnings.push(message); },
    });

    expect(result).toBe(0);
    expect(statusChecks).toBe(3);
    expect(logChecks).toBe(3);
    expect(output.join('')).toBe('done');
    expect(warnings).toContainEqual(expect.stringContaining('incremental log unavailable'));
    expect(warnings).toContainEqual(expect.stringContaining('incremental log streaming recovered'));
  });

  test('rejects values that could alter the Git fetch command', () => {
    expect(() =>
      validatePlatinumCiInput({
        apiUrl: 'https://api.platinum.dev',
        apiKey: 'test',
        repository: 'kortix-ai/suna',
        sha,
        ref: 'main; curl attacker',
        runId: '1',
        runAttempt: '1',
        testArgs: [],
        root: '/tmp/suna',
      }),
    ).toThrow(/invalid Git ref/);
  });
});
