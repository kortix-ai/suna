import { afterEach, describe, expect, mock, test } from 'bun:test';

// When set, `sandboxOpencodeEndpoint` throws this error instead of resolving —
// simulates a Daytona 429 `ThrottlerException` / archived box on preview-link
// resolution (the post-#3567 recurrence path).
let endpointThrow: Error | null = null;
let endpointResult: { url: string; headers: Record<string, string> } | null = {
  url: 'http://daemon.local',
  headers: {},
};
let ensuredPin: string | null = 'oc-root-1';
let ensuredReason: 'unchanged' | 'healed' | 'not_ready' | 'unreachable' = 'unchanged';

mock.module('../projects/opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => {
    if (endpointThrow) throw endpointThrow;
    return endpointResult;
  },
  ensureOpencodeSessionPin: async () => ({
    pin: ensuredPin,
    changed: false,
    reason: ensuredReason,
    sessions: [],
  }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  },
}));

const { buildSessionTranscriptDigest } = await import('../projects/lib/session-transcript');

afterEach(() => {
  endpointThrow = null;
  endpointResult = { url: 'http://daemon.local', headers: {} };
  ensuredPin = 'oc-root-1';
  ensuredReason = 'unchanged';
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'account-1',
    opencodeSessionId: 'oc-root-1',
    status: 'running',
    // Embeds the external id (/p/<externalId>/) so resolveSessionExternalId
    // short-circuits without a DB hit.
    sandboxUrl: 'https://preview.kortix.com/v1/p/sandbox-ext-1/8000',
    metadata: {},
    ...overrides,
  } as any;
}

describe('buildSessionTranscriptDigest', () => {
  test('degrades to an unavailable digest when endpoint resolution throws a Daytona 429 (post-#3567 regression)', async () => {
    // Regression: sandboxOpencodeEndpoint resolves the Daytona preview link,
    // which throws DaytonaRateLimitError / ThrottlerException when the shared
    // org is throttled. The transcript read must NOT 500 / surface an unhandled
    // Sentry event — it must degrade to an unavailable digest (sibling of the
    // #3567 title-sync fix; this is the post-#3567 call site that was left
    // unguarded).
    endpointThrow = new Error('DaytonaRateLimitError: ThrottlerException: Too Many Requests');
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(false);
    expect(result.message_count).toBe(0);
    expect(result.opencode_session_id).toBe('oc-root-1');
    // The provider error is surfaced as a controlled reason (NOT propagated),
    // so the route returns a 200 unavailable digest instead of 500ing.
    expect(result.reason).toContain('could not reach sandbox');
    expect(result.reason).toContain('ThrottlerException');
  });

  test('degrades to unavailable when the sandbox has no service key', async () => {
    endpointResult = null;
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('service key');
  });

  test('returns a real transcript when the daemon answers', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            info: { role: 'assistant', time: { created: 1000, completed: 2000 } },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const result = await buildSessionTranscriptDigest({
      session: session(),
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    });
    expect(result.available).toBe(true);
    expect(result.message_count).toBe(1);
    expect(result.messages[0].text).toBe('hello');
  });
});
