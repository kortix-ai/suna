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

test('capture binds one private request to current layout and assembles ordered bounded PNG bytes', async () => {
  const f = fixture();
  f.controller.receive(layout as never);
  const rect = { x: 20, y: 22, width: 10, height: 10 };
  const region = f.controller.regionForViewportRect(rect)!;
  expect(region.anchor.type).toBe('region');
  expect(region.documentRect).toEqual(rect);
  const pending = f.controller.capture(rect);
  const request = f.sent.findLast((message) => message.type === 'capture');
  expect(request.rect).toEqual(rect);
  expect(JSON.stringify(request)).not.toContain('immutable-commit');
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zxc8AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  );
  const common = { kortix: 'annotate', v: 1, request: request.request, revision: 1 };
  f.controller.receive({
    ...common,
    type: 'capture_complete',
    request: request.request + 1,
  } as never);
  f.controller.receive({
    ...common,
    type: 'capture_start',
    mime: 'image/png',
    width: 1,
    height: 1,
    bytes: png.length,
    chunks: 1,
  } as never);
  f.controller.receive({
    ...common,
    type: 'capture_chunk',
    index: 0,
    data: btoa(String.fromCharCode(...png)),
  } as never);
  f.controller.receive({ ...common, type: 'capture_complete' } as never);
  const result = await pending;
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.blob.size).toBe(png.length);
    expect(result.blob.type).toBe('image/png');
  }
});

test('capture cancels on revision, reset, timeout and disposal without reusing request ids', async () => {
  const f = fixture();
  f.controller.receive(layout as never);
  const rect = { x: 20, y: 22, width: 10, height: 10 };
  const first = f.controller.capture(rect);
  const id = f.sent.findLast((message) => message.type === 'capture').request;
  f.controller.receive({ ...layout, revision: 2 } as never);
  expect(await first).toEqual({ ok: false, reason: 'stale' });
  const second = f.controller.capture(rect);
  expect(f.sent.findLast((message) => message.type === 'capture').request).toBeGreaterThan(id);
  f.clock.expire();
  expect(await second).toEqual({ ok: false, reason: 'timeout' });
  const third = f.controller.capture(rect);
  f.controller.reset();
  expect(await third).toEqual({ ok: false, reason: 'stale' });
  expect(f.controller.regionForViewportRect(rect)).toBeNull();
  f.controller.receive({ ...layout, revision: 3 } as never);
  const fourth = f.controller.capture(rect);
  f.controller.dispose();
  expect(await fourth).toEqual({ ok: false, reason: 'cancelled' });
});

test('capture rejects gaps, bad encoded sizes and oversized declarations without keeping a partial image', async () => {
  for (const invalid of ['gap', 'size', 'oversized', 'missing']) {
    const f = fixture();
    f.controller.receive(layout as never);
    const pending = f.controller.capture({ x: 10, y: 20, width: 20, height: 10 });
    const request = f.sent.findLast((message) => message.type === 'capture');
    const common = { kortix: 'annotate', v: 1, request: request.request, revision: 1 };
    f.controller.receive({
      ...common,
      type: 'capture_start',
      mime: 'image/png',
      width: 1,
      height: 1,
      bytes: invalid === 'oversized' ? 2097153 : 24,
      chunks: 1,
    } as never);
    if (invalid === 'missing')
      f.controller.receive({ ...common, type: 'capture_complete' } as never);
    else if (invalid !== 'oversized')
      f.controller.receive({
        ...common,
        type: 'capture_chunk',
        index: invalid === 'gap' ? 1 : 0,
        data: 'AAAA',
      } as never);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    f.controller.dispose();
  }
});

test('resolved region geometry remains private and clears with a frame reset', () => {
  const sent: unknown[] = [];
  let regions: Readonly<Record<string, { x: number; y: number; width: number; height: number }>> =
    {};
  const controller = createArtifactAnnotationController(
    {
      post: (message) => {
        sent.push(message);
        return true;
      },
      onCandidate() {},
      onFocus() {},
      onThreads() {},
      onRegions: (value) => {
        regions = value;
      },
    },
    () => () => {},
  );
  controller.update({
    version: 'immutable-commit',
    canComment: true,
    mode: 'text',
    focusRevision: 0,
    focusedThreadId: null,
    threads: [
      {
        thread_id: 'private-thread',
        anchor: {
          type: 'region',
          version: 'immutable-commit',
          selector: '#title',
          snippet: 'Page quote',
          viewport_width: 800,
          scroll: { x: 0, y: 0 },
          offset: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
        },
        status: 'open',
        comments: [{ deleted_at: null }],
      } as never,
    ],
  });
  controller.receive(layout as never);
  expect(regions['private-thread']).toEqual({ x: 30, y: 26, width: 50, height: 15 });
  expect(JSON.stringify(sent)).not.toContain('private-thread');
  controller.reset();
  expect(regions).toEqual({});
  controller.dispose();
});
