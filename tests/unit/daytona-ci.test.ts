import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DAYTONA_CI_SNAPSHOT_VERSION,
  DaytonaApi,
  DaytonaHttpError,
  buildDaytonaBaseDockerfile,
  buildDaytonaWarmScript,
  buildDaytonaWorkerRequest,
  cleanupDaytonaCiSandbox,
  createDaytonaSandbox,
  daytonaBaseSnapshotName,
  daytonaSnapshotName,
  isExactDaytonaCiSandbox,
  isRetryableDaytonaError,
  retryDaytonaOperation,
  validateDaytonaCiInput,
} from '../src/core/daytona-ci';
import { buildWorkerScript } from '../src/core/platinum-ci';

const sha = 'a'.repeat(40);
const lockHash = 'b'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Daytona CI worker plan', () => {
  test('uses one content-addressed warm snapshot for one lockfile', () => {
    expect(DAYTONA_CI_SNAPSHOT_VERSION).toBe('v1');
    expect(daytonaSnapshotName(lockHash)).toBe('kortix-ci-daytona-v1-bbbbbbbbbbbbbbbb');
    expect(daytonaBaseSnapshotName(lockHash)).toBe('kortix-ci-daytona-v1-bbbbbbbbbbbbbbbb-base');
  });

  test('builds the same pinned toolchain and repository cache as Platinum', () => {
    const dockerfile = buildDaytonaBaseDockerfile({
      repository: 'kortix-ai/suna',
      cacheSha: sha,
    });

    expect(dockerfile).toContain('node:22.22.0-bookworm@sha256:');
    expect(dockerfile).toContain('docker.io');
    expect(dockerfile).toContain('kmod');
    expect(dockerfile).toContain('bun@1.3.14');
    expect(dockerfile).toContain('pnpm@8.11.0');
    expect(dockerfile).toContain(`fetch --depth=1 origin ${sha}`);
    expect(dockerfile).toContain('playwright install --with-deps chromium');
    expect(dockerfile).toContain('ENTRYPOINT ["sleep", "infinity"]');
  });

  test('pre-pulls local-stack images before capturing the warm snapshot', () => {
    const script = buildDaytonaWarmScript();
    expect(script).toContain('supabase start --ignore-health-check');
    expect(script).toContain('supabase stop --no-backup');
    expect(script).toContain('.kortix-ci-warm-ready');
    expect(script).toContain('daytona-warm.exit');
    expect(script).toContain('modprobe "$module"');
    expect(script).toContain('pkill -TERM -x dockerd');
    expect(script).toContain('pgrep -x containerd');
  });

  test('creates an explicitly disposable Daytona worker', () => {
    expect(
      buildDaytonaWorkerRequest({
        snapshot: 'kortix-ci-daytona-v1-hash',
        target: 'us',
        repository: 'kortix-ai/suna',
        sha,
        runId: '31320717706',
        runAttempt: '2',
      }),
    ).toEqual({
      name: 'kortix-ci-31320717706-2',
      snapshot: 'kortix-ci-daytona-v1-hash',
      target: 'us',
      public: false,
      autoStopInterval: 15,
      autoArchiveInterval: 1_440,
      autoDeleteInterval: 1_440,
      labels: {
        'kortix-ci': 'true',
        'kortix-ci-run-id': '31320717706',
        'kortix-ci-run-attempt': '2',
        'kortix-ci-repository': 'kortix-ai/suna',
        'kortix-ci-git-sha': sha,
      },
    });
  });

  test('uses the unchanged root test command inside Daytona', () => {
    const script = buildWorkerScript({
      repository: 'kortix-ai/suna',
      ref: sha,
      sha,
      testArgs: ['--full'],
      provider: 'daytona',
    });
    expect(script).toContain("'pnpm' 'test' '--' '--full'");
    expect(script).toContain('[daytona-ci] exact_sha=');
    expect(script).toContain('tests/test-results/daytona');
    expect(script).not.toContain('tests/test-results/platinum');
  });

  test('validates provider input before making requests', () => {
    const valid = {
      apiUrl: 'https://app.daytona.io/api',
      apiKey: 'secret',
      target: 'us',
      repository: 'kortix-ai/suna',
      sha,
      ref: sha,
      runId: '31320717706',
      runAttempt: '1',
      testArgs: [],
      root: '/tmp/suna',
    };
    expect(() => validateDaytonaCiInput(valid)).not.toThrow();
    expect(() => validateDaytonaCiInput({ ...valid, apiKey: '' })).toThrow('DAYTONA_API_KEY');
    expect(() => validateDaytonaCiInput({ ...valid, target: 'us west' })).toThrow(
      'invalid Daytona target',
    );
  });

  test('retries rate limits and provider outages with bounded backoff', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryDaytonaOperation({
      label: 'test',
      attempts: 4,
      sleep: async (delay) => {
        delays.push(delay);
      },
      operation: async () => {
        calls += 1;
        if (calls < 3) throw new DaytonaHttpError('service unavailable', 503);
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(isRetryableDaytonaError(new DaytonaHttpError('rate limit', 429))).toBe(true);
    expect(isRetryableDaytonaError(new DaytonaHttpError('bad request', 400))).toBe(false);
  });

  test('reconciles a lost sandbox create response by exact name', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if (init?.method === 'POST') throw new TypeError('fetch failed');
      return Response.json({
        id: 'reconciled-id',
        name: 'kortix-ci-run-1',
        state: 'creating',
      });
    });

    const api = new DaytonaApi('https://app.daytona.io/api', 'test');
    await expect(createDaytonaSandbox(api, {
      name: 'kortix-ci-run-1',
      snapshot: 'warm',
    })).resolves.toMatchObject({ id: 'reconciled-id' });
    expect(requests).toEqual([
      'POST https://app.daytona.io/api/sandbox',
      'GET https://app.daytona.io/api/sandbox/kortix-ci-run-1',
    ]);
  });

  test('post cleanup deletes only the exact labelled worker', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({
        id: 'sandbox-id',
        name: 'kortix-ci-31320717706-1',
        state: 'started',
        labels: {
          'kortix-ci': 'true',
          'kortix-ci-run-id': '31320717706',
          'kortix-ci-run-attempt': '1',
        },
      });
    });

    await expect(
      cleanupDaytonaCiSandbox({
        apiUrl: 'https://app.daytona.io/api',
        apiKey: 'test',
        runId: '31320717706',
        runAttempt: '1',
      }),
    ).resolves.toBe(1);
    expect(requests).toEqual([
      'GET https://app.daytona.io/api/sandbox/kortix-ci-31320717706-1',
      'DELETE https://app.daytona.io/api/sandbox/sandbox-id',
    ]);
  });

  test('recognizes exact cleanup ownership', () => {
    expect(
      isExactDaytonaCiSandbox(
        {
          id: 'id',
          name: 'kortix-ci-run-1',
          labels: {
            'kortix-ci': 'true',
            'kortix-ci-run-id': 'run',
            'kortix-ci-run-attempt': '1',
          },
        },
        'run',
        '1',
      ),
    ).toBe(true);
    expect(
      isExactDaytonaCiSandbox(
        {
          id: 'id',
          name: 'kortix-ci-run-1',
          labels: { 'kortix-ci': 'false' },
        },
        'run',
        '1',
      ),
    ).toBe(false);
  });
});
