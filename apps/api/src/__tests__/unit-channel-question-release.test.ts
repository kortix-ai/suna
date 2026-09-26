import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { channelOfSessionMetadata, questionReleaseSentinel } from '../channels/question-release';

// The agent's `question` tool BLOCKS. In a chat channel the answer arrives
// later as a new turn, so the call must be released or the turn hangs. That
// release lived only in the image-baked daemons, gated on SLACK_* env — a
// Teams agent that asked a question hung after its card was posted. These pin
// the server-side release that reaches every existing sandbox.

describe('channelOfSessionMetadata', () => {
  test('reads the source the channel wrote at creation', () => {
    expect(channelOfSessionMetadata({ source: 'teams' })).toBe('teams');
    expect(channelOfSessionMetadata({ source: 'slack' })).toBe('slack');
  });

  test('falls back to the per-channel block when source is absent', () => {
    expect(channelOfSessionMetadata({ teams: { conversation_id: '19:x' } })).toBe('teams');
    expect(channelOfSessionMetadata({ slack: { channel: 'C1' } })).toBe('slack');
  });

  test('a dashboard session is NOT a channel — its UI answers the question', () => {
    // Releasing a dashboard question is the "every question is auto-answered
    // even outside Slack" bug the daemon's own header describes.
    expect(channelOfSessionMetadata({ source: 'web' })).toBeNull();
    expect(channelOfSessionMetadata({})).toBeNull();
    expect(channelOfSessionMetadata(null)).toBeNull();
    expect(channelOfSessionMetadata(undefined)).toBeNull();
    expect(channelOfSessionMetadata('teams')).toBeNull();
  });

  test('a null per-channel block is not mistaken for one', () => {
    // `typeof null === "object"`; the guard must not treat null as a block.
    expect(channelOfSessionMetadata({ teams: null, slack: null })).toBeNull();
  });
});

describe('questionReleaseSentinel', () => {
  test('a posted question tells the agent to end the turn', () => {
    const s = questionReleaseSentinel('teams', true);
    expect(s).toContain('Posted to the Teams conversation');
    expect(s).toContain('finish this turn now');
    // A `teams send` after the card would be a second reply to one question.
    expect(s).toContain('post nothing else');
    expect(s).toContain('NEW turn');
  });

  test('names the channel it was actually in', () => {
    expect(questionReleaseSentinel('slack', true)).toContain('the Slack thread');
    expect(questionReleaseSentinel('teams', true)).not.toContain('Slack');
  });

  test('never tells the agent to stop using the question tool', () => {
    // The old daemon's Slack sentinel ended "Next time, just ask with `slack
    // send` rather than the question tool" — the opposite of the Slack prompt.
    for (const channel of ['teams', 'slack'] as const) {
      for (const posted of [true, false]) {
        expect(questionReleaseSentinel(channel, posted)).not.toMatch(/rather than the question tool/);
      }
    }
  });

  test('an UNposted question says so, and points at the channel`s own send', () => {
    // The user never saw it. Letting the agent believe it asked is a dead end.
    const teams = questionReleaseSentinel('teams', false);
    expect(teams).toContain('could NOT be posted');
    expect(teams).toContain('`teams send`');
    expect(questionReleaseSentinel('slack', false)).toContain('`slack send`');
  });
});

describe('releaseRuntimeQuestion — the runtime contract', () => {
  // OpenCode and the pi harness both serve POST /question/:id/reply:
  // 200 `true` on the first reply, 404 once the question is answered.
  let calls: Array<{ url: string; init: RequestInit }> = [];
  let status = 200;
  let resolved: { endpoint: { url: string; headers: Record<string, string> } } | null = {
    endpoint: { url: 'http://sandbox.internal', headers: { 'X-Sandbox-Token': 't' } },
  };

  mock.module('../projects/session-lifecycle/runtime-client', () => ({
    resolveSessionOpencodeEndpoint: async () => resolved,
  }));

  const realFetch = globalThis.fetch;
  beforeEach(() => {
    calls = [];
    status = 200;
    resolved = { endpoint: { url: 'http://sandbox.internal', headers: { 'X-Sandbox-Token': 't' } } };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? 'true' : '{}', { status });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const load = async () => await import('../projects/session-lifecycle/release-runtime-question');

  test('posts the answers to the runtime`s own reply endpoint', async () => {
    const { releaseRuntimeQuestion } = await load();

    expect(await releaseRuntimeQuestion('sess-1', 'que_abc', [['a sentinel']])).toBe('released');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://sandbox.internal/question/que_abc/reply?directory=%2Fworkspace');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ answers: [['a sentinel']] });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Sandbox-Token']).toBe('t');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('a 404 is "already answered", not a failure — a new daemon may release too', async () => {
    status = 404;
    const { releaseRuntimeQuestion } = await load();

    expect(await releaseRuntimeQuestion('sess-1', 'que_abc', [['x']])).toBe('already_answered');
  });

  test('any other failure is reported as unreachable, never thrown', async () => {
    status = 500;
    const { releaseRuntimeQuestion } = await load();
    expect(await releaseRuntimeQuestion('sess-1', 'que_abc', [['x']])).toBe('unreachable');

    resolved = null;
    expect(await releaseRuntimeQuestion('sess-1', 'que_abc', [['x']])).toBe('unreachable');
  });

  test('refuses to guess an id it was not given', async () => {
    const { releaseRuntimeQuestion } = await load();

    expect(await releaseRuntimeQuestion('sess-1', '', [['x']])).toBe('unreachable');
    expect(calls).toEqual([]);
  });

  test('an id with reserved characters is escaped into the path', async () => {
    const { releaseRuntimeQuestion } = await load();

    await releaseRuntimeQuestion('sess-1', 'a/b?c', [['x']]);
    expect(calls[0].url).toContain('/question/a%2Fb%3Fc/reply');
  });
});

// Asserted on source: the
// release is one branch inside a route handler with no seam to import, and
// what matters is which inputs gate it and where it sits.
describe('POST /turn-question releases channel questions, and only those', () => {
  const src = Bun.file(new URL('../projects/routes/turn-questions.ts', import.meta.url).pathname);

  const handler = async () => {
    const all = await src.text();
    const start = all.indexOf("path: '/{projectId}/turn-question'");
    expect(start, 'turn-question route is missing').toBeGreaterThan(-1);
    const rest = all.slice(start);
    return rest.slice(0, rest.indexOf('\n);\n'));
  };

  test('reads the channel from the SESSION`s metadata, not the live-turn row', async () => {
    const body = await handler();
    expect(body).toContain('metadata: projectSessions.metadata');
    expect(body).toContain('channelOfSessionMetadata(turnQuestionSession.metadata)');
  });

  test('releases only a channel session, and only with a real runtime id', async () => {
    const body = await handler();
    // The `q-<session>` fallback used for persistence names nothing the runtime
    // can answer, so the release must key on the caller's own request_id.
    expect(body).toContain('const runtimeRequestId = body.request_id?.trim();');
    expect(body).toContain('if (channel && runtimeRequestId)');
  });

  test('tells the agent whether the card was actually posted', async () => {
    const body = await handler();
    expect(body).toContain('posted: result.ok');
  });

  test('releases BEFORE responding — the daemon is still awaiting this request', async () => {
    // Ordering is what makes the server's sentinel win over an old daemon's.
    const body = await handler();
    const releaseAt = body.indexOf('await releaseChannelQuestion(');
    const firstReturnAfterRelay = body.indexOf('return c.json', body.indexOf('relayTurnQuestion('));
    expect(releaseAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeLessThan(firstReturnAfterRelay);
  });
});
