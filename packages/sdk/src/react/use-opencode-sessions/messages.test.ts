import { describe, expect, test, beforeEach, mock } from 'bun:test';

let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });

mock.module('../../opencode/client', () => ({
  getClient: () => ({ session: { prompt: (args: unknown) => promptImpl(args) } }),
}));

import { promptOpenCodeMessage } from './messages';

beforeEach(() => {
  promptImpl = async () => ({ data: {} });
});

describe('promptOpenCodeMessage', () => {
  test('resolves on a successful prompt', async () => {
    let captured: unknown;
    promptImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await expect(
      promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();
    expect(captured).toMatchObject({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
  });

  test('a 402 response throws an error carrying the status for billing classification', async () => {
    promptImpl = async () => ({
      error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
      response: new Response(null, { status: 402 }),
    });

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as any).status).toBe(402);
    expect((err as any).response).toEqual({ status: 402 });
    expect((err as Error).message).toBe('Insufficient credits. Balance: $-0.06');
  });

  test('a non-402 error status is still preserved (just not billing-shaped)', async () => {
    promptImpl = async () => ({
      error: { message: 'agent crashed' },
      response: new Response(null, { status: 500 }),
    });

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect((err as Error).message).toBe('agent crashed');
    expect((err as any).status).toBe(500);
  });
});
