import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PREVIEW_SUITE_PID_PATH,
  PREVIEW_SUITE_SUPERSEDED,
  PreviewInfrastructureError,
  previewDeploymentStatusPath,
  previewSuiteStatusPath,
} from '../src/core/sandbox-preview';
import {
  deployPlatinumPreview,
  runPlatinumPreviewSuite,
  type SandboxPreviewDeploymentInput,
  type SandboxPreviewSuiteInput,
} from '../src/core/sandbox-preview-providers';

/**
 * Characterization tests for the Platinum preview deploy/suite observe cycle
 * (KRTX-1432). They pin what the two observePlatinumWorker call sites wire
 * together today — the status-file exit poll, the incremental log stream that
 * starts at the pre-launch log size, the suite's throttled supersede check and
 * its pid-file kill command, the artifact download, and the cleanup contract —
 * so the behavior-preserving refactor is judged against exactly what these
 * tests saw before it.
 */

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}

const API = 'https://api.platinum.invalid';
const RUN_ID = '1432';
const STATUS_PATH = previewDeploymentStatusPath(RUN_ID, '1');
const SUITE_STATUS_PATH = previewSuiteStatusPath(RUN_ID, '1');
const LOG_PATH = '/workspace/kortix-preview/kortix-preview.log';

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes one URL against the fake Platinum REST surface and records the call. */
class FakePlatinumFetch {
  calls: FetchCall[] = [];
  /** Log bytes the sandbox log holds before this run appends anything. */
  logPrefix = 'x'.repeat(1000);
  /** Log bytes this run appends once its detached script launches. */
  logAppendix = 'y'.repeat(50);
  sandboxCreateStatus = 200;
  createdSandboxBody: unknown;
  /** When true, the status files read as absent, so a poll observes nothing. */
  statusAbsent = false;

  route(method: string, url: string, bodyText: string | undefined): Response {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;
    const body = bodyText ? safeJson(bodyText) : undefined;
    this.calls.push({ method, url: path + (query.size ? `?${query}` : ''), body });

    if (method === 'GET' && path === '/v1/sandboxes' && query.get('paginated') === 'true') {
      return jsonResponse({ rows: [], total: 0 });
    }
    if (method === 'GET' && path === '/v1/templates') {
      return jsonResponse([]);
    }
    if (method === 'POST' && path === '/v1/templates/from-spec') {
      return jsonResponse({ id: 'tpl-base', state: 'ready' });
    }
    if (method === 'POST' && path === '/v1/templates/tpl-base/derive') {
      return jsonResponse({ id: 'tpl-warm', state: 'ready' });
    }
    if (method === 'GET' && /^\/v1\/templates\/[^/]+$/.test(path)) {
      return jsonResponse({ id: path.split('/').pop(), state: 'ready' });
    }
    if (method === 'POST' && path === '/v1/sandboxes' && query.get('wait_for_state')) {
      if (this.sandboxCreateStatus !== 200) {
        return jsonResponse({ error: 'pool_exceeded' }, this.sandboxCreateStatus);
      }
      this.createdSandboxBody = body;
      return jsonResponse({
        id: 'sbx-1',
        state: 'running',
        via: 'restore',
        exposed: [{ port: 8080, url: 'https://pr-6337.preview.invalid/' }],
      });
    }
    if (method === 'GET' && path === '/v1/sandboxes/sbx-1') {
      return jsonResponse({ id: 'sbx-1', state: 'running', via: 'restore' });
    }
    if (method === 'POST' && path === '/v1/sandboxes/sbx-1/exec') {
      const command = String(body?.cmd?.[2] ?? '');
      // The detached launcher means the run's script is now appending to the log.
      if (command.includes('setsid -f /workspace/run-kortix-preview')) {
        this.logPrefix += this.logAppendix;
        this.logAppendix = '';
      }
      return jsonResponse({ result: { exit_code: 0, stdout: '', stderr: '' } });
    }
    if (method === 'GET' && path === '/v1/sandboxes/sbx-1/files/stat') {
      const statPath = query.get('path') ?? '';
      if (statPath === '/workspace/.kortix-ci-warm-ready') return jsonResponse({ ok: true, size: 4 });
      if (statPath === LOG_PATH) {
        return jsonResponse({ ok: true, size: this.logPrefix.length });
      }
      if (this.statusAbsent && (statPath === STATUS_PATH || statPath === SUITE_STATUS_PATH)) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (statPath === STATUS_PATH || statPath === SUITE_STATUS_PATH) {
        return jsonResponse({ ok: true, size: 2 });
      }
      // The artifact is absent, so the download warn path is exercised.
      return jsonResponse({ error: 'not found' }, 404);
    }
    if (method === 'GET' && path === '/v1/sandboxes/sbx-1/files') {
      const readPath = query.get('path') ?? '';
      const offset = Number(query.get('offset') ?? 0);
      const limit = Number(query.get('limit') ?? 0);
      if (readPath === '/workspace/.kortix-ci-warm-ready') return new Response('12\n');
      if (readPath === STATUS_PATH || readPath === SUITE_STATUS_PATH) return new Response('0');
      if (readPath === LOG_PATH) {
        return new Response(this.logPrefix.slice(offset, offset + limit));
      }
      return jsonResponse({ error: 'not found' }, 404);
    }
    if (method === 'PUT' && path === '/v1/sandboxes/sbx-1/files') {
      return jsonResponse({ ok: true });
    }
    if (method === 'DELETE' && /^\/v1\/sandboxes\//.test(path)) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: `fake has no handler for ${method} ${path}` }, 500);
  }

  callsTo(pattern: RegExp): FetchCall[] {
    return this.calls.filter((c) => pattern.test(`${c.method} ${c.url}`));
  }
}

function deploymentInput(root: string): SandboxPreviewDeploymentInput {
  return {
    repository: 'kortix-ai/suna',
    ref: 'refs/pull/6337/head',
    sha: 'a'.repeat(40),
    prNumber: 6337,
    runId: RUN_ID,
    runAttempt: '1',
    root,
    lockfileHash: 'c'.repeat(64),
    secrets: {},
    platinum: { apiUrl: API, apiKey: 'test-key' },
  };
}

function suiteInput(root: string, superseded?: () => Promise<boolean>): SandboxPreviewSuiteInput {
  return {
    repository: 'kortix-ai/suna',
    sha: 'a'.repeat(40),
    prNumber: 6337,
    runId: RUN_ID,
    runAttempt: '1',
    root,
    sandboxId: 'sbx-1',
    platinum: { apiUrl: API, apiKey: 'test-key' },
    superseded,
  };
}

describe('Platinum preview deploy and suite observe cycle (characterization)', () => {
  let fake: FakePlatinumFetch;
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    // The shared platinum observer sleeps through Bun.sleep when the caller
    // injects none; under vitest's node runtime the global Bun does not exist,
    // so hand it a timer-backed sleep the fake clock can advance.
    vi.stubGlobal('Bun', {
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    fake = new FakePlatinumFetch();
    vi.stubGlobal(
      'fetch',
      ((url: string | URL, init?: RequestInit) =>
        Promise.resolve(
          fake.route(
            String(init?.method ?? 'GET').toUpperCase(),
            String(url),
            typeof init?.body === 'string' ? init.body : undefined,
          ),
        )) as typeof fetch,
    );
    // The suite capacity wait must not wait: zero headroom and a zero window.
    process.env.PREVIEW_SUITE_POOL_HEADROOM_GB = '0';
    process.env.PREVIEW_SUITE_WAIT_MINUTES = '0';
    delete process.env.MANAGED_GIT_GITHUB_OWNER;
    root = mkdtempSync(join(tmpdir(), 'ke2e-preview-observe-'));
  });

  afterEach(() => {
    delete process.env.PREVIEW_SUITE_POOL_HEADROOM_GB;
    delete process.env.PREVIEW_SUITE_WAIT_MINUTES;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  test('a deploy streams only the bytes this run appends and keeps the sandbox', async () => {
    const result = await deployPlatinumPreview(deploymentInput(root));

    expect(result).toEqual({
      provider: 'platinum',
      exitCode: 0,
      sandboxId: 'sbx-1',
      previewUrl: 'https://pr-6337.preview.invalid',
      sandboxOrigin: 'https://pr-6337.preview.invalid',
    });

    // The status file is polled at the run-scoped path this run owns.
    expect(
      fake.callsTo(
        new RegExp(
          `^GET /v1/sandboxes/sbx-1/files/stat\\?path=${encodeURIComponent(STATUS_PATH)}`,
        ),
      ).length,
    ).toBeGreaterThan(0);
    // The log stream starts at the pre-launch size and reads only the appendix.
    const logRead = fake.calls.filter(
      (c) =>
        c.method === 'GET' &&
        c.url.startsWith(`/v1/sandboxes/sbx-1/files?path=${encodeURIComponent(LOG_PATH)}`),
    );
    expect(logRead).toHaveLength(1);
    expect(logRead[0]!.url).toContain('offset=1000');
    expect(logRead[0]!.url).toContain('limit=50');
    // The bootstrap script is written once, executable, next to its secrets file.
    const scriptWrites = fake.callsTo(/^PUT \/v1\/sandboxes\/sbx-1\/files/);
    expect(scriptWrites).toHaveLength(2);
    expect(scriptWrites[1]!.url).toContain('mode=0755');
    // A successful deploy keeps the sandbox: no DELETE.
    expect(fake.callsTo(/^DELETE \/v1\/sandboxes\//)).toHaveLength(0);
    // The deployment record is written under the run root.
    const record = JSON.parse(
      readFileSync(join(root, 'tests/test-results/preview/deployment.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      provider: 'platinum',
      exitCode: 0,
      sandboxId: 'sbx-1',
      previewUrl: 'https://pr-6337.preview.invalid',
      gitSha: 'a'.repeat(40),
      reportUrl: 'https://pr-6337.preview.invalid/_tests/',
    });
  });

  test('a Platinum 429 pool refusal becomes an infrastructure error, not a product failure', async () => {
    fake.sandboxCreateStatus = 429;
    const failure = await deployPlatinumPreview(deploymentInput(root)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PreviewInfrastructureError);
    const cause = (failure as PreviewInfrastructureError).cause as Error;
    expect(String(cause?.message ?? '')).toContain('org RAM pool is full');
    // Nothing was created, so nothing is deleted.
    expect(fake.callsTo(/^DELETE \/v1\/sandboxes\//)).toHaveLength(0);
  });

  test('the suite streams its own bytes, polls its own status file, and stops after itself', async () => {
    const result = await runPlatinumPreviewSuite(suiteInput(root));

    expect(result).toBe(0);
    // The suite script is written executable at the fixed path.
    const writes = fake.callsTo(/^PUT \/v1\/sandboxes\/sbx-1\/files/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toContain(
      `path=${encodeURIComponent('/workspace/run-kortix-preview-suite.sh')}`,
    );
    expect(writes[0]!.url).toContain('mode=0755');
    // The suite polls its own status file, not the deploy's.
    expect(
      fake.callsTo(
        new RegExp(
          `^GET /v1/sandboxes/sbx-1/files/stat\\?path=${encodeURIComponent(SUITE_STATUS_PATH)}`,
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      fake.callsTo(
        new RegExp(
          `^GET /v1/sandboxes/sbx-1/files/stat\\?path=${encodeURIComponent(STATUS_PATH)}`,
        ),
      ),
    ).toHaveLength(0);
    // The log stream starts at the pre-suite size and reads only the appendix.
    const logRead = fake.calls.filter(
      (c) =>
        c.method === 'GET' &&
        c.url.startsWith(`/v1/sandboxes/sbx-1/files?path=${encodeURIComponent(LOG_PATH)}`),
    );
    expect(logRead).toHaveLength(1);
    expect(logRead[0]!.url).toContain('offset=1000');
    expect(logRead[0]!.url).toContain('limit=50');
    // The artifact download was attempted after a finished suite.
    expect(
      fake.callsTo(
        /^GET \/v1\/sandboxes\/sbx-1\/files\/stat\?path=%2Fworkspace%2Fkortix-test-results\.tar\.gz/,
      ).length,
    ).toBe(1);
  });

  test('a superseded run kills the suite by its pid file and downloads nothing', async () => {
    // The supersede check is throttled to one per minute, so the first polls
    // must observe nothing: hide the status file until the check fires.
    fake.statusAbsent = true;
    let calls = 0;
    const result = await driveUntilSettled(
      runPlatinumPreviewSuite(
        suiteInput(root, async () => {
          calls += 1;
          return calls >= 1;
        }),
      ),
      120_000,
    );

    expect(result).toBe(PREVIEW_SUITE_SUPERSEDED);
    // The supersede kill reads the suite's pid file and TERMs its group.
    const kill = fake.calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.url.endsWith('/exec') &&
        String((c.body as { cmd?: string[] })?.cmd?.[2] ?? '').includes('kill -TERM') &&
        String((c.body as { cmd?: string[] })?.cmd?.[2] ?? '').includes(PREVIEW_SUITE_PID_PATH),
    );
    expect(kill).toHaveLength(1);
    // A superseded run downloads no artifacts.
    expect(
      fake.callsTo(
        /^GET \/v1\/sandboxes\/sbx-1\/files\/stat\?path=%2Fworkspace%2Fkortix-test-results\.tar\.gz/,
      ),
    ).toHaveLength(0);
  });

  /**
   * Drive a promise that sleeps under the fake clock: advance in steps until
   * it settles, then return its outcome. The outcome is captured and re-thrown
   * at the end, so a rejection during the clock advance is never an orphaned
   * rejection.
   */
  async function driveUntilSettled<T>(promise: Promise<T>, ms: number): Promise<T> {
    let settled = false;
    let outcome: { value?: T; error?: unknown; failed: boolean };
    promise.then(
      (value) => {
        outcome = { value, failed: false };
        settled = true;
      },
      (error: unknown) => {
        outcome = { error, failed: true };
        settled = true;
      },
    );
    for (let advanced = 0; advanced < ms && !settled; advanced += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    if (!settled) throw new Error('the promise did not settle within the advanced clock');
    if (outcome!.failed) throw outcome!.error;
    return outcome!.value as T;
  }
});
