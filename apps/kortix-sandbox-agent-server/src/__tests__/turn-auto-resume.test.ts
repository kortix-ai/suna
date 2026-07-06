import { describe, expect, test } from 'bun:test';
import type { OpencodeTurnError } from '../opencode-events';
import { createTurnAutoResumer, isTransientTurnError } from '../turn-auto-resume';

describe('isTransientTurnError', () => {
  test('the prod failure — OpenRouter mid-stream idle timeout (JSON-quoted message)', () => {
    expect(
      isTransientTurnError({ name: 'UnknownError', message: '"Upstream idle timeout exceeded"' }),
    ).toBe(true);
  });

  test('opencode retryable flag wins', () => {
    expect(isTransientTurnError({ name: 'APIError', isRetryable: true })).toBe(true);
  });

  test('rate limit and server errors are transient', () => {
    expect(isTransientTurnError({ name: 'APIError', statusCode: 429 })).toBe(true);
    expect(isTransientTurnError({ name: 'APIError', statusCode: 503 })).toBe(true);
    expect(isTransientTurnError({ name: 'APIError', statusCode: 408 })).toBe(true);
  });

  test('user aborts and auth/credit failures are never resumed', () => {
    expect(isTransientTurnError({ name: 'MessageAbortedError', message: 'aborted' })).toBe(false);
    expect(isTransientTurnError({ name: 'ProviderAuthError', providerID: 'kortix' })).toBe(false);
    expect(isTransientTurnError({ name: 'APIError', statusCode: 401 })).toBe(false);
    expect(isTransientTurnError({ name: 'APIError', statusCode: 402, isRetryable: true })).toBe(
      false,
    );
    expect(isTransientTurnError({ name: 'APIError', statusCode: 400 })).toBe(false);
  });

  test('connection failures match by message', () => {
    expect(isTransientTurnError({ message: 'Connection reset by server' })).toBe(true);
    expect(isTransientTurnError({ message: 'fetch failed' })).toBe(true);
    expect(isTransientTurnError({ message: 'socket hang up' })).toBe(true);
  });

  test('unknown errors without a transient shape stay fatal', () => {
    expect(isTransientTurnError(undefined)).toBe(false);
    expect(isTransientTurnError({})).toBe(false);
    expect(isTransientTurnError({ name: 'UnknownError', message: 'model not found' })).toBe(false);
  });
});

// ── resumer harness ──────────────────────────────────────────────────────────

const IDLE_TIMEOUT: OpencodeTurnError = {
  name: 'UnknownError',
  message: '"Upstream idle timeout exceeded"',
};

interface Harness {
  resumer: ReturnType<typeof createTurnAutoResumer>;
  prompts: Array<{ url: string; body: unknown }>;
  setLastMessage: (m: { role: string; error?: boolean; completed?: boolean } | null) => void;
  setIsRoot: (v: boolean) => void;
  advance: (ms: number) => void;
}

function makeHarness(): Harness {
  let lastMessage: { role: string; error?: boolean; completed?: boolean } | null = {
    role: 'assistant',
    error: true,
    completed: true,
  };
  let isRoot = true;
  let clock = 1_000_000;
  const prompts: Array<{ url: string; body: unknown }> = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/prompt_async')) {
      prompts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/message')) {
      const rows = lastMessage
        ? [
            {
              info: {
                role: lastMessage.role,
                ...(lastMessage.error ? { error: { name: 'UnknownError' } } : {}),
                time: lastMessage.completed ? { completed: clock } : {},
              },
            },
          ]
        : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  const resumer = createTurnAutoResumer({
    opencode: { getInternalUrl: () => 'http://127.0.0.1:4096' },
    cfg: { workspace: '/workspace' },
    isRoot: async () => isRoot,
    fetchImpl,
    sleep: async () => {},
    now: () => clock,
  });

  return {
    resumer,
    prompts,
    setLastMessage: (m) => {
      lastMessage = m;
    },
    setIsRoot: (v) => {
      isRoot = v;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('createTurnAutoResumer', () => {
  test('delivers a resume prompt for a transient root-turn error', async () => {
    const h = makeHarness();
    const resumed = await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT);
    expect(resumed).toBe(true);
    expect(h.prompts.length).toBe(1);
    const prompt = h.prompts[0];
    if (!prompt) throw new Error('expected a delivered prompt');
    const body = prompt.body as { parts: Array<{ type: string; text: string }> };
    const part = body.parts[0];
    if (!part) throw new Error('expected a text part');
    expect(part.type).toBe('text');
    expect(part.text).toContain('Upstream idle timeout exceeded');
    expect(part.text).toContain('Do not redo work that already succeeded');
    // No model override — the session keeps its own model.
    expect('model' in (prompt.body as Record<string, unknown>)).toBe(false);
  });

  test('never resumes a subagent session', async () => {
    const h = makeHarness();
    h.setIsRoot(false);
    expect(await h.resumer.maybeResume('ses_child', IDLE_TIMEOUT)).toBe(false);
    expect(h.prompts.length).toBe(0);
  });

  test('never resumes a permanent error', async () => {
    const h = makeHarness();
    expect(
      await h.resumer.maybeResume('ses_root', { name: 'MessageAbortedError', message: 'aborted' }),
    ).toBe(false);
    expect(h.prompts.length).toBe(0);
  });

  test('budget: at most 3 resumes per window, then the error surfaces', async () => {
    const h = makeHarness();
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(true);
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(true);
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(true);
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(false);
    expect(h.prompts.length).toBe(3);
    // Budget replenishes after the window passes.
    h.advance(16 * 60_000);
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(true);
    expect(h.prompts.length).toBe(4);
  });

  test('budget is per-session', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) await h.resumer.maybeResume('ses_a', IDLE_TIMEOUT);
    expect(await h.resumer.maybeResume('ses_a', IDLE_TIMEOUT)).toBe(false);
    expect(await h.resumer.maybeResume('ses_b', IDLE_TIMEOUT)).toBe(true);
  });

  test('skips (but suppresses the stale error) when the session moved on during backoff', async () => {
    const h = makeHarness();
    h.setLastMessage({ role: 'user' });
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(true);
    expect(h.prompts.length).toBe(0);
  });

  test('surfaces the error when the session cannot be inspected', async () => {
    const h = makeHarness();
    h.setLastMessage(null);
    expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(false);
    expect(h.prompts.length).toBe(0);
  });

  test('kill switch KORTIX_TURN_AUTO_RESUME=0 disables resumes', async () => {
    const h = makeHarness();
    process.env.KORTIX_TURN_AUTO_RESUME = '0';
    try {
      expect(await h.resumer.maybeResume('ses_root', IDLE_TIMEOUT)).toBe(false);
      expect(h.prompts.length).toBe(0);
    } finally {
      delete process.env.KORTIX_TURN_AUTO_RESUME;
    }
  });
});
