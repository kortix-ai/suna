import { describe, expect, test } from 'bun:test';
import { preparePlatinumTemplateRegion } from './platinum-templates';
import type { PlatinumClient } from './platinum-templates';
import type { PlatinumJsonResponse } from '../../shared/platinum';

const snapshotName = 'kortix-default-content-hash';
const templateId = 'tpl_exact';
const region = 'us-east';
const client: PlatinumClient = {
  isConfigured: () => true,
  async json<T>(): Promise<T> {
    return [{ id: templateId, name: snapshotName, state: 'ready' }] as T;
  },
};

type PrepareReply = PlatinumJsonResponse<{
  template_id: string;
  region: string;
  state: string;
  status: string;
  retry_after_ms: number;
}>;

function response(state: string, status: string, httpStatus = 202) {
  return {
    status: httpStatus,
    body: { template_id: templateId, region, state, status, retry_after_ms: 0 },
  };
}

function sequence(replies: PrepareReply[]) {
  let position = 0;
  return async <T>(): Promise<PlatinumJsonResponse<T>> => {
    const reply = replies[Math.min(position++, replies.length - 1)]!;
    return { status: reply.status, body: reply.body as T };
  };
}

describe('Platinum regional image release gate', () => {
  test('absent, copying, and cooldown must settle to HTTP 200 ready', async () => {
    const result = await preparePlatinumTemplateRegion(snapshotName, region, {
      client,
      request: sequence([
        response('absent', 'queued'),
        response('replicating', 'copying'),
        response('failed', 'cooling_down'),
        response('ready', 'ready', 200),
      ]),
      timeoutMs: 2_000,
    });
    expect(result).toEqual({ templateId, region });
  });

  test.each(['template_id', 'region'] as const)('rejects a ready response with the wrong %s', async (field) => {
    const reply = response('ready', 'ready', 200);
    reply.body[field] = 'wrong';
    await expect(preparePlatinumTemplateRegion(snapshotName, region, {
      client, request: sequence([reply]),
    })).rejects.toThrow('identity/region mismatch');
  });

  test.each([
    response('ready', 'ready'),
    response('absent', 'queued', 200),
    response('failed', 'ready'),
  ])('rejects contradictory HTTP/state/status readiness', async (reply) => {
    await expect(preparePlatinumTemplateRegion(snapshotName, region, {
      client, request: sequence([reply]),
    })).rejects.toThrow('invalid residency response');
  });

  test.each([
    ['absent', 'queued'],
    ['replicating', 'copying'],
    ['failed', 'cooling_down'],
  ])('%s/%s never resolves as ready at the deadline', async (state, status) => {
    await expect(preparePlatinumTemplateRegion(snapshotName, region, {
      client,
      request: sequence([response(state!, status!)]),
      timeoutMs: 30,
    })).rejects.toThrow(`last state: ${state}/${status}`);
  });

  test('the deadline aborts a stalled HTTP request, not just the polling loop', async () => {
    let aborted = false;
    await expect(preparePlatinumTemplateRegion(snapshotName, region, {
      client,
      request: async <T>(_path: string, init: RequestInit = {}): Promise<PlatinumJsonResponse<T>> => {
        const { promise, reject } = Promise.withResolvers<PlatinumJsonResponse<T>>();
        init.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal!.reason);
        }, { once: true });
        return promise;
      },
      timeoutMs: 30,
    })).rejects.toThrow('within 30ms');
    expect(aborted).toBe(true);
  });
});
