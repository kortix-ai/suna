import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WIRE_MESSAGE_ID, mintWireMessageId, wireIdTime } from './wire-message-id';

/**
 * The worker used to mint `msg_pi00000001`. The web client splits messages
 * into "placed by the server" and "local to this tab" with
 * `/^msg_[0-9a-f]{12}/` and sorts every local one AFTER every placed one, so
 * `p` and `i` not being hex put every reply this worker produced below the
 * whole transcript — three questions rendered as three bubbles followed by
 * three answers, none under the question it answered.
 */

/** The regexes the two consumers of this format actually use, read off disk. */
const apiSource = readFileSync(
  fileURLToPath(new URL('../../api/src/projects/wire-message-id.ts', import.meta.url)),
  'utf8',
);
const sdkGroupingSource = readFileSync(
  fileURLToPath(new URL('../../../packages/sdk/src/core/turns/grouping.ts', import.meta.url)),
  'utf8',
);

const seq = (start = 0) => {
  let n = start;
  return () => {
    n = (n + 0.37) % 1;
    return n;
  };
};

describe('the format the rest of the system reads', () => {
  test('matches the API minter, which is where the format is defined', () => {
    // This app is standalone — no workspace deps — so the constant is
    // duplicated. Read the producer's copy rather than trusting a comment.
    const apiRegex = /export const WIRE_MESSAGE_ID = (\/.+\/);/.exec(apiSource)?.[1];
    expect(apiRegex).toBe(String(WIRE_MESSAGE_ID));
  });

  test('satisfies the CLIENT test that decides placed-vs-local ordering', () => {
    // `compareMessagesForDisplay` sorts anything failing this after every
    // server-placed message. Reading it from the SDK keeps this honest if the
    // client ever tightens the rule.
    const clientRegex = /const WIRE_DISPLAY_ID = (\/.+\/);/.exec(sdkGroupingSource)?.[1];
    expect(clientRegex).toBeDefined();
    const placed = new RegExp(clientRegex!.slice(1, -1));

    const { id } = mintWireMessageId({ nowMs: 1_756_000_000_000, random: seq() });
    expect(id).toMatch(WIRE_MESSAGE_ID);
    expect(placed.test(id)).toBe(true);

    // The shape that shipped, against the same rule.
    expect(placed.test('msg_pi00000001')).toBe(false);
  });
});

describe('ordering', () => {
  test('sorts strictly after the user message it answers', () => {
    const parent = mintWireMessageId({ nowMs: 1_756_000_000_000, random: seq() }).id;
    const parentTime = wireIdTime(parent);

    // A reply minted from a box whose clock runs an hour BEHIND the API's.
    const reply = mintWireMessageId({
      nowMs: 1_756_000_000_000 - 60 * 60 * 1000,
      newestKnownTime: parentTime,
      random: seq(0.5),
    });

    expect(reply.time > parentTime!).toBe(true);
    expect(reply.id > parent).toBe(true);
  });

  test('two mints inside one millisecond still order', () => {
    const first = mintWireMessageId({ nowMs: 1_756_000_000_000, random: seq() });
    const second = mintWireMessageId({
      nowMs: 1_756_000_000_000,
      newestKnownTime: first.time,
      random: seq(0.5),
    });

    expect(second.time > first.time).toBe(true);
    expect(second.id > first.id).toBe(true);
  });

  test('a decoded clock round-trips', () => {
    const { id, time } = mintWireMessageId({ nowMs: 1_756_000_000_000, random: seq() });
    expect(wireIdTime(id)).toBe(time);
    expect(wireIdTime('msg_pi00000001')).toBeNull();
    expect(wireIdTime(null)).toBeNull();
  });
});
