import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

/**
 * Characterization: the four one-sided runtime calls fail OPEN when the box is
 * unreachable on the wire. A network throw must become their own default —
 * `false`, `false`, `false`, `'unreachable'` — and must never escape to the
 * caller. Pinned before the four copies of the resolve → build URL → fetch →
 * bounded-timeout → catch scaffold became one shared helper.
 *
 * The four:
 *   - `removeStrandedOpencodeMessage` (runtime-client)
 *   - `queuedContinueHasStagedRevert` (runtime-client)
 *   - `abortRuntimeTurn` (abort-runtime-turn)
 *   - `releaseRuntimeQuestion` (release-runtime-question)
 */

const SESSION_ID = 'sess-fail-open-1';
const OC_SESSION_ID = 'oc-fail-open-1';

mock.module('../lib/config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../lib/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              opencodeSessionId: OC_SESSION_ID,
              sandboxUrl: 'https://box.test/p/ext-fail-open/8000/',
              accountId: 'acct-1',
              projectId: 'proj-1',
              createdBy: 'user-1',
            },
          ],
        }),
      }),
    }),
  },
}));

// The session's signed proxy endpoint. The transport itself is the real one:
// the test stubs `fetch` below so the network throw happens at the wire.
const realOpencodeMapping = await import('../services/sessions/opencode-mapping');
mock.module('../services/sessions/opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({
    url: 'https://box.test/p/ext-fail-open/8000',
    headers: { 'x-kortix': '1' },
  }),
}));

const originalFetch = globalThis.fetch;

const row = { commandId: 'cmd-1', sessionId: SESSION_ID, actorUserId: null } as never;

describe('one-sided runtime calls fail open on a network throw', () => {
  beforeAll(() => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('removeStrandedOpencodeMessage reports false', async () => {
    const { removeStrandedOpencodeMessage } = await import(
      '../services/sessions/lifecycle/runtime-client'
    );
    expect(await removeStrandedOpencodeMessage(row, 'msg_0198f3a1b2c4AbCdEfGhIjKlMn')).toBe(false);
  });

  test('queuedContinueHasStagedRevert reports false', async () => {
    const { queuedContinueHasStagedRevert } = await import(
      '../services/sessions/lifecycle/runtime-client'
    );
    expect(await queuedContinueHasStagedRevert(row)).toBe(false);
  });

  test('abortRuntimeTurn reports false', async () => {
    const { abortRuntimeTurn } = await import('../services/sessions/lifecycle/abort-runtime-turn');
    expect(await abortRuntimeTurn(SESSION_ID)).toBe(false);
  });

  test('releaseRuntimeQuestion reports unreachable', async () => {
    const { releaseRuntimeQuestion } = await import(
      '../services/sessions/lifecycle/release-runtime-question'
    );
    expect(await releaseRuntimeQuestion(SESSION_ID, 'que_1', [['sentinel']])).toBe('unreachable');
  });
});
