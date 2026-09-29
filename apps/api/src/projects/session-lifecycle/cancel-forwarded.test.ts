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
let deletedMessages: string[] = [];
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

mock.module('../sandbox-turn-lifecycle', () => ({
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
  deletedMessages = [];
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
    const tipBody = [
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
    ];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE')
        throw new Error('must not delete an answered prompt');
      return Response.json(tipBody);
    }) as unknown as typeof fetch;
    expect(await cancelForwardedPrompt(SESSION_ID, PROMPT_ID)).toEqual({ outcome: 'answered' });
  });

  test('an unanswered tip lets the whole-message delete take it back out', async () => {
    const tipBody = [
      { info: { id: TARGET, role: 'user', time: { created: T } }, parts: [{ id: 'prt_u' }] },
    ];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deletedMessages.push(decodeURIComponent(String(url)));
        return new Response(null, { status: 200 });
      }
      return Response.json(tipBody);
    }) as unknown as typeof fetch;

    const out = await cancelForwardedPrompt(SESSION_ID, PROMPT_ID);

    expect(out.outcome).toBe('cancelled');
    expect(deletedMessages).toEqual([
      `https://box.test/p/${EXTERNAL_ID}/8000/session/${OC_SESSION_ID}/message/${TARGET}?directory=/workspace`,
    ]);
    expect(closedTurns).toEqual([TARGET]);
  });
});
