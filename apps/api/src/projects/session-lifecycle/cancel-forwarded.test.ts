import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { WIRE_ID_TIME_SCALE } from '../wire-message-id';

/**
 * First unit coverage for `cancelForwardedPrompt` — the tip read and the
 * outcomes it maps. The two paths a click exercises when the box is reachable
 * are covered loosely, but the failure ladder (unresolved endpoint, refused
 * tip, thrown tip) and the "answered" verdict had none. The dedupe of the
 * bespoke fetch blocks must leave each of these exactly as it was.
 *
 * The signed proxy endpoint resolves through the real `runtime-client` and its
 * real helpers; `opencode-mapping` and the db row are the only stubs, plus the
 * `fetch` that stands in for the box.
 */

const SESSION_ID = 'sess-cancel-1';
const PROMPT_ID = 'cmd-cancel-1';
const OC_SESSION_ID = 'oc-cancel-1';
const EXTERNAL_ID = 'ext-cancel-1';
const T = 1_800_000_000_000;

const wireId = (ms: number, tail: string) =>
  `msg_${((BigInt(ms) * WIRE_ID_TIME_SCALE + BigInt(1)) & BigInt(0xffffffffffff))
    .toString(16)
    .padStart(12, '0')}${tail}`;

const TARGET = wireId(T, 'TARGETTARGETT');
const ANSWER = wireId(T + 1_000, 'ASSTMASSTMASST');

const inboxRow = {
  commandId: PROMPT_ID,
  status: 'succeeded',
  result: { status: 'forwarded', forwarded_message_id: TARGET },
  payload: {},
  actorUserId: 'user-1',
  sessionId: SESSION_ID,
} as never;

let selectResults: unknown[] = [];
let sessionRow: Record<string, unknown> | null = null;
let closedTurns: string[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            projection && 'opencodeSessionId' in projection
              ? sessionRow
                ? [sessionRow]
                : []
              : selectResults,
        }),
      }),
    }),
  },
}));

const realOpencodeMapping = await import('../opencode-mapping');
mock.module('../opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({
    url: `https://box.test/p/${EXTERNAL_ID}/8000`,
    headers: { 'x-kortix': '1' },
  }),
}));

mock.module('./inbox-rows', () => ({
  inboxScope: () => undefined,
  deleteInboxRowsWithAttachmentGrace: async () => [inboxRow],
}));

const realTurnLifecycle = await import('../sandbox-turn-lifecycle');
mock.module('../sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  closeSandboxTurnByMessageId: async (_sessionId: string, messageId: string) => {
    closedTurns.push(messageId);
  },
}));

const realFetch = globalThis.fetch;

const { cancelForwardedPrompt } = await import('./cancel-forwarded');

beforeEach(() => {
  selectResults = [inboxRow];
  sessionRow = {
    opencodeSessionId: OC_SESSION_ID,
    sandboxUrl: `https://box.test/p/${EXTERNAL_ID}/8000/`,
    accountId: 'acct-1',
    projectId: 'proj-1',
    createdBy: 'user-1',
  };
  closedTurns = [];
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('cancelForwardedPrompt — the tip read and its failure ladder', () => {
  test('an unresolved endpoint is unreachable', async () => {
    sessionRow = null;
    globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
  });

  test('a refused tip read is unreachable', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
  });

  test('a thrown tip read is unreachable, never a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
  });

  test('a non-array tip body is unreachable', async () => {
    globalThis.fetch = (async () => Response.json({ not: 'an array' })) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
  });

  test('an assistant parented on the target means answered', async () => {
    const tipBody = {
      messages: [
        { info: { id: TARGET, role: 'user', time: { created: T } }, parts: [{ id: 'prt_u' }] },
        {
          info: {
            id: ANSWER,
            role: 'assistant',
            parentID: TARGET,
            time: { created: T + 1_000, completed: T + 1_500 },
          },
          parts: [{ id: 'prt_a' }],
        },
      ],
      has_more: false,
    };
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('must not retract an answered prompt');
      return Response.json(tipBody);
    }) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'answered' });
  });
});

describe('cancelForwardedPrompt — a steer pi has not read (R10)', () => {
  const STEER = wireId(T + 2_000, 'STEERSTEERSTE');
  const steerRow = {
    ...(inboxRow as object),
    result: { status: 'forwarded', forwarded_message_id: STEER, steered_into_message_id: TARGET },
  } as never;
  // The running turn: its prompt and a step newer than the steer, parented on the prompt.
  const tipBody = {
    messages: [
      { info: { id: TARGET, role: 'user', time: { created: T } }, parts: [{ id: 'prt_u' }] },
      { info: { id: wireId(T + 3_000, 'STEPSTEPSTEPS'), role: 'assistant', parentID: TARGET, time: { created: T + 3_000 } }, parts: [] },
    ],
    has_more: false,
  };
  const retracted: string[] = [];
  function box(retract: () => Response) {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        retracted.push(decodeURIComponent(String(url)));
        return retract();
      }
      return Response.json(tipBody);
    }) as unknown as typeof fetch;
  }
  const verb = (status: number, body: unknown) =>
    Response.json(body, { status, headers: { 'X-Kortix-Turn-Verb': '1' } });

  beforeEach(() => {
    selectResults = [steerRow];
    retracted.length = 0;
  });

  test('absent from the transcript, it is withdrawn through the runtime retract', async () => {
    box(() => verb(200, { retracted: true }));
    expect((await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).outcome).toBe('cancelled');
    expect(retracted).toEqual([
      `https://box.test/p/${EXTERNAL_ID}/8000/kortix/runtime/messages/${OC_SESSION_ID}/${STEER}/retract`,
    ]);
  });

  test('a retract answered message_read means the turn read it: answered, the row stays', async () => {
    box(() => verb(409, { code: 'message_read' }));
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'answered' });
  });

  test('a refused retract is unreachable', async () => {
    box(() => verb(503, { code: 'RUNTIME_NOT_READY' }));
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
  });
});

describe('cancelForwardedPrompt — the runtime retract (R7.1)', () => {
  const RUNNING = wireId(T - 5_000, 'RUNNINGRUNNIN');
  // pi admitted the target behind a running turn: the turn's newer step is
  // parented on ITS prompt, so the target is in the transcript and unread.
  const tipBody = {
    messages: [
      { info: { id: RUNNING, role: 'user', time: { created: T - 5_000 } }, parts: [{ id: 'prt_r' }] },
      { info: { id: TARGET, role: 'user', time: { created: T } }, parts: [{ id: 'prt_u' }] },
      { info: { id: wireId(T + 3_000, 'STEPSTEPSTEPS'), role: 'assistant', parentID: RUNNING, time: { created: T + 3_000 } }, parts: [] },
    ],
    has_more: false,
  };
  const calls: string[] = [];
  function box(retract: () => Response) {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = decodeURIComponent(String(url));
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push(`${method} ${target.replace(`https://box.test/p/${EXTERNAL_ID}/8000`, '')}`);
      if (target.endsWith('/retract')) return retract();
      return Response.json(tipBody);
    }) as unknown as typeof fetch;
  }
  const verb = (status: number, body: unknown) =>
    Response.json(body, { status, headers: { 'X-Kortix-Turn-Verb': '1' } });

  beforeEach(() => {
    calls.length = 0;
  });

  test('an unread prompt queued behind the running turn is retracted and the row goes', async () => {
    box(() => verb(200, { retracted: true }));
    expect((await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).outcome).toBe('cancelled');
    expect(calls).toEqual([`POST /kortix/runtime/messages/${OC_SESSION_ID}/${TARGET}/retract`]);
    expect(closedTurns).toEqual([TARGET]);
  });

  test('a retract answered message_read means a model call read it: answered, the row stays', async () => {
    box(() => verb(409, { code: 'message_read', error: 'a model call read this message' }));
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'answered' });
    expect(closedTurns).toEqual([]);
  });

  test('a refused retract is unreachable', async () => {
    box(() => verb(503, { code: 'RUNTIME_NOT_READY' }));
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'unreachable' });
    expect(closedTurns).toEqual([]);
  });
});
