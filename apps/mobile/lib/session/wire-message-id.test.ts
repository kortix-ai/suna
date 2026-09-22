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

  test('ignores ids that are not in the wire format', () => {
    const id = mintWireMessageId({
      nowMs: 1755500000000,
      knownMessageIds: ['msg_1789569036829_abc123', 'optimistic-1', 'prt_x'],
    });
    expect(WIRE_ID.exec(id)?.[1]).toBe('8bbf25e40000');
  });

  test('sorts after the newest real message it lifts above', () => {
    const newest = 'msg_8bbf43300000ZZZZZZZZZZZZZZ';
    const id = mintWireMessageId({ nowMs: 1755500000000, knownMessageIds: [newest] });
    expect(id > newest).toBe(true);
  });
});
