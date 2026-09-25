import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { queueSessionPrompt } from './sessions-queue.ts';

/**
 * The CLI cannot read the session transcript, so it cannot place a wire id.
 * Until 2026-09 it minted the HIGH 12 hex digits of `Date.now() * 0x1000`
 * (`msg_1a0d…`) where OpenCode keeps the LOW 48 bits (`msg_0d4…`): every CLI
 * prompt sat ~40 days ahead of the transcript, and every turn sent after it
 * from the web rendered ABOVE it.
 */
describe('queueSessionPrompt', () => {
  const session = { session_id: 'sess-1', agent_name: null, metadata: {} } as unknown as ProjectSession;

  async function posted(): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const client = {
      post: async (_path: string, sent: Record<string, unknown>) => {
        body = sent;
        return { prompt_id: 'p', state: 'queued', message_id: String(sent.message_id), deduped: false };
      },
    } as unknown as ApiClient;
    await queueSessionPrompt(client, 'proj-1', session, 'hi');
    return body;
  }

  test('mints the id in OpenCode’s own clock encoding, within minutes of now', async () => {
    const before = Date.now();
    const id = String((await posted()).message_id);
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const clock = BigInt(`0x${id.slice(4, 16)}`);
    const nowClock = (BigInt(before) * BigInt(0x1000)) & BigInt(0xffffffffffff);
    const drift = clock > nowClock ? clock - nowClock : nowClock - clock;
    // Dated two minutes back by design; never ~40 days out.
    expect(drift <= BigInt(3 * 60_000) * BigInt(0x1000)).toBe(true);
  });

  test('asks the server to place the id against the live transcript', async () => {
    expect((await posted()).remint_on_delivery).toBe(true);
  });
});
