import { afterEach, describe, expect, test } from 'bun:test';
import { postBlocks, postMessage, startStream } from '../channels/slack-api';
import { slackPersonaFor } from '../channels/slack/persona';

/**
 * Every message a Kortix agent writes in Slack carries that agent's name as
 * its author (`username`, `chat:write.customize`), so a thread shows which
 * agent answered instead of "Kortix" for all of them. Kortix's own notices
 * carry none.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function slack(answer: (call: Call, index: number) => unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    const raw = String(init?.body ?? '');
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    return new Response(JSON.stringify(answer(calls.at(-1)!, calls.length - 1)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return calls;
}

const persona = { username: 'research' };

describe('Slack agent persona', () => {
  test('the agent name is the author of a post, a block post and a stream', async () => {
    const calls = slack(() => ({ ok: true, ts: '1.1' }));
    await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona);
    await postBlocks('xoxb-test', 'C1', 'hi', [], '1.0', persona);
    await startStream('xoxb-test', 'C1', '1.0', 'U1', 'T1', [], persona);
    expect(calls.map((c) => [c.method, c.body.username])).toEqual([
      ['chat.postMessage', 'research'],
      ['chat.postMessage', 'research'],
      ['chat.startStream', 'research'],
    ]);
  });

  test('without chat:write.customize the post is sent once more as Kortix, not lost', async () => {
    const calls = slack((_call, i) => (i === 0 ? { ok: false, error: 'missing_scope' } : { ok: true, ts: '1.2' }));
    expect(await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona)).toBe('1.2');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.username).toBe('research');
    expect(calls[1]?.body.username).toBeUndefined();
  });

  test('any other refusal is not retried', async () => {
    const calls = slack(() => ({ ok: false, error: 'channel_not_found' }));
    expect(await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("Kortix's own notice carries no author", async () => {
    const calls = slack(() => ({ ok: true, ts: '1.3' }));
    await postMessage('xoxb-test', 'C1', 'hi', '1.0');
    expect(calls[0]?.body.username).toBeUndefined();
  });

  test('a persona is the trimmed agent name, none for a blank one', () => {
    expect(slackPersonaFor(' research ')).toEqual({ username: 'research' });
    expect(slackPersonaFor('')).toBeNull();
    expect(slackPersonaFor(null)).toBeNull();
    expect(slackPersonaFor('a'.repeat(100))?.username).toHaveLength(80);
  });
});
