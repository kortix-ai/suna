import { describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '@kortix/sdk';

import { claimFirstTurnRow } from './inbox-row-claims';

const W = 'msg_wire0000001';
const M = 'msg_remint000001';

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
        onlyUserMessage: { id: M },
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
        onlyUserMessage: { id: W },
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
        onlyUserMessage: { id: M },
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('a row that was never POSTed cannot own anything on screen', () => {
    // `attempts` is incremented when the drain claims a row, so a queued row at
    // zero attempts has never been handed over. Without this guard a prompt
    // waiting behind a running turn would claim the PREVIOUS turn's message and
    // disappear from the queue.
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'queued', attempts: 0 })],
        onlyUserMessage: { id: M },
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('a queued row that HAS been attempted still counts', () => {
    // Delivery failed and it is going back out; its message can be on screen.
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'queued', attempts: 1 })],
        onlyUserMessage: { id: M },
        claimedIds: new Set<string>(),
      })?.promptId,
    ).toBe('p1');
  });

  test('a failed row is not a delivery in progress', () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ state: 'failed' })],
        onlyUserMessage: { id: M },
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test("this tab's own optimistic row is skipped — its bubble owns it by id", () => {
    expect(
      claimFirstTurnRow({
        prompts: [prompt({ prompt_id: 'optimistic:c1' })],
        onlyUserMessage: { id: M },
        claimedIds: new Set<string>(),
      }),
    ).toBeNull();
  });

  test('an empty inbox claims nothing', () => {
    expect(
      claimFirstTurnRow({ prompts: [], onlyUserMessage: { id: M }, claimedIds: new Set<string>() }),
    ).toBeNull();
  });

  test('the FIRST deliverable row is the one that went out — the inbox is FIFO', () => {
    const claim = claimFirstTurnRow({
      prompts: [prompt(), prompt({ prompt_id: 'p2', message_id: 'msg_other000001' })],
      onlyUserMessage: { id: M },
      claimedIds: new Set<string>(),
    });
    expect(claim?.promptId).toBe('p1');
  });
});
