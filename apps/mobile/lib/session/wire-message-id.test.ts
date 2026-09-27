import { describe, expect, test } from 'bun:test';

import wireIdVectors from '../../../../tests/spec/wire-message-id.vectors.json';
import { mintWireMessageId } from './wire-message-id';

const WIRE_ID = /^msg_([0-9a-f]{12})([0-9A-Za-z]{14})$/;

describe('mintWireMessageId', () => {
  test('uses the wire format: msg_ + 12 lowercase hex + 14 base62', () => {
    const id = mintWireMessageId({ nowMs: Date.now(), knownMessageIds: [] });
    expect(id).toMatch(WIRE_ID);
  });

  for (const vector of wireIdVectors.vectors) {
    test(`shared vector: ${vector.name}`, () => {
      const knownMessageIds =
        vector.newestKnownTime === null ? [] : [`msg_${vector.newestKnownTime}AAAAAAAAAAAAAA`];
      const id = mintWireMessageId({ nowMs: vector.nowMs, knownMessageIds });
      expect(WIRE_ID.exec(id)?.[1]).toBe(vector.expectedTime);
    });
  }

  test('ignores ids whose prefix is not a 12-char lowercase-hex clock', () => {
    // Each of these would lift the mint if it were read as a clock: the
    // uppercase one decodes to 8bbf43300000, inside the 1 h lift window.
    const id = mintWireMessageId({
      nowMs: 1755500000000,
      knownMessageIds: ['msg_8BBF43300000ABCDEFGHIJKLMN', 'msg_zzzzzzzzzzzz_abc123', 'optimistic-1', 'prt_x'],
    });
    expect(WIRE_ID.exec(id)?.[1]).toBe('8bbf25e40000');
  });

  test('prefix rule: an id with a lowercase-hex clock prefix lifts the mint, whatever its tail', () => {
    // Pinned on purpose. The thread orders ids by their prefix, so the mint
    // must clear every id that sorts by that prefix, wire-shaped or not.
    // (Before the SDK owned this rule, mobile read only full wire ids.)
    const id = mintWireMessageId({
      nowMs: 1755500000000,
      knownMessageIds: ['msg_8bbf43300000_legacy'],
    });
    expect(WIRE_ID.exec(id)?.[1]).toBe('8bbf43300001');
  });

  test('sorts after the newest real message it lifts above', () => {
    const newest = 'msg_8bbf43300000ZZZZZZZZZZZZZZ';
    const id = mintWireMessageId({ nowMs: 1755500000000, knownMessageIds: [newest] });
    expect(id > newest).toBe(true);
  });
});
