import { describe, expect, test } from 'bun:test';
import type { PlatinumJsonResponse } from '../../services/sandboxes/platinum/client';
import { preparePlatinumTemplateRegion } from './platinum-templates';
import type { PlatinumClient } from './platinum-templates';

const snapshotName = 'kortix-default-content-hash';
const templateId = 'tpl_exact';
const region = 'us-east';
const client: PlatinumClient = {
  isConfigured: () => true,
  async json<T>(): Promise<T> {
    return [{ id: templateId, name: snapshotName, state: 'ready' }] as T;
  },
};

type PrepareBody = {
  template_id: string;
  region: string;
  state: string;
  status: string;
  retry_after_ms?: number;
};

function response(
  state: string,
  status: string,
  httpStatus = 202,
): PlatinumJsonResponse<PrepareBody> {
  return {
    status: httpStatus,
    body: { template_id: templateId, region, state, status, retry_after_ms: 0 },
  };
}

function sequence(replies: PlatinumJsonResponse<PrepareBody>[], seen: string[] = []) {
  let position = 0;
  return async <T>(path: string, init: RequestInit = {}): Promise<PlatinumJsonResponse<T>> => {
    seen.push(`${init.method} ${path} ${String(init.body)}`);
    const reply = replies[Math.min(position++, replies.length - 1)];
    if (!reply) throw new Error('sequence needs at least one reply');
    return { status: reply.status, body: reply.body as T };
  };
}

describe('preparePlatinumTemplateRegion', () => {
  test('polls every pending answer of the prepare contract until HTTP 200 ready', async () => {
    const seen: string[] = [];
    const result = await preparePlatinumTemplateRegion(snapshotName, region, {
      client,
      request: sequence(
        [
          response('absent', 'queued'),
          // The control plane running the copy answers this until it finishes.
          response('replicating', 'queued'),
          response('replicating', 'copying'),
          response('failed', 'cooling_down'),
          // A failed copy past its cooldown is requeued.
          response('failed', 'queued'),
          response('ready', 'ready', 200),
        ],
        seen,
      ),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ templateId, region });
    expect(seen).toHaveLength(6);
    expect(seen[0]).toBe(`POST /v1/templates/${templateId}/prepare {"region":"${region}"}`);
  });

  test.each(['template_id', 'region'] as const)(
    'rejects a ready answer with the wrong %s',
    async (field) => {
      const reply = response('ready', 'ready', 200);
      reply.body[field] = 'wrong';
      await expect(
        preparePlatinumTemplateRegion(snapshotName, region, {
          client,
          request: sequence([reply]),
        }),
      ).rejects.toThrow('identity/region mismatch');
    },
  );

  test.each([
    ['ready/ready with 202', response('ready', 'ready')],
    ['pending with 200', response('absent', 'queued', 200)],
    ['unknown status', response('failed', 'ready')],
    ['unknown state', response('deprecated', 'queued')],
    [
      'missing retry_after_ms',
      { status: 202, body: { template_id: templateId, region, state: 'absent', status: 'queued' } },
    ],
  ])('rejects an answer outside the contract: %s', async (_name, reply) => {
    await expect(
      preparePlatinumTemplateRegion(snapshotName, region, {
        client,
        request: sequence([reply as PlatinumJsonResponse<PrepareBody>]),
      }),
    ).rejects.toThrow('invalid residency response');
  });

  test.each([
    ['absent', 'queued'],
    ['replicating', 'copying'],
    ['failed', 'cooling_down'],
  ] as const)('%s/%s is never reported as resident at the deadline', async (state, status) => {
    await expect(
      preparePlatinumTemplateRegion(snapshotName, region, {
        client,
        request: sequence([response(state, status)]),
        timeoutMs: 30,
      }),
    ).rejects.toThrow(`last state: ${state}/${status}`);
  });

  test('the deadline aborts a stalled HTTP request, not only the polling loop', async () => {
    let aborted = false;
    await expect(
      preparePlatinumTemplateRegion(snapshotName, region, {
        client,
        request: async <T>(
          _path: string,
          init: RequestInit = {},
        ): Promise<PlatinumJsonResponse<T>> => {
          const { promise, reject } = Promise.withResolvers<PlatinumJsonResponse<T>>();
          const signal = init.signal;
          if (!signal) throw new Error('prepare must pass an abort signal');
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
          return promise;
        },
        timeoutMs: 30,
      }),
    ).rejects.toThrow('within 30ms');
    expect(aborted).toBe(true);
  });

  test('a template Platinum does not list fails before any prepare call', async () => {
    const seen: string[] = [];
    await expect(
      preparePlatinumTemplateRegion(snapshotName, region, {
        client: { isConfigured: () => true, json: async <T>() => [] as T },
        request: sequence([response('ready', 'ready', 200)], seen),
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
