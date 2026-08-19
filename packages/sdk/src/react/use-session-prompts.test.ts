import { describe, expect, test } from 'bun:test';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import {
  applyOptimisticPrompt,
  optimisticSessionPrompt,
  reconcileOptimisticPrompts,
  removeOptimisticPrompt,
  settleOptimisticPrompt,
  SESSION_PROMPTS_IDLE_POLL_MS,
  SESSION_PROMPTS_POLL_MS,
  noteInboxObservation,
  sessionPromptsPollMs,
  startSessionWithPrompt,
} from './use-session-prompts';

/**
 * The polling cadence is a CORRECTNESS decision, not a performance one.
 *
 * A prompt can ENTER this list without the tab doing anything: the reaper
 * redelivers one whose turn never ran, and parking a box requeues its in-flight
 * prompt as `held`. Both land on a session whose list is, at that moment, empty
 * — and the `held` design depends on the user seeing the row so they can
 * release it. A cadence of `false` at zero rows means the tab never learns, and
 * only a full page load recovers.
 */
describe('sessionPromptsPollMs', () => {
  test('polls fast while prompts are pending — their state changes on its own', () => {
    expect(sessionPromptsPollMs(1)).toBe(SESSION_PROMPTS_POLL_MS);
    expect(sessionPromptsPollMs(7)).toBe(SESSION_PROMPTS_POLL_MS);
  });

  test('an EMPTY list still polls, slowly — a prompt can come back on its own', () => {
    expect(sessionPromptsPollMs(0)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
    expect(SESSION_PROMPTS_IDLE_POLL_MS).toBeGreaterThan(SESSION_PROMPTS_POLL_MS);
  });

  test('an explicit cadence overrides the busy one, never the idle one', () => {
    // Hosts tune the busy cadence for their own UI. The idle floor is not
    // theirs to remove: it is what makes a re-entering prompt visible.
    expect(sessionPromptsPollMs(2, 500)).toBe(500);
    expect(sessionPromptsPollMs(0, 500)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });
});

/**
 * The inbox is a WORKING signal, not just a list to render.
 *
 * A prompt is durably accepted long before it is a turn — the row still has to
 * be drained and the box may still have to resume. `GET .../turn` answers "no
 * turns" for all of it, honestly, and the composer used to believe that and
 * swap Stop back to Send while the user's prompt sat in the queue. Every read
 * of the list therefore feeds `projectWorking` too.
 */
describe('noteInboxObservation', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('records how many rows the server still intends to run, and when it looked', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt(), prompt({ prompt_id: 'p2', state: 'delivering' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 2, atMs: 500 });
  });

  test('a held queue records zero — Stop must put the composer back', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt({ state: 'waiting', reason: 'held' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 0, atMs: 500 });
  });
});

/**
 * The first prompt of a brand-new session, as ONE durable POST — the SDK
 * function every "new session" producer calls instead of stashing the text in
 * sessionStorage for a replay effect to send 19-25s later (the measured boot),
 * during which a closed tab lost the message silently.
 */
describe('startSessionWithPrompt', () => {
  test('POSTs the prompt with a minted wire id and files the receipt around the round-trip', async () => {
    useSessionWorkingStore.getState().reset();
    const calls: any[] = [];
    const result = await startSessionWithPrompt(
      'proj-1',
      'sess-1',
      { parts: [{ type: 'text', text: 'go' }], overrides: { agent: 'default' } },
      {
        create: async (projectId, sessionId, input) => {
          // The receipt is taken BEFORE the POST: from here a `/turn` read is
          // barred from answering idle until the row is durable or refused.
          expect(useSessionWorkingStore.getState().receipts['sess-1']).not.toBeNull();
          calls.push([projectId, sessionId, input]);
          return { prompt_id: 'p1', state: 'queued', message_id: input.messageId, deduped: false };
        },
      },
    );

    expect(result.state).toBe('queued');
    expect(calls).toHaveLength(1);
    const [projectId, sessionId, input] = calls[0];
    expect(projectId).toBe('proj-1');
    expect(sessionId).toBe('sess-1');
    expect(input.messageId).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(input.clientMessageId.length).toBeGreaterThan(8);
    // This producer can never read a transcript, so it must say so.
    expect(input.remintOnDelivery).toBe(true);
    expect(input.parts).toEqual([{ type: 'text', text: 'go' }]);
    expect(input.overrides).toEqual({ agent: 'default' });
    // Accepted: the server has the row, and the projection may answer for it.
    const receipt = useSessionWorkingStore.getState().receipts['sess-1'];
    expect(receipt?.acceptedAtMs ?? null).not.toBeNull();
  });

  test('a refused row drops the receipt and throws instead of posing as sent', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-2',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async (_p, _s, input) => ({
            prompt_id: 'p1',
            state: 'failed',
            message_id: input.messageId,
            deduped: true,
          }),
        },
      ),
    ).rejects.toThrow(/refused/i);
    expect(useSessionWorkingStore.getState().receipts['sess-2']).toBeFalsy();
  });

  test('a network failure also drops the receipt', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-3',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
    expect(useSessionWorkingStore.getState().receipts['sess-3']).toBeFalsy();
  });
});

/**
 * Enter must paint the queue row IMMEDIATELY. The row is durable only once
 * `POST .../prompts` returns, but the user pressed Enter now: the strip shows
 * an optimistic row (`prompt_id` = `optimistic:<clientMessageId>`, state
 * `queued`) in the same frame, and the server's row replaces it on the
 * response — or it disappears on failure so a refused send never lingers.
 */
describe('optimistic queue rows', () => {
  const input = {
    clientMessageId: 'c1',
    messageId: 'msg_0168552a2001AAAAAAAAAAAAAA',
    parts: [{ type: 'text' as const, text: 'hello there' }, { type: 'file' as const, url: 'x', mime: 'image/png', filename: 'a.png' }],
  };

  test("optimisticSessionPrompt renders the text of the parts, in the strip's shape", () => {
    const row = optimisticSessionPrompt(input, 1_000);
    expect(row.prompt_id).toBe('optimistic:c1');
    expect(row.client_message_id).toBe('c1');
    expect(row.message_id).toBe(input.messageId);
    expect(row.state).toBe('queued');
    expect(row.text).toBe('hello there');
    expect(row.attempts).toBe(0);
    expect(row.created_at).toBe(new Date(1_000).toISOString());
  });

  test('applyOptimisticPrompt appends once and is idempotent for the same submission', () => {
    const a = applyOptimisticPrompt([], input, 1_000);
    const b = applyOptimisticPrompt(a, input, 2_000);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0].prompt_id).toBe('optimistic:c1');
  });

  test('settleOptimisticPrompt swaps the optimistic row for the server row by client id', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const settled = settleOptimisticPrompt(rows, 'c1', {
      prompt_id: 'p-real',
      state: 'delivering',
      message_id: input.messageId,
      deduped: false,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0].prompt_id).toBe('p-real');
    expect(settled[0].state).toBe('delivering');
    expect(settled[0].text).toBe('hello there');
  });

  test('a failed submission removes the optimistic row', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    expect(removeOptimisticPrompt(rows, 'c1')).toEqual([]);
  });

  test('a real row that already carries the client id wins over a stale optimistic one', () => {
    // The poll can land the server's row before the mutation settles.
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, [
      { prompt_id: 'p-real', client_message_id: 'c1', message_id: input.messageId, state: 'queued', reason: null, text: 'hello there', attempts: 0, last_error: null, created_at: 'x', available_at: 'x' },
    ]);
    expect(merged.map((r) => r.prompt_id)).toEqual(['p-real']);
  });

  test('reconcile keeps optimistic rows the server has not listed yet (POST still in flight)', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, []);
    expect(merged.map((r) => r.prompt_id)).toEqual(['optimistic:c1']);
  });
});
