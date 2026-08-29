import { describe, expect, test } from 'bun:test';
import { RuntimeSurface } from './runtime-surface.ts';

const WIRE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

function restored() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: 1000 },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: 2000 },
    { role: 'user', content: [{ type: 'text', text: 'second question' }], timestamp: 3000 },
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], timestamp: 4000 },
  ];
}

// P1.8: one pi instance IS one session, so a box that comes back must come back
// with the same conversation. Before this, a restarted worker served an EMPTY
// /messages while the durable log held the whole transcript — the session
// answered with no memory of what had been said.
describe('RuntimeSurface.seedRestoredMessages', () => {
  test('rebuilds the transcript in order, with real wire ids', () => {
    const surface = new RuntimeSurface({ sessionId: 's', agentName: 'kortix' });
    expect(surface.seedRestoredMessages(restored())).toBe(4);

    const page = surface.transcript.page({ limit: 50, before: null });
    expect(page.messages.map((m) => m.info.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(page.messages.map((m) => m.parts.map((p: any) => p.text).join(''))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);

    // The id IS the transcript's sort key, and the web client splits on
    // /^msg_[0-9a-f]{12}/ — a non-conforming id sorts below the whole
    // transcript and every reply reattaches to the wrong question.
    const ids = page.messages.map((m) => m.info.id as string);
    for (const id of ids) expect(id).toMatch(WIRE_ID);
    expect(ids).toEqual([...ids].sort());
  });

  test('a reply minted after the restore sorts ABOVE the restored transcript', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    surface.seedRestoredMessages(restored());
    const ids = surface.transcript
      .page({ limit: 50, before: null })
      .messages.map((m) => m.info.id as string);
    // Otherwise the next answer lands back inside history.
    expect(surface.mintMessageId() > ids[ids.length - 1]).toBe(true);
  });

  test('skips a message with nothing renderable rather than showing an empty bubble', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seeded = surface.seedRestoredMessages([
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ]);
    expect(seeded).toBe(1);
    expect(surface.transcript.page({ limit: 10, before: null }).messages).toHaveLength(1);
  });

  test('history is not replayed onto the event bus', () => {
    // A reconnecting client already has these; republishing them would arrive
    // as a burst of "new" events for messages it is already showing.
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seen: string[] = [];
    surface.bus.subscribe((e: any) => seen.push(e.type), { since: null, epoch: null });
    surface.seedRestoredMessages(restored());
    expect(seen).toHaveLength(0);
  });
});
