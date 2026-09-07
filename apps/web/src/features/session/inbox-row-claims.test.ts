import { describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '@kortix/sdk';

import { claimFirstTurnRow } from './inbox-row-claims';

const W = 'msg_wire0000001';
const M = 'msg_remint000001';
const TEXT = 'ok just testing to show weird behavior';
const only = (over: Partial<{ id: string; text: string }> = {}) => ({ id: M, text: TEXT, ...over });

const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt =>
  ({
    prompt_id: 'p1',
    client_message_id: 'pending:ses_1',
    message_id: W,
    wire_message_id: W,
    state: 'delivering',
    reason: null,
    text: 'ok just testing to show weird behavior',
    attempts: 1,
    last_error: null,
    created_at: '2026-09-08T10:00:00.000Z',
    available_at: '2026-09-08T10:00:00.000Z',
    ...over,
  }) as SessionPrompt;

describe('claimFirstTurnRow', () => {
  test('the one unclaimed user message belongs to the row that went out', () => {
    // The reported bug, in one call: the transcript has the prompt under the
    // re-minted id, the cached row still names the old one, and nothing else
    // can connect them.
    expect(
      claimFirstTurnRow({
        prompts: [prompt()],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      }),
    ).toEqual({
      promptId: 'p1',
      messageId: M,
      rowMessageId: W,
      rowWireMessageId: W,
      rowClientMessageId: 'pending:ses_1',
    });
  });

  test('an id match needs no inference — the ordinary path is left alone', () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt()],
        onlyUserMessage: only({ id: W }),
        claimedIds: new Set([W]),
      }),
    ).toBeNull();
  });

  test('two user messages are not a proof, so nothing is claimed', () => {
    // The caller passes null once the transcript holds more than one: two rows
    // and two messages can pair either way round, and the wrong pairing puts
    // the X and the "Queued" label on the wrong bubble.
    expect(
      claimFirstTurnRow({
        prompts: [prompt()],
        onlyUserMessage: null,
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('a row the user STOPPED never claims a message', () => {
    // Held is the user's own Stop: the row is deliberately not going out, so
    // the message on screen cannot be it — and its bubble carries the only
    // control that releases it.
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'waiting', reason: 'held', attempts: 1 })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('a STALE row — still reading queued, zero attempts — is claimed when the words match', () => {
    // The case that was actually on screen (2026-09-08, on video): the cached
    // row came from the session-open bundle, taken before the drain touched
    // it, so it read `queued`/`attempts: 0` for seconds after the runtime had
    // echoed the prompt under a re-minted id. A guard that trusted those
    // fields refused the claim on exactly the data it existed to correct.
    // The words are the one thing the two copies always share.
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'queued', attempts: 0 })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      })?.promptId,
    ).toBe('p1');
  });

  test('a row with DIFFERENT words never claims — a prompt waiting behind another turn', () => {
    // A second device queues a new prompt while this tab shows the previous
    // turn's message: the row is not that message, and claiming it would make
    // the queued bubble vanish from this tab.
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ text: 'something else entirely' })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('the row carries a 2000-char PREVIEW, so a longer message still matches on its prefix', () => {
    const long = 'x'.repeat(2500);
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ text: long.slice(0, 2000) })],
        onlyUserMessage: only({ text: long }),
        claimedIds: new Set<string>(),
      })?.promptId,
    ).toBe('p1');
  });

  test('whitespace differences between the row and the message do not matter', () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ text: '  ok just   testing to show weird behavior\n' })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      })?.promptId,
    ).toBe('p1');
  });

  test('a failed row is not a delivery in progress', () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'failed' })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test("this tab's own optimistic row is skipped — its bubble owns it by id", () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ prompt_id: 'optimistic:c1' })],
        onlyUserMessage: only(),
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('an empty inbox claims nothing', () => {
    expect(
      claimFirstTurnRow({ prompts: [], onlyUserMessage: only(), claimedIds: new Set<string>() }),
    ).toBeNull();
  });

  test('with two rows of the same words, the FIRST is the one that went out — the inbox is FIFO', () => {
    const claim = claimFirstTurnRow({
      prompts: [prompt(), prompt({ prompt_id: 'p2', message_id: 'msg_other000001' })],
      onlyUserMessage: only(),
      claimedIds: new Set<string>(),
    });
    expect(claim?.promptId).toBe('p1');
  });
});
