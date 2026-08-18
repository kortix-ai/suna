import { describe, expect, test } from 'bun:test';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import {
  SESSION_PROMPTS_IDLE_POLL_MS,
  SESSION_PROMPTS_POLL_MS,
  noteInboxObservation,
  sessionPromptsPollMs,
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
