import { describe, expect, test } from 'bun:test';
import type { SessionPlacedPrompt } from '@kortix/sdk';
import { claimPlacedPairingIds, placedEchoPairings } from './placed-pairings';

/**
 * A PAIRING OUTLIVES ITS ROW.
 *
 * The tab paints a prompt under its client wire id; the drain re-mints it;
 * the runtime echoes it under the new id with no client id and no client
 * part ids (the server strips them). The only thing that names the pairing
 * is the inbox row — and a steered row leaves `GET .../prompts` at
 * ACCEPTANCE, often under 1 s after the re-mint, while the tab polls every
 * 1 s. A tab that missed that one poll kept its bubble beside the echo until
 * reload (2026-09-22, preview session "YO" 134c0d27: bubble 4 the echo,
 * bubble 5 the stub with "just now" and Thinking under it). The server now
 * serves the pairings of rows that left inside the last ten minutes as `placed`;
 * these helpers are what the effect and the claimed-ids projection do with
 * them.
 */
const placed = (over: Partial<SessionPlacedPrompt> = {}): SessionPlacedPrompt => ({
  prompt_id: 'cmd-1',
  client_message_id: 'q_1',
  wire_message_id: 'msg_client',
  message_id: 'msg_reminted',
  placed_at: '2026-09-22T12:15:11.000Z',
  ...over,
});

describe('placedEchoPairings — what the effect announces to the store', () => {
  test('one pairing per delivered id, from the wire id the bubble was painted under', () => {
    expect(placedEchoPairings([placed()])).toEqual([
      { wireMessageId: 'msg_client', messageId: 'msg_reminted' },
    ]);
  });

  test('every earlier re-mint is a pairing too, announced BEFORE the latest — the standing alias is the id the echo will carry', () => {
    // The store keeps one forward alias per bubble, the LAST registration,
    // and the server lists `message_ids` latest first. Announced in that
    // order the standing alias was the OLDEST id and the latest echo matched
    // nothing (review finding, 2026-09-22). `message_id` goes last.
    expect(
      placedEchoPairings([placed({ message_ids: ['msg_reminted', 'msg_earlier', 'msg_earliest'] })]),
    ).toEqual([
      { wireMessageId: 'msg_client', messageId: 'msg_earlier' },
      { wireMessageId: 'msg_client', messageId: 'msg_earliest' },
      { wireMessageId: 'msg_client', messageId: 'msg_reminted' },
    ]);
  });

  test('an id equal to the wire id, a blank id, and a missing list announce nothing', () => {
    expect(placedEchoPairings([placed({ message_id: 'msg_client', message_ids: ['msg_client', ''] })])).toEqual([]);
    expect(placedEchoPairings([placed({ wire_message_id: '' })])).toEqual([]);
    expect(placedEchoPairings(undefined)).toEqual([]);
  });
});

describe('claimPlacedPairingIds — the hide clause stays live after the row is gone', () => {
  test('a pairing with ANY id on screen claims every id it names, and the client id', () => {
    const ids = new Set(['msg_reminted']);
    claimPlacedPairingIds(ids, [placed({ message_ids: ['msg_reminted', 'msg_earlier'] })]);
    expect([...ids].sort()).toEqual(['msg_client', 'msg_earlier', 'msg_reminted', 'q_1']);
  });

  test('the wire id on screen (the stub not yet retired) claims the delivered ids too', () => {
    const ids = new Set(['msg_client']);
    claimPlacedPairingIds(ids, [placed()]);
    expect([...ids].sort()).toEqual(['msg_client', 'msg_reminted', 'q_1']);
  });

  test('a pairing with no id on screen claims nothing — it is not this transcript\'s', () => {
    const ids = new Set(['msg_unrelated']);
    claimPlacedPairingIds(ids, [placed()]);
    expect([...ids]).toEqual(['msg_unrelated']);
  });
});
