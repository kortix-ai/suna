import { describe, expect, test } from 'bun:test';

import {
  LANDING_PROOF_MIN_BODY_BYTES,
  confirmPromptLanded,
  promptNeedsLandingProof,
} from './prompt-landing-proof';

const NO_WAIT = { attempts: 3, delayMs: 0 };

describe('confirmPromptLanded', () => {
  test('accepts a message the runtime already holds', async () => {
    const reads: string[] = [];
    const landed = await confirmPromptLanded({
      messageId: 'msg_1',
      readMessage: async (id) => {
        reads.push(id);
        return { id };
      },
      ...NO_WAIT,
    });
    expect(landed).toBe('landed');
    // One read is enough when the runtime already answers.
    expect(reads).toEqual(['msg_1']);
  });

  test('waits out the write that lands just after the POST returns', async () => {
    let calls = 0;
    const landed = await confirmPromptLanded({
      messageId: 'msg_2',
      readMessage: async () => (++calls < 3 ? null : { id: 'msg_2' }),
      ...NO_WAIT,
    });
    expect(landed).toBe('landed');
    expect(calls).toBe(3);
  });

  // The 2026-09-04 incident. A body over the sandbox edge's size ceiling is
  // discarded, and the RETRY answers 200 for a request the runtime never saw.
  // Without proof the drain reads that 200 as delivery, closes the row, and
  // the user's message ceases to exist with no error anywhere.
  test('refuses a message the runtime never wrote', async () => {
    let calls = 0;
    const landed = await confirmPromptLanded({
      messageId: 'msg_3',
      readMessage: async () => {
        calls += 1;
        return null;
      },
      ...NO_WAIT,
    });
    expect(landed).toBe('missing');
    expect(calls).toBe(3);
  });

  // A read that THROWS is not proof of absence — the box may be mid-resume.
  // Treating it as absence would re-send a prompt the runtime already took.
  test('an unreadable runtime is unknown: never absent, and not claimed as landed', async () => {
    const landed = await confirmPromptLanded({
      messageId: 'msg_4',
      readMessage: async () => {
        throw new Error('runtime unreachable');
      },
      ...NO_WAIT,
    });
    expect(landed).toBe('unknown');
  });

  test('cannot prove anything without a wire id, so it does not try', async () => {
    let calls = 0;
    const landed = await confirmPromptLanded({
      messageId: undefined,
      readMessage: async () => {
        calls += 1;
        return null;
      },
      ...NO_WAIT,
    });
    expect(landed).toBe('unknown');
    expect(calls).toBe(0);
  });
});

// The provider edge drops bodies from ~115 KB; anything smaller cannot be
// dropped by it, so only a large body pays for the read-back.
describe('promptNeedsLandingProof', () => {
  test('an ordinary prompt is not read back', () => {
    expect(promptNeedsLandingProof(2_000)).toBe(false);
    expect(promptNeedsLandingProof(LANDING_PROOF_MIN_BODY_BYTES - 1)).toBe(false);
  });

  test('a body near the edge ceiling is read back', () => {
    expect(promptNeedsLandingProof(LANDING_PROOF_MIN_BODY_BYTES)).toBe(true);
    expect(promptNeedsLandingProof(6_100_000)).toBe(true);
  });
});
