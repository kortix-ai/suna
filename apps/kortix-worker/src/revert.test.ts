/**
 * Rewind — the spike's "one real gap".
 *
 * `message.removed` and `message.part.removed` have a consumer everywhere and
 * no SOURCE: the SDK parses them (core/stream/chat-events.ts), the mobile app
 * switches on them, the docs list them, and `kortix.session().rewind()` calls
 * `session.revert` — which the pi worker answered with a 404. So rewinding a pi
 * session did nothing, visibly.
 *
 * Rewind is STAGED and reversible, matching what the SDK promises: it hides the
 * messages from one user message onward, `restoreRewind()` puts them back, and
 * the next prompt commits the new path.
 */
import { describe, expect, test } from 'bun:test';
import { WireTranscript } from './runtime-surface.ts';

/** ids sort lexicographically, which is how the transcript orders them. */
function seeded(): WireTranscript {
  const t = new WireTranscript();
  for (const [id, role, text] of [
    ['msg_01', 'user', 'first question'],
    ['msg_02', 'assistant', 'first answer'],
    ['msg_03', 'user', 'second question'],
    ['msg_04', 'assistant', 'second answer'],
  ] as const) {
    t.apply({ type: 'message.updated', properties: { info: { id, role, sessionID: 'ses_1' } } });
    t.apply({
      type: 'message.part.updated',
      properties: { part: { id: `${id}-p0`, messageID: id, type: 'text', text } },
    });
  }
  return t;
}

const ids = (t: WireTranscript) => t.page({ limit: 50, before: null }).messages.map((m) => m.info.id);

describe('rewind hides a tail', () => {
  test('reverting at a user message removes it and everything after it', () => {
    const t = seeded();
    const removed = t.revert('msg_03');
    expect(removed).toEqual(['msg_03', 'msg_04']);
    expect(ids(t)).toEqual(['msg_01', 'msg_02']);
    expect(t.count).toBe(2);
  });

  test('reverting at the first message empties the transcript', () => {
    const t = seeded();
    expect(t.revert('msg_01')).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
    expect(ids(t)).toEqual([]);
  });

  test('reverting at an unknown id changes nothing', () => {
    const t = seeded();
    expect(t.revert('msg_99')).toEqual([]);
    expect(ids(t)).toHaveLength(4);
  });

  test('a second revert further back subsumes the first', () => {
    const t = seeded();
    t.revert('msg_03');
    expect(t.revert('msg_01')).toEqual(['msg_01', 'msg_02']);
    expect(ids(t)).toEqual([]);
    // Restoring brings back everything either revert hid, in order.
    expect(t.unrevert()).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
    expect(ids(t)).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
  });
});

describe('restore puts the tail back', () => {
  test('unrevert restores the exact messages and their parts', () => {
    const t = seeded();
    t.revert('msg_03');
    expect(t.unrevert()).toEqual(['msg_03', 'msg_04']);
    expect(ids(t)).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
    // Parts survive the round trip — a restored message that lost its text
    // would render as an empty bubble.
    const restored = t.page({ limit: 50, before: null }).messages.find((m) => m.info.id === 'msg_04');
    expect((restored?.parts?.[0] as { text?: string })?.text).toBe('second answer');
  });

  test('unrevert with nothing staged is a no-op, not an error', () => {
    const t = seeded();
    expect(t.unrevert()).toEqual([]);
    expect(ids(t)).toHaveLength(4);
  });

  test('ordering is restored by id, not by the order things were staged', () => {
    const t = seeded();
    t.revert('msg_02');
    t.unrevert();
    expect(ids(t)).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
  });
});

describe('committing the new path', () => {
  /**
   * The next prompt commits. After that the old branch is gone for good and
   * `unrevert()` must not resurrect it — otherwise a later restore would
   * splice a dead branch back into a conversation that has moved on.
   */
  test('commit drops the staged tail permanently', () => {
    const t = seeded();
    t.revert('msg_03');
    expect(t.commitRevert()).toEqual(['msg_03', 'msg_04']);
    expect(t.unrevert()).toEqual([]);
    expect(ids(t)).toEqual(['msg_01', 'msg_02']);
  });

  test('commit with nothing staged is a no-op', () => {
    const t = seeded();
    expect(t.commitRevert()).toEqual([]);
    expect(ids(t)).toHaveLength(4);
  });
});

describe('the wire replays removals', () => {
  // `/messages` must say exactly what `/events` said, so a client that
  // reconnects after a removal sees the same transcript as one that watched it.
  test('applying message.removed drops that message', () => {
    const t = seeded();
    t.apply({ type: 'message.removed', properties: { messageID: 'msg_04' } });
    expect(ids(t)).toEqual(['msg_01', 'msg_02', 'msg_03']);
  });

  test('applying message.part.removed drops just that part', () => {
    const t = seeded();
    t.apply({
      type: 'message.part.removed',
      properties: { messageID: 'msg_04', partID: 'msg_04-p0' },
    });
    const m = t.page({ limit: 50, before: null }).messages.find((x) => x.info.id === 'msg_04');
    expect(m?.parts).toEqual([]);
    expect(ids(t)).toHaveLength(4);
  });

  test('a removal for an unknown id is ignored, never a crash', () => {
    const t = seeded();
    t.apply({ type: 'message.removed', properties: { messageID: 'nope' } });
    t.apply({ type: 'message.part.removed', properties: { messageID: 'nope', partID: 'x' } });
    expect(ids(t)).toHaveLength(4);
  });
});
