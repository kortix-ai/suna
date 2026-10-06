// `deliverSteer` (R10): what an admitted steer row puts on the wire and how
// each answer settles the row. `mock.module` is process-global; run with
// `bun test --isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';

const realRuntimeClient = await import('./runtime-client');
const realDeliver = await import('./deliver');
const realStore = await import('./store');
const realTransitions = await import('./command-transitions');

let awake: { externalId: string; opencodeSessionId: string; stage: string } | null = null;
let answer: () => Promise<string> = async () => 'accepted';
const posts: Array<{ key: string; opts: Record<string, unknown> }> = [];
const forwarded: Array<{ wireMessageId: string; opts: unknown }> = [];
const fallbacks: string[] = [];
const requeues: string[] = [];
const failures: string[] = [];

mock.module('./deliver', () => ({ ...realDeliver, awakeDeliveryTarget: async () => awake }));
mock.module('./inbox-delivery-hold', () => ({
  InboxDeliveryPaused: class extends Error {},
  assertInboxDeliveryActive: async () => undefined,
  returnClaimToQueue: async () => undefined,
}));
mock.module('./runtime-client', () => ({
  ...realRuntimeClient,
  postPrompt: async (_e: string, _s: string, _t: string, _u: string, _sid: string, key: string, opts: Record<string, unknown>) => {
    posts.push({ key, opts });
    return answer();
  },
}));
mock.module('./command-transitions', () => ({
  ...realTransitions,
  recordSteerFallback: async (_row: unknown, reason: string) => {
    fallbacks.push(reason);
  },
}));
mock.module('./store', () => ({
  ...realStore,
  markCommandForwarded: async (_row: unknown, _sid: string, wireMessageId: string, opts: unknown) => {
    forwarded.push({ wireMessageId, opts });
    return true;
  },
  requeueForAdmission: async (_row: unknown, reason: string) => {
    requeues.push(reason);
    return true;
  },
  markCommandFailed: async (_row: unknown, message: string) => {
    failures.push(message);
  },
  parkPromptForUnreachableRuntime: async () => ({ parked: true }),
}));

const { deliverSteer } = await import('./queued-continue-delivery');
const { ProvisionTimeline } = await import('../../platform/services/provision-timeline');

const row = {
  commandId: 'cmd-steer-1',
  sessionId: 'sess-steer-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  actorUserId: 'user-1',
  source: 'ui',
  attempts: 1,
  createdAt: new Date(),
} as SessionLifecycleCommandRow;
const payload = {
  text: 'also run the tests',
  clientMessageId: 'c1',
  wireMessageId: 'msg_steer1',
  delivery: 'steer' as const,
  parts: [{ type: 'text' as const, text: 'also run the tests' }],
};
const steer = () => deliverSteer(row, payload, payload.text, 'msg_turn1', new ProvisionTimeline('t', 'deliver'));

beforeEach(() => {
  awake = { externalId: 'box-1', opencodeSessionId: 'ses_1', stage: 'ready' };
  answer = async () => 'accepted';
  for (const list of [posts, forwarded, fallbacks, requeues, failures]) list.length = 0;
});

describe('deliverSteer', () => {
  test('a taken steer is forwarded under the client id and names the turn it went into', async () => {
    expect(await steer()).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toBe('cmd-steer-1:steer');
    expect(posts[0]!.opts).toMatchObject({ steer: true, wireMessageId: 'msg_steer1', parts: payload.parts });
    expect(forwarded).toEqual([{ wireMessageId: 'msg_steer1', opts: { steeredIntoMessageId: 'msg_turn1' } }]);
  });

  test('no awake box: nothing is posted, the row falls back turn_ended and is requeued', async () => {
    awake = null;
    expect(await steer()).toBe('queued');
    expect(posts).toHaveLength(0);
    expect(fallbacks).toEqual(['turn_ended']);
    expect(requeues).toEqual(['turn_active']);
    expect(failures).toEqual([]);
  });

  test('409 no_active_turn and 501 fall back without spending an attempt', async () => {
    for (const reason of ['turn_ended', 'unsupported'] as const) {
      answer = async () => {
        throw new realRuntimeClient.SteerNotTaken(reason);
      };
      expect(await steer()).toBe('queued');
    }
    expect(fallbacks).toEqual(['turn_ended', 'unsupported']);
    expect(requeues).toEqual(['turn_active', 'turn_active']);
    expect(forwarded).toEqual([]);
    expect(failures).toEqual([]);
  });

  test('a refusal that is not a fallback fails the row as a prompt refusal does', async () => {
    answer = async () => 'failed';
    expect(await steer()).toBe('failed');
    expect(failures).toHaveLength(1);
    expect(fallbacks).toEqual([]);
  });
});
