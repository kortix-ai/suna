import { describe, expect, test } from 'bun:test';

import { FeatureNotSupportedError } from './runtime-capabilities';
import { revertSession } from './session-rewind';

function fakeFetch(status: number, body = '') {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('revertSession', () => {
  test('POSTs the message id to the OpenCode revert route with the token', async () => {
    const { fn, calls } = fakeFetch(200, '{}');
    await revertSession({
      sandboxUrl: 'https://sb.example/v1/p/abc/8000/',
      sessionId: 'ses_1',
      messageId: 'msg_2',
      token: 'tok',
      fetchImpl: fn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://sb.example/v1/p/abc/8000/session/ses_1/revert');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ messageID: 'msg_2' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  test('omits Authorization without a token', async () => {
    const { fn, calls } = fakeFetch(200);
    await revertSession({ sandboxUrl: 'https://sb', sessionId: 's', messageId: 'm', token: null, fetchImpl: fn });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('throws with the status and body on a non-OK response', async () => {
    const { fn } = fakeFetch(409, 'Session is busy');
    await expect(
      revertSession({ sandboxUrl: 'https://sb', sessionId: 's', messageId: 'm', token: null, fetchImpl: fn }),
    ).rejects.toThrow('Revert failed (409): Session is busy');
  });

  test("a runtime without rewind (pi) throws its own words, typed", async () => {
    const { fn } = fakeFetch(
      501,
      JSON.stringify({ code: 'feature_not_supported', error: 'session rewind is not supported by the pi harness' }),
    );
    const failure = revertSession({ sandboxUrl: 'https://sb', sessionId: 's', messageId: 'm', token: null, fetchImpl: fn });
    await expect(failure).rejects.toBeInstanceOf(FeatureNotSupportedError);
    await expect(failure).rejects.toThrow('session rewind is not supported by the pi harness');
  });
});
