import { afterEach, describe, expect, test } from 'bun:test';
import { describeSlackConversation, slackSendsForm } from '../channels/slack-api';

/**
 * Every Slack binding on dev had no name (2026-10-02): `getChannelName` sent
 * `conversations.info` as JSON, Slack's read methods drop a JSON body, and
 * every lookup answered `channel_not_found`. The settings page and the session
 * then showed `C0…` / `U0…` ids instead of `#general` and a person's name.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  contentType: string | null;
  params: URLSearchParams;
}

function slack(answers: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    const contentType = new Headers(init?.headers).get('content-type');
    calls.push({ method, contentType, params: new URLSearchParams(String(init?.body ?? '')) });
    const body = typeof answers[method] === 'function' ? (answers[method] as (c: Call) => unknown)(calls.at(-1)!) : answers[method];
    return new Response(JSON.stringify(body ?? { ok: false, error: 'unknown_method' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return calls;
}

describe('describeSlackConversation', () => {
  test('asks Slack form-encoded, so the channel id reaches it', async () => {
    const calls = slack({ 'conversations.info': { ok: true, channel: { id: 'C0TEST1', name: 'general', is_channel: true } } });

    await describeSlackConversation('xoxb-test', 'C0TEST1');

    expect(calls[0]?.method).toBe('conversations.info');
    expect(calls[0]?.contentType).toContain('application/x-www-form-urlencoded');
    expect(calls[0]?.params.get('channel')).toBe('C0TEST1');
  });

  test('a public channel is its name', async () => {
    slack({ 'conversations.info': { ok: true, channel: { id: 'C0TEST1', name: 'general', is_channel: true } } });
    expect(await describeSlackConversation('xoxb-test', 'C0TEST1')).toEqual({
      name: 'general',
      type: 'channel',
      unavailable: false,
    });
  });

  test('a private channel says so', async () => {
    slack({ 'conversations.info': { ok: true, channel: { id: 'C0TEST2', name: 'launch-plan', is_channel: true, is_private: true } } });
    expect(await describeSlackConversation('xoxb-test', 'C0TEST2')).toEqual({
      name: 'launch-plan',
      type: 'private_channel',
      unavailable: false,
    });
  });

  test("a direct message is the other person's display name", async () => {
    const calls = slack({
      'conversations.info': { ok: true, channel: { id: 'D0TEST1', is_im: true, user: 'U0TEST9' } },
      'users.info': { ok: true, user: { id: 'U0TEST9', name: 'sam', profile: { display_name: 'Sam Rivera', real_name: 'Samuel Rivera' } } },
    });

    expect(await describeSlackConversation('xoxb-test', 'D0TEST1')).toEqual({
      name: 'Sam Rivera',
      type: 'im',
      unavailable: false,
    });
    expect(calls[1]?.params.get('user')).toBe('U0TEST9');
  });

  test("a group DM lists its members' handles instead of Slack's mpdm name", async () => {
    slack({ 'conversations.info': { ok: true, channel: { id: 'C0TEST3', name: 'mpdm-sam--alex--kim-1', is_mpim: true } } });
    expect(await describeSlackConversation('xoxb-test', 'C0TEST3')).toEqual({
      name: 'sam, alex, kim',
      type: 'mpim',
      unavailable: false,
    });
  });

  test('a deleted channel, or one the bot left, is unavailable', async () => {
    slack({ 'conversations.info': { ok: false, error: 'channel_not_found' } });
    expect(await describeSlackConversation('xoxb-test', 'C0GONE1')).toEqual({
      name: null,
      type: null,
      unavailable: true,
    });
  });

  test('any other refusal leaves the conversation unknown, not unavailable', async () => {
    slack({ 'conversations.info': { ok: false, error: 'missing_scope' } });
    expect(await describeSlackConversation('xoxb-test', 'C0TEST1')).toEqual({
      name: null,
      type: null,
      unavailable: false,
    });
  });

  test('a direct message whose person Slack cannot name still says it is a DM', async () => {
    slack({
      'conversations.info': { ok: true, channel: { id: 'D0TEST2', is_im: true, user: 'U0TEST8' } },
      'users.info': { ok: false, error: 'user_not_found' },
    });
    expect(await describeSlackConversation('xoxb-test', 'D0TEST2')).toEqual({
      name: null,
      type: 'im',
      unavailable: false,
    });
  });
});

// The same silent failure twice: users.info on 2026-08-19, conversations.info
// until 2026-10-02. Each call site had to remember `form: true`. Now the
// method name decides: no read call can go out as JSON.
describe('slackSendsForm', () => {
  test('every read method goes form-encoded, whatever the caller passed', () => {
    for (const method of ['conversations.info', 'users.info', 'users.list', 'conversations.list', 'conversations.history', 'conversations.replies', 'files.info']) {
      expect(slackSendsForm(method), method).toBe(true);
      expect(slackSendsForm(method, false), method).toBe(true);
    }
  });

  test('a write method keeps JSON unless the caller asks for a form', () => {
    for (const method of ['chat.postMessage', 'chat.update', 'conversations.open', 'conversations.join', 'reactions.add']) {
      expect(slackSendsForm(method), method).toBe(false);
    }
    expect(slackSendsForm('chat.postMessage', true)).toBe(true);
  });
});
