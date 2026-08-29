import { describe, expect, test } from 'bun:test';
import { RuntimeSurface } from './runtime-surface.ts';
import { ChatEventAdapter } from './chat-events.ts';

function adapterFor(surface: RuntimeSurface) {
  return new ChatEventAdapter(surface.rootId);
}

function textDelta(delta: string, contentIndex = 0) {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta, contentIndex } } as any;
}

describe('pi streams as deltas, not only snapshots', () => {
  // pi's documented contract is `message_update -> assistantMessageEvent
  // .text_delta.delta`. We used to discard that delta and republish the whole
  // accumulated string as a cumulative `message.part.updated`. Correct, but it
  // is the SNAPSHOT path, and the web client only re-renders eagerly off
  // `message.part.delta` — so a pi answer landed as one lump at the end
  // (measured: 183 frames streamed, browser painted once at 94% complete).
  test('a text_delta yields a bus delta AND a transcript-only snapshot', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    const frames = adapter.translate(textDelta('Hello'));

    const delta = frames.find((f: any) => f.type === 'message.part.delta') as any;
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    expect(delta).toBeDefined();
    expect(snap).toBeDefined();
    expect(delta.properties.delta).toBe('Hello');
    expect(delta.properties.field).toBe('text');
    expect(delta.properties.partID).toBe(snap.properties.part.id);
    // The snapshot must never reach the bus beside its own delta.
    expect(snap.transcriptOnly).toBe(true);
    expect(delta.transcriptOnly).toBeUndefined();
  });

  test('the two carry the SAME text — append vs replace, never both on the bus', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    // The real order: the assistant message is created first, then chunks.
    for (const f of adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any)) {
      surface.publishWire(f);
    }
    const seen: string[] = [];
    surface.bus.subscribe((e: any) => seen.push(e.type), { since: null, epoch: null });

    for (const chunk of ['The ', 'sea ', 'is ', 'wide.']) {
      for (const f of adapter.translate(textDelta(chunk))) surface.publishWire(f);
    }

    // Every chunk reached the bus exactly once, as a delta.
    expect(seen.filter((t) => t === 'message.part.delta')).toHaveLength(4);
    expect(seen.filter((t) => t === 'message.part.updated')).toHaveLength(0);

    // The transcript still holds the whole string: REST reads and `since=`
    // resync must not depend on replaying deltas.
    const page = surface.transcript.page({ limit: 10, before: null });
    const text = page.messages.flatMap((m: any) => m.parts).map((p: any) => p.text).join('');
    expect(text).toBe('The sea is wide.');
  });

  test('a chunk with no delta (text_start/text_end) publishes normally', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    const frames = adapter.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', text: 'done', contentIndex: 0 },
    } as any);
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    // No append to duplicate, so this one goes to the bus — and it repairs any
    // drift, since upsertPart accepts prefix growth.
    expect(snap.transcriptOnly).toBeUndefined();
    expect(frames.some((f: any) => f.type === 'message.part.delta')).toBe(false);
  });

  test('reasoning streams the same way', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    const frames = adapter.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm', contentIndex: 0 },
    } as any);
    const delta = frames.find((f: any) => f.type === 'message.part.delta') as any;
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    expect(delta?.properties.delta).toBe('hmm');
    expect(snap?.properties.part.type).toBe('reasoning');
    expect(snap?.transcriptOnly).toBe(true);
  });
});
