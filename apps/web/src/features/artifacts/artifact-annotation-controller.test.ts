import type { ArtifactCommentThread } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { createArtifactAnnotationController } from './artifact-annotation-controller';

const layout = {
  kortix: 'annotate',
  v: 1,
  type: 'layout',
  revision: 1,
  chunk: 0,
  final: true,
  complete: true,
  viewport: { width: 800, height: 600, scroll: { x: 0, y: 0 } },
  elements: [
    {
      n: 0,
      selector: '#title',
      snippet: 'Page quote',
      rect: { x: 10, y: 20, width: 100, height: 30 },
    },
  ],
  texts: [{ n: 0, offset: 0, text: 'Page quote' }],
} as const;
const anchor = {
  type: 'text',
  version: 'immutable-commit',
  quote: 'quote',
  prefix: 'Page ',
  suffix: '',
} as const;
function fixture(threads: ArtifactCommentThread[] = []) {
  const sent: any[] = [];
  const candidates: unknown[] = [];
  const focused: string[] = [];
  let rows: ArtifactCommentThread[] = [];
  const statuses: string[] = [];
  const timers = new Map<() => void, number>();
  const clock = {
    schedule: (callback: () => void, delay: number) => {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
    expire: () => {
      const callbacks = [...timers.keys()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => [...timers.values()],
  };
  const config = {
    version: 'immutable-commit',
    canComment: true,
    mode: 'text' as const,
    threads,
    focusedThreadId: null,
    focusRevision: 0,
  };
  const controller = createArtifactAnnotationController(
    {
      post: (message) => {
        sent.push(message);
        return true;
      },
      onThreads: (value) => {
        rows = value;
      },
      onCandidate: (value) => candidates.push(value),
      onFocus: (id) => focused.push(id),
      onStatus: (status) => statuses.push(status),
    },
    clock.schedule,
  );
  controller.update(config);
  return { controller, config, sent, candidates, focused, rows: () => rows, statuses, clock };
}

test('page messages cannot write and candidates require current complete layout and parent permission', () => {
  const f = fixture();
  const candidate = {
    kortix: 'annotate',
    v: 1,
    type: 'candidate',
    revision: 1,
    anchor: { type: 'text', quote: 'quote', prefix: 'Page ', suffix: '' },
  };
  f.controller.receive(candidate as never);
  expect(f.candidates).toHaveLength(0);
  f.controller.receive(layout as never);
  f.controller.receive({ ...candidate, revision: 0 } as never);
  expect(f.candidates).toHaveLength(0);
  f.controller.receive(candidate as never);
  expect(f.candidates).toEqual([anchor]);
  f.controller.update({ ...f.config, canComment: false });
  f.controller.receive(candidate as never);
  expect(f.candidates).toHaveLength(1);
  f.controller.update(f.config);
  f.controller.receive({ ...layout, revision: 2, complete: false } as never);
  f.controller.receive({ ...candidate, revision: 2 } as never);
  expect(f.candidates).toHaveLength(1);
});

test('draw messages contain only numeric ordinals and geometry; focus accepts only sent ordinals', () => {
  const thread = {
    thread_id: 'private-thread-id',
    anchor,
    status: 'open',
    comments: [{ body: 'private body', deleted_at: null }],
    outdated: true,
    position: null,
  } as ArtifactCommentThread;
  const f = fixture([thread]);
  f.controller.receive(layout as never);
  const draw = f.sent.findLast((message) => message.type === 'draw');
  expect(draw.pins).toEqual([{ n: 1, rects: [], ranges: [{ n: 0, start: 5, end: 10 }] }]);
  expect(JSON.stringify(f.sent)).not.toContain('private');
  expect(JSON.stringify(f.sent)).not.toContain('quote');
  expect(f.rows()[0]!.outdated).toBe(false);
  f.controller.receive({ type: 'focus', n: 999 } as never);
  expect(f.focused).toHaveLength(0);
  f.controller.receive({ type: 'focus', n: 1 } as never);
  expect(f.focused).toEqual(['private-thread-id']);
  f.controller.reset();
  f.controller.receive({ type: 'focus', n: 1 } as never);
  expect(f.focused).toHaveLength(1);
});

test('a malformed sequence never replaces a complete inventory or admits its candidates', () => {
  const f = fixture();
  f.controller.receive(layout as never);
  f.controller.receive({ ...layout, revision: 2, chunk: 1 } as never);
  f.controller.receive({
    kortix: 'annotate',
    v: 1,
    type: 'candidate',
    revision: 2,
    anchor: { type: 'text', quote: 'quote', prefix: '', suffix: '' },
  } as never);
  expect(f.candidates).toHaveLength(0);
});

test('pin ordinals stay bound to the same thread across polling order changes', () => {
  const a = {
    thread_id: 'thread-a',
    anchor,
    status: 'open',
    comments: [{ deleted_at: null }],
  } as ArtifactCommentThread;
  const b = { ...a, thread_id: 'thread-b' };
  const f = fixture([a, b]);
  f.controller.receive(layout as never);
  f.controller.update({ ...f.config, threads: [b, a] });
  f.controller.receive({ type: 'focus', n: 1 } as never);
  expect(f.focused).toEqual(['thread-a']);
  f.controller.update({ ...f.config, threads: [b] });
  f.controller.receive({ type: 'focus', n: 1 } as never);
  expect(f.focused).toHaveLength(1);
});

test('a large discussion sends a bounded draw and preserves the focused pin', () => {
  const threads = Array.from(
    { length: 1000 },
    (_, index) =>
      ({
        thread_id: `thread-${index}`,
        anchor,
        status: 'open',
        comments: [{ deleted_at: null }],
      }) as ArtifactCommentThread,
  );
  const f = fixture(threads);
  f.controller.receive(layout as never);
  f.controller.update({
    ...f.config,
    focusedThreadId: 'thread-999',
    focusRevision: 1,
  } as never);
  const draw = f.sent.findLast((message) => message.type === 'draw');
  expect(draw.pins.length).toBeGreaterThan(0);
  expect(draw.pins.length).toBeLessThan(1000);
  expect(draw.pins.some((pin: { n: number }) => pin.n === draw.active)).toBe(true);
  expect(draw.focus).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(draw)).length).toBeLessThanOrEqual(65536);
});

test('only a complete final inventory makes annotation controls ready', () => {
  const f = fixture();
  expect(f.statuses.at(-1)).toBe('loading');
  expect(f.clock.pending()).toEqual([15000]);
  f.controller.receive({ kortix: 'annotate', v: 1, type: 'ready' });
  f.controller.receive({ ...layout, final: false } as never);
  expect(f.statuses.at(-1)).toBe('loading');
  expect(f.clock.pending()).toEqual([15000]);
  f.controller.receive({ ...layout, chunk: 1, elements: [], texts: [] } as never);
  expect(f.statuses.at(-1)).toBe('ready');
  expect(f.clock.pending()).toEqual([]);
});

test('truncation disables new annotations while verified existing pins remain visible', () => {
  const thread = {
    thread_id: 'known-point',
    anchor: {
      type: 'point',
      version: 'immutable-commit',
      selector: '#title',
      snippet: 'Page quote',
      viewport_width: 800,
      scroll: { x: 0, y: 0 },
      offset: { x: 0.5, y: 0.5 },
    },
    status: 'open',
    comments: [{ deleted_at: null }],
  } as ArtifactCommentThread;
  const f = fixture([thread]);
  f.controller.receive({ ...layout, complete: false } as never);
  expect(f.statuses.at(-1)).toBe('unavailable');
  expect(f.clock.pending()).toEqual([]);
  expect(f.sent.findLast((message) => message.type === 'draw').pins).toHaveLength(1);
});

test('the deadline reports unavailable without retry, then reload starts a new bounded attempt', () => {
  const f = fixture();
  const requested = f.sent.filter((message) => message.type === 'request_layout').length;
  f.clock.expire();
  expect(f.statuses.at(-1)).toBe('unavailable');
  expect(f.sent.filter((message) => message.type === 'request_layout')).toHaveLength(requested);
  f.controller.receive(layout as never);
  expect(f.statuses.at(-1)).toBe('ready');
  f.controller.reset();
  expect(f.statuses.at(-1)).toBe('loading');
  expect(f.clock.pending()).toEqual([15000]);
  f.controller.dispose();
  expect(f.clock.pending()).toEqual([]);
  const count = f.statuses.length;
  f.clock.expire();
  f.controller.receive(layout as never);
  expect(f.statuses).toHaveLength(count);
});

test('loading and unavailable release comment mode, then a complete layout restores the selected mode', () => {
  const f = fixture();
  f.controller.update({ ...f.config, mode: 'comment' });
  const mode = () => f.sent.findLast((message) => message.type === 'mode').mode;
  expect(mode()).toBe('off');
  f.controller.receive(layout as never);
  expect(mode()).toBe('comment');
  f.controller.receive({ ...layout, revision: 2, complete: false } as never);
  expect(f.statuses.at(-1)).toBe('unavailable');
  expect(mode()).toBe('off');
  f.controller.receive({ ...layout, revision: 3 } as never);
  expect(mode()).toBe('comment');
  f.controller.reset();
  expect(mode()).toBe('off');
  f.clock.expire();
  expect(f.statuses.at(-1)).toBe('unavailable');
  expect(mode()).toBe('off');
});
