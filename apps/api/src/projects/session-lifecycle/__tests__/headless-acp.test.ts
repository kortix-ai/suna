import { describe, expect, test } from 'bun:test';
import { consumeHeadlessAcpSse, selectHeadlessPermissionOption } from '../headless-acp';

describe('headless ACP lifecycle', () => {
  test('only auto-selects a one-turn permission grant', () => {
    expect(selectHeadlessPermissionOption({ options: [
      { optionId: 'allow_always', kind: 'allow_always' },
      { optionId: 'allow_once', kind: 'allow_once' },
    ] })).toBe('allow_once');
    expect(selectHeadlessPermissionOption({ options: [{ optionId: 'allow_always' }] })).toBeNull();
  });

  test('decodes fragmented SSE envelopes in order', async () => {
    const chunks = ['id: 1\nda', 'ta: {"jsonrpc":"2.0","method":"session/update"}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    await consumeHeadlessAcpSse(body, async (id, envelope) => { seen.push([id, envelope.method]); });
    expect(seen).toEqual([[1, 'session/update']]);
  });
});
