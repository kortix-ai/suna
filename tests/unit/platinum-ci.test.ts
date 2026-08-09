import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PLATINUM_CI_BUN_VERSION,
  PLATINUM_CI_NODE_IMAGE,
  PLATINUM_CI_PNPM_VERSION,
  PlatinumHttpError,
  buildPlatinumTemplateSpec,
  buildPlatinumWarmTemplateRequest,
  buildWorkerScript,
  cleanupPlatinumCiSandboxes,
  selectOutstandingPlatinumSandboxIds,
  isRetryablePlatinumError,
  observePlatinumWorker,
  platinumBaseTemplateName,
  platinumWorkerLaunchCommand,
  retryPlatinumOperation,
  selectReusablePlatinumTemplate,
  platinumTemplateName,
  validatePlatinumCiInput,
} from '../src/core/platinum-ci';

const sha = 'a'.repeat(40);
const lockHash = 'b'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Platinum CI worker plan', () => {
  test('uses one content-addressed template for one lockfile', () => {
    expect(platinumTemplateName(lockHash)).toBe('kortix-ci-v10-bbbbbbbbbbbbbbbb');
    expect(platinumBaseTemplateName(lockHash)).toBe('kortix-ci-v10-bbbbbbbbbbbbbbbb-base');
    const spec = buildPlatinumTemplateSpec({
      lockHash,
      repository: 'kortix-ai/suna',
      cacheSha: sha,
    });

    expect(spec.name).toBe(platinumBaseTemplateName(lockHash));
    expect(spec.base_image).toBe(PLATINUM_CI_NODE_IMAGE);
    expect(spec.default_cpu).toBe(8);
    expect(spec.default_ram_mb).toBe(16_384);
    expect(spec.default_disk_gb).toBe(50);
    expect(spec.steps[0]).toEqual({ op: 'kernel_modules', profile: 'container' });
    expect(JSON.stringify(spec.steps)).toContain(`bun@${PLATINUM_CI_BUN_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`pnpm@${PLATINUM_CI_PNPM_VERSION}`);
    expect(JSON.stringify(spec.steps)).toContain(`fetch --depth=1 origin ${sha}`);
    expect(JSON.stringify(spec.steps)).toContain('playwright install --with-deps chromium');
    expect(JSON.stringify(spec.steps)).toContain('git init /workspace/suna');
    expect(spec.entrypoint).toContain('supabase start --ignore-health-check');
    expect(spec.entrypoint).toContain('supabase stop --no-backup');
    expect(spec.entrypoint).toContain('.kortix-ci-warm-ready');
    expect(spec.entrypoint).not.toMatch(/\$[A-Za-z_({!]/);
    expect(spec.entrypoint).toContain('modprobe overlay');
    expect(spec.entrypoint).toContain(
      'dockerd --host=unix:///var/run/docker.sock >/workspace/kortix-template-dockerd.log 2>&1 &',
    );
    expect(buildPlatinumWarmTemplateRequest(lockHash)).toEqual({
      name: platinumTemplateName(lockHash),
      capture_condition: {
        cmd: 'test -s /workspace/.kortix-ci-warm-ready',
        timeoutSec: 1_200,
      },
      default_cpu: 8,
      default_ram_mb: 16_384,
      default_disk_gb: 50,
    });
    for (const step of spec.steps) {
      if (step.op === 'run') expect(step.cmd).not.toContain('\n');
    }
  });

  test('post cleanup selects only the exact CI run sandbox', () => {
    expect(
      selectOutstandingPlatinumSandboxIds(
        [
          {
            id: 'exact',
            name: 'kortix-ci-31289428402-1',
            metadata: { owner: 'kortix-ci', run_id: '31289428402' },
          },
          {
            id: 'other-attempt',
            name: 'kortix-ci-31289428402-2',
            metadata: { owner: 'kortix-ci', run_id: '31289428402' },
          },
          {
            id: 'not-ci-owned',
            name: 'kortix-ci-31289428402-1',
            metadata: { owner: 'customer', run_id: '31289428402' },
          },
        ],
        '31289428402',
        '1',
      ),
    ).toEqual(['exact']);
  });

  test('post cleanup reads paginated sandbox rows before deleting the exact worker', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/sandboxes?paginated=true&limit=100&offset=0')) {
        return Response.json({
          rows: [{ id: 'other', name: 'customer', metadata: {} }],
          total: 2,
          has_more: true,
        });
      }
      if (url.endsWith('/v1/sandboxes?paginated=true&limit=100&offset=100')) {
        return Response.json({
          rows: [{
            id: 'exact',
            name: 'kortix-ci-31289428402-1',
            metadata: { owner: 'kortix-ci', run_id: '31289428402' },
          }],
          total: 2,
          has_more: false,
        });
      }
      if (url.endsWith('/v1/sandboxes/exact') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });

    await expect(cleanupPlatinumCiSandboxes({
      apiUrl: 'https://api.platinum.dev',
      apiKey: 'test',
      runId: '31289428402',
      runAttempt: '1',
    })).resolves.toBe(1);
    expect(requests).toEqual([
      'GET https://api.platinum.dev/v1/sandboxes?paginated=true&limit=100&offset=0',
      'GET https://api.platinum.dev/v1/sandboxes?paginated=true&limit=100&offset=100',
      'DELETE https://api.platinum.dev/v1/sandboxes/exact',
    ]);
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
    expect(script).toContain('pnpm install --offline --frozen-lockfile');
    expect(script).not.toContain('rm -rf "$ROOT"');
    expect(script).toContain(`if [[ "$actual_sha" != '${sha}' ]]`);
    expect(script).not.toContain('nohup pnpm dev');
    expect(script).toContain('modprobe "$module"');
    expect(script).toContain('container_modules_ready=1');
    expect(script).toContain('seq 1 180');
    expect(script).toContain('docker_bridge_ready=1');
    expect(script).not.toContain('supabase_bridge_ready=1');
    expect(script).toContain('tar -C "$ROOT" -czf "$ARTIFACT" tests/test-results');
    expect(script).toContain('tests/test-results/platinum');
  });

  test('lets the root runner own the local stack for every mode', () => {
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
    expect(isRetryablePlatinumError(new PlatinumHttpError('gateway timeout', 504))).toBe(true);
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
