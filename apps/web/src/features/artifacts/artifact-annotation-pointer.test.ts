import { parseArtifactAnnotationFrameMessage } from '@kortix/shared/artifact-annotations';
import { expect, test } from 'bun:test';
import {
  createArtifactAnnotationController,
  type ArtifactAnnotationPagePoint,
} from './artifact-annotation-controller';

/** Live page cursors over the annotation bridge (KRTX-3669): geometry in, geometry out. */
const layout = (revision: number, scrollY = 0) =>
  ({
    kortix: 'annotate',
    v: 1,
    type: 'layout',
    revision,
    chunk: 0,
    final: true,
    complete: true,
    viewport: { width: 800, height: 600, scroll: { x: 0, y: scrollY } },
    elements: [
      { n: 0, selector: '#hero', snippet: 'Hero', rect: { x: 0, y: 0, width: 800, height: 400 } },
      { n: 1, selector: `#${'x'.repeat(600)}`, snippet: '', rect: { x: 0, y: 400, width: 800, height: 50 } },
    ],
    texts: [],
  }) as const;

function fixture(trackPointer: boolean) {
  const sent: Array<{ type: string; pointer?: boolean }> = [];
  const pointers: Array<ArtifactAnnotationPagePoint | null> = [];
  const controller = createArtifactAnnotationController(
    {
      post: (message) => {
        sent.push(message as { type: string; pointer?: boolean });
        return true;
      },
      onThreads: () => {},
      onCandidate: () => {},
      onFocus: () => {},
      onPointer: (at) => pointers.push(at),
    },
    () => () => {},
  );
  const config = {
    version: 'commit',
    canComment: false,
    mode: 'text' as const,
    threads: [],
    focusedThreadId: null,
    focusRevision: 0,
    trackPointer,
  };
  controller.update(config);
  return { controller, config, sent, pointers };
}

const pointer = (revision: number, at: { n: number; x: number; y: number } | null) =>
  ({ kortix: 'annotate', v: 1, type: 'pointer', revision, at }) as const;

test('the bridge schema takes a pointer as an element number and fractions, nothing else', () => {
  expect(parseArtifactAnnotationFrameMessage(pointer(1, { n: 0, x: 0.5, y: 1 }))).not.toBeNull();
  expect(parseArtifactAnnotationFrameMessage(pointer(1, null))).not.toBeNull();
  expect(parseArtifactAnnotationFrameMessage(pointer(1, { n: 0, x: 1.5, y: 0 }))).toBeNull();
  expect(
    parseArtifactAnnotationFrameMessage({ ...pointer(1, { n: 0, x: 0, y: 0 }), name: 'Ana' }),
  ).toBeNull();
});

test('a tracked pointer becomes a selector and fractions of the current layout', () => {
  const f = fixture(true);
  f.controller.receive(layout(3) as never);
  f.controller.receive(pointer(3, { n: 0, x: 0.25, y: 0.5 }) as never);
  // A pointer from another layout names stale element numbers.
  f.controller.receive(pointer(2, { n: 0, x: 0.9, y: 0.9 }) as never);
  // A selector longer than a live cursor carries (512) is not sent.
  f.controller.receive(pointer(3, { n: 1, x: 0.5, y: 0.5 }) as never);
  f.controller.receive(pointer(3, null) as never);
  expect(f.pointers).toEqual([{ selector: '#hero', x: 0.25, y: 0.5 }, null, null]);
});

test('the page hears "track" only while the viewer wants the pointer', () => {
  const f = fixture(false);
  f.controller.reset();
  expect(f.sent.some((message) => message.type === 'track')).toBe(false);
  f.controller.receive(layout(1) as never);
  f.controller.receive(pointer(1, { n: 0, x: 0.5, y: 0.5 }) as never);
  expect(f.pointers).toEqual([]);
  f.controller.update({ ...f.config, trackPointer: true });
  expect(f.sent.filter((message) => message.type === 'track')).toEqual([
    { kortix: 'annotate', v: 1, type: 'track', pointer: true } as never,
  ]);
  f.controller.update({ ...f.config, trackPointer: false });
  expect(f.sent.filter((message) => message.type === 'track').at(-1)).toEqual({
    kortix: 'annotate',
    v: 1,
    type: 'track',
    pointer: false,
  } as never);
  // Hiding clears this viewer's cursor for everyone.
  expect(f.pointers).toEqual([null]);
});

test("another viewer's point lands in this viewer's frame pixels, after this viewer's scroll", () => {
  const f = fixture(true);
  expect(f.controller.pagePoint({ selector: '#hero', x: 0.5, y: 0.5 })).toBeNull();
  f.controller.receive(layout(1, 100) as never);
  expect(f.controller.pagePoint({ selector: '#hero', x: 0.5, y: 0.5 })).toEqual({ x: 400, y: 100 });
  expect(f.controller.pagePoint({ selector: '#missing', x: 0.5, y: 0.5 })).toBeNull();
});
