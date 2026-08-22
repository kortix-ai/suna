import { describe, expect, test } from 'bun:test';
import type {
  PlatinumMaterializeRequest,
  PlatinumMaterializeResult,
} from './platinum-materialize';

const { materializePlatinumTemplate } = await import('./platinum-materialize');

type Step =
  | { status: number; body: unknown; elapsedMs?: number }
  | { error: Error; elapsedMs?: number };

function harness(steps: Step[]) {
  let nowMs = 1_000;
  const paths: string[] = [];
  const inits: RequestInit[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const request: PlatinumMaterializeRequest = async (path, init) => {
    paths.push(path);
    inits.push(init);
    const step = steps[Math.min(index++, steps.length - 1)];
    nowMs += step.elapsedMs ?? 0;
    if ('error' in step) throw step.error;
    return { status: step.status, body: step.body };
  };
  return {
    paths,
    inits,
    sleeps,
    request,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

async function run(steps: Step[], enabled = true): Promise<{
  result: PlatinumMaterializeResult;
  probe: ReturnType<typeof harness>;
}> {
  const probe = harness(steps);
  const result = await materializePlatinumTemplate('tpl_exact', {
    enabled,
    request: probe.request,
    sleep: probe.sleep,
    now: probe.now,
  });
  return { result, probe };
}

describe('Platinum template materialization', () => {
  test('the disabled flag makes zero requests', async () => {
    const { result, probe } = await run([{ status: 200, body: {} }], false);

    expect(result).toMatchObject({ status: 'disabled', attempts: 0 });
    expect(probe.paths).toHaveLength(0);
  });

  test('200 ready succeeds once', async () => {
    const { result, probe } = await run([{
      status: 200,
      body: { status: 'ready', template_id: 'tpl_exact' },
    }]);

    expect(result).toMatchObject({ status: 'ready', attempts: 1, httpStatus: 200 });
    expect(probe.sleeps).toEqual([]);
  });

  test.each([
    ['202 then ready', { status: 202, body: { status: 'in_progress' } } satisfies Step],
    ['503 then ready', { error: new Error('platinum POST /v1/templates/tpl_exact/materialize -> 503 unavailable') } satisfies Step],
  ])('%s retries and succeeds only on 200 ready', async (_label, first) => {
    const { result, probe } = await run([
      first,
      { status: 200, body: { status: 'ready', template_id: 'tpl_exact' } },
    ]);

    expect(result).toMatchObject({ status: 'ready', attempts: 2, httpStatus: 200 });
    expect(probe.sleeps).toEqual([_label === '202 then ready' ? 5_666 : 250]);
  });

  test('pre-existing work gets the full budget and can become ready after 10 seconds', async () => {
    const { result, probe } = await run([
      { status: 202, body: { status: 'in_progress' } },
      { status: 202, body: { status: 'in_progress' } },
      { status: 200, body: { status: 'ready', template_id: 'tpl_exact' } },
    ]);

    expect(result).toMatchObject({ status: 'ready', attempts: 3, httpStatus: 200 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(result.elapsedMs).toBeLessThan(18_000);
    expect(probe.sleeps).toEqual([5_666, 5_667]);
  });

  test('a request that consumes 15 seconds still gets a final readiness probe', async () => {
    const { result, probe } = await run([
      { status: 202, body: { status: 'in_progress' }, elapsedMs: 15_000 },
      { status: 200, body: { status: 'ready', template_id: 'tpl_exact' } },
    ]);

    expect(result).toMatchObject({ status: 'ready', attempts: 2, httpStatus: 200 });
    expect(result.elapsedMs).toBe(15_666);
    expect(probe.sleeps).toEqual([666]);
  });

  test('four immediate 202 responses spread four probes across the 18 second budget', async () => {
    const { result, probe } = await run([{
      status: 202,
      body: { status: 'in_progress' },
    }]);

    expect(result).toMatchObject({
      status: 'failed',
      attempts: 4,
      reason: 'attempts_exhausted',
    });
    expect(result.elapsedMs).toBe(17_000);
    expect(probe.paths).toHaveLength(4);
    expect(probe.sleeps).toEqual([5_666, 5_667, 5_667]);
  });

  test('503 keeps the short fail-open backoff instead of delaying session boot', async () => {
    const { result, probe } = await run([{
      error: new Error('platinum POST /v1/templates/tpl_exact/materialize -> 503 unavailable'),
    }]);

    expect(result).toMatchObject({ status: 'failed', attempts: 4, httpStatus: 503 });
    expect(result.elapsedMs).toBe(2_500);
    expect(probe.paths).toHaveLength(4);
    expect(probe.sleeps).toEqual([250, 750, 1_500]);
  });

  test('202 never succeeds from a misleading ready body', async () => {
    const { result } = await run([{
      status: 202,
      body: { status: 'ready', template_id: 'tpl_exact' },
    }]);

    expect(result).toMatchObject({ status: 'failed', attempts: 4, httpStatus: 202 });
  });

  test('200 with the wrong template id fails open without retry', async () => {
    const { result, probe } = await run([{
      status: 200,
      body: { status: 'ready', template_id: 'tpl_other' },
    }]);

    expect(result).toMatchObject({ status: 'failed', attempts: 1, httpStatus: 200 });
    expect(probe.sleeps).toEqual([]);
  });

  test.each([404, 409, 502])('%s fails open without retry', async (status) => {
    const { result, probe } = await run([{
      error: new Error(`platinum POST /v1/templates/tpl_exact/materialize -> ${status} failed`),
    }]);

    expect(result).toMatchObject({ status: 'failed', attempts: 1, httpStatus: status });
    expect(probe.sleeps).toEqual([]);
  });

  test.each([
    ['timeout', { error: new DOMException('timed out', 'TimeoutError') } satisfies Step],
    ['invalid JSON', { error: new SyntaxError('Unexpected token') } satisfies Step],
    ['malformed response', { status: 200, body: null } satisfies Step],
  ])('%s fails open without retry', async (_label, step) => {
    const { result, probe } = await run([step]);

    expect(result).toMatchObject({ status: 'failed', attempts: 1 });
    expect(probe.sleeps).toEqual([]);
  });

  test('the request encodes the exact external template id', async () => {
    const probe = harness([{
      status: 200,
      body: { status: 'ready', template_id: 'tpl/a b?' },
    }]);

    await materializePlatinumTemplate('tpl/a b?', {
      enabled: true,
      request: probe.request,
      sleep: probe.sleep,
      now: probe.now,
    });

    expect(probe.paths).toEqual(['/v1/templates/tpl%2Fa%20b%3F/materialize']);
    expect(probe.inits[0]?.method).toBe('POST');
    expect(probe.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('the total retry budget is bounded at 18 seconds', async () => {
    const { result, probe } = await run([{
      status: 202,
      body: { status: 'in_progress' },
      elapsedMs: 17_900,
    }]);

    expect(result).toMatchObject({ status: 'failed', attempts: 1 });
    expect(probe.sleeps).toEqual([100]);
    expect(result.elapsedMs).toBe(18_000);
  });

  test('build and agent-swap materialize the exact id after readiness and before return', async () => {
    const source = await Bun.file(new URL('./platinum.ts', import.meta.url)).text();
    const buildStart = source.indexOf('private async buildOnce(');
    const swapStart = source.indexOf('async swapAgent(', buildStart);
    const stateStart = source.indexOf('async getSnapshotState(', swapStart);
    const build = source.slice(buildStart, swapStart);
    const swap = source.slice(swapStart, stateStart);

    for (const [flow, body, waitCall] of [
      ['build', build, 'await waitForActive(input.snapshotName, tap, externalId, this.client);'],
      ['agent swap', swap, 'await waitForActive(newSnapshotName, undefined, externalId, this.client);'],
    ] as const) {
      const waitIndex = body.indexOf(waitCall);
      const materializeIndex = body.indexOf('await this.materializeTemplate(externalId).catch(');
      const returnIndex = body.indexOf('return { externalTemplateId: externalId };');

      expect(waitIndex, `${flow} readiness call`).toBeGreaterThan(-1);
      expect(materializeIndex, `${flow} materialization call`).toBeGreaterThan(waitIndex);
      expect(returnIndex, `${flow} exact-id return`).toBeGreaterThan(materializeIndex);
    }

    expect(source).toContain('enabled: config.KORTIX_FAST_COLD_BOOT_ENABLED');
  });

  test('agent-swap replaces the canonical kortixd executable', async () => {
    const source = await Bun.file(new URL('./platinum.ts', import.meta.url)).text();

    expect(source).toContain("guest_path: '/usr/local/bin/kortixd'");
    expect(source).toContain("guest_path: '/usr/local/bin/kortix-agent'");
  });
});
