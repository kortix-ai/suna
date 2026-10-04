/**
 * The SSE reader that fronts the daemon's `/kortix/opencode/events`.
 *
 * The property under test is INCREMENTALITY. A parser that only yields once the
 * body ends is indistinguishable from one that works, right up until it is used
 * on a stream that never ends — which is every stream this parser exists for.
 * So the cases below feed bytes in deliberately awkward pieces (a frame split
 * mid-field, two frames in one chunk, CRLF) and assert what came out AND when.
 */
import { describe, expect, test } from 'bun:test';
import { parseSseFrames } from './session-runtime-transport';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
}

async function collect(chunks: string[]) {
  const frames = [];
  for await (const frame of parseSseFrames(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe('parseSseFrames', () => {
  test('parses event / id / data as the daemon writes them', async () => {
    const frames = await collect([
      'event: session.status\nid: 1\ndata: {"seq":1,"type":"session.status"}\n\n',
    ]);
    expect(frames).toEqual([
      { event: 'session.status', id: '1', data: '{"seq":1,"type":"session.status"}' },
    ]);
  });

  test('a frame split across chunks is yielded once, whole', async () => {
    const frames = await collect(['event: kortix.turn\nid: 2\nda', 'ta: {"seq":2}\n', '\n']);
    expect(frames).toEqual([{ event: 'kortix.turn', id: '2', data: '{"seq":2}' }]);
  });

  test('two frames arriving in ONE chunk are yielded as two', async () => {
    const frames = await collect(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n']);
    expect(frames.map((frame) => frame.event)).toEqual(['a', 'b']);
  });

  test('a frame is yielded BEFORE the stream ends', async () => {
    // The incrementality proof: pull the first frame while the producer is
    // still open, and assert we got it without the stream having closed.
    let closed = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: first\ndata: 1\n\n'));
        // Deliberately never closed inside this tick.
        setTimeout(() => {
          closed = true;
          controller.close();
        }, 50);
      },
    });
    const iterator = parseSseFrames(body)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.event).toBe('first');
    expect(closed).toBe(false);
    await iterator.return?.(undefined);
  });

  test('CRLF producers are handled', async () => {
    const frames = await collect(['event: a\r\ndata: 1\r\n\r\n']);
    expect(frames).toEqual([{ event: 'a', id: null, data: '1' }]);
  });

  test('multi-line data is joined with newlines, per the SSE spec', async () => {
    const frames = await collect(['data: one\ndata: two\n\n']);
    expect(frames[0]!.data).toBe('one\ntwo');
  });

  test('a comment line yields nothing — which is why the daemon sends a TYPED heartbeat', async () => {
    const frames = await collect([': keep-alive\n\n', 'event: real\ndata: 1\n\n']);
    expect(frames.map((frame) => frame.event)).toEqual(['real']);
  });

  test('a trailing partial frame is not invented at end-of-stream', async () => {
    // Half a frame is not a frame. Emitting it would hand a client a truncated
    // JSON body that its reducer would then have to defend against.
    const frames = await collect(['event: complete\ndata: 1\n\nevent: half\ndata: {"a"']);
    expect(frames.map((frame) => frame.event)).toEqual(['complete']);
  });

  test('only the FIRST space after the colon is stripped', async () => {
    const frames = await collect(['data:  padded\n\n']);
    expect(frames[0]!.data).toBe(' padded');
  });
});
