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

/** A controller with the selection, key and pin callbacks recorded, on a page scrolled 200 px. */
function selectionFixture(threads: ArtifactCommentThread[] = []) {
  const sent: any[] = [];
  /** [callback, value], plus 'moved' for a selection withdrawn by a page layout. */
  const events: ([string, unknown] | [string, unknown, 'moved'])[] = [];
  const config = {
    version: 'immutable-commit',
    canComment: true,
    mode: 'text' as 'text' | 'comment',
    threads,
    focusedThreadId: null,
    focusRevision: 0,
    pinLabel: (n: number) => `Comment ${n}`,
  };
  const controller = createArtifactAnnotationController(
    {
      post: (message) => {
        sent.push(message);
        return true;
      },
      onThreads() {},
      onFocus() {},
      onCandidate: (value) => events.push(['candidate', value]),
      onSelection: (value, moved) => {
        events.push(moved ? ['selection', value, 'moved'] : ['selection', value]);
      },
      onKey: (value) => events.push(['key', value]),
      onPins: (value) => events.push(['pins', [...value]]),
    },
    () => () => {},
  );
  controller.update(config);
  const scrolled = { ...layout, viewport: { ...layout.viewport, scroll: { x: 0, y: 200 } } };
  controller.receive(scrolled as never);
  events.length = 0;
  return { controller, config, sent, events };
}
const envelope = { kortix: 'annotate', v: 1 } as const;
const textCandidate = { type: 'text', quote: 'quote', prefix: 'Page ', suffix: '' } as const;

test('a text selection is only an offer with viewport geometry; a pin or region still asks to comment', () => {
  const f = selectionFixture();
  const rect = { x: 40, y: 250, width: 120, height: 18 };
  f.controller.receive({
    ...envelope,
    type: 'candidate',
    revision: 1,
    anchor: textCandidate,
    rect,
  });
  // The page box is in document coordinates: the parent subtracts the page's scroll.
  expect(f.events).toEqual([
    ['selection', { state: 'candidate', anchor, rect: { x: 40, y: 50, width: 120, height: 18 } }],
  ]);
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: textCandidate });
  expect(f.events.at(-1)).toEqual(['selection', { state: 'candidate', anchor, rect: null }]);
  const point = {
    type: 'point',
    selector: '#title',
    snippet: 'Page quote',
    viewport_width: 800,
    scroll: { x: 0, y: 200 },
    offset: { x: 0.5, y: 0.5 },
  } as const;
  // The bridge places pins only in pin mode: a pin posted in text mode is forged.
  f.events.length = 0;
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: point, rect });
  expect(f.events).toEqual([]);
  f.controller.update({ ...f.config, mode: 'comment' });
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: point, rect });
  expect(f.events.at(-1)).toEqual(['candidate', { ...point, version: 'immutable-commit' }]);
  // Comment mode takes no text offers.
  f.events.length = 0;
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: textCandidate });
  expect(f.events).toEqual([]);
});

test('the page withdraws an offer, reports a too-long selection, and forwards keys only with permission', () => {
  const f = selectionFixture();
  const tooLong = {
    ...envelope,
    type: 'selection',
    state: 'too_long',
    rect: { x: 0, y: 210, width: 50, height: 10 },
  } as const;
  f.controller.receive({ ...envelope, type: 'selection', state: 'none' });
  f.controller.receive(tooLong);
  f.controller.receive({ ...envelope, type: 'key', key: 'comment' });
  f.controller.receive({ ...envelope, type: 'key', key: 'escape' });
  expect(f.events).toEqual([
    ['selection', null],
    ['selection', { state: 'too_long', rect: { x: 0, y: 10, width: 50, height: 10 } }],
    ['key', 'comment'],
    ['key', 'escape'],
  ]);
  f.controller.update({ ...f.config, canComment: false });
  f.events.length = 0;
  f.controller.receive({ ...envelope, type: 'key', key: 'comment' });
  f.controller.receive(tooLong);
  expect(f.events.filter(([kind]) => kind !== 'pins')).toEqual([['selection', null]]);
});

test('a page key counts only where the bridge sends one, and never while the parent draws', () => {
  const f = selectionFixture();
  const press = (key: 'escape' | 'comment') =>
    f.controller.receive({ ...envelope, type: 'key', key });
  const keys = () => f.events.filter(([kind]) => kind === 'key').map(([, key]) => key);
  // Text mode without an offered selection: the bridge sends neither key, so both are forged.
  press('escape');
  press('comment');
  expect(keys()).toEqual([]);
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: textCandidate });
  press('escape');
  press('comment');
  expect(keys()).toEqual(['escape', 'comment']);
  // Draw mode: the drawing layer covers the page and owns Escape. A page key cannot reach it.
  f.events.length = 0;
  f.controller.update({ ...f.config, drawing: true });
  press('escape');
  press('comment');
  expect(keys()).toEqual([]);
  // Pin mode: Escape leaves it. The shortcut has no selection there.
  f.controller.update({ ...f.config, mode: 'comment' });
  press('escape');
  press('comment');
  expect(keys()).toEqual(['escape']);
  // A withdrawn offer takes its keys with it.
  f.events.length = 0;
  f.controller.update(f.config);
  f.controller.receive({ ...envelope, type: 'candidate', revision: 1, anchor: textCandidate });
  f.controller.receive({ ...envelope, type: 'selection', state: 'none' });
  press('escape');
  press('comment');
  expect(keys()).toEqual([]);
});

test('an offer the page withdraws for a scroll or resize says so; one withdrawn by a gesture does not', () => {
  const f = selectionFixture();
  f.controller.receive({ ...envelope, type: 'selection', state: 'none', moved: true });
  f.controller.receive({ ...envelope, type: 'selection', state: 'none' });
  expect(f.events).toEqual([
    ['selection', null, 'moved'],
    ['selection', null],
  ]);
});

test('a reset, a new version or a mode change withdraws the offer', () => {
  const f = selectionFixture();
  f.controller.reset();
  f.controller.update({ ...f.config, mode: 'comment' });
  f.controller.update({ ...f.config, mode: 'comment', version: 'next-commit' });
  expect(f.events.filter(([kind]) => kind === 'selection')).toEqual([
    ['selection', null],
    ['selection', null],
    ['selection', null],
  ]);
});

test('pins carry a numbered label and the parent learns each thread pin number', () => {
  const thread = {
    thread_id: 'thread-a',
    anchor,
    status: 'open',
    comments: [{ body: 'private body', deleted_at: null }],
  } as ArtifactCommentThread;
  const f = selectionFixture([thread]);
  f.controller.update({ ...f.config, threads: [thread] });
  const draw = f.sent.findLast((message) => message.type === 'draw');
  expect(draw.pins).toEqual([
    { n: 1, rects: [], ranges: [{ n: 0, start: 5, end: 10 }], label: 'Comment 1' },
  ]);
  expect(JSON.stringify(f.sent)).not.toContain('private');
  expect(f.events.findLast(([kind]) => kind === 'pins')).toEqual(['pins', [['thread-a', 1]]]);
  // A label that does not name the number, or runs over 64 units, is dropped: the pin keeps its number.
  for (const label of [() => 'private body', (n: number) => `${n} ${'x'.repeat(64)}`]) {
    f.controller.update({ ...f.config, threads: [thread], pinLabel: label });
    const next = f.sent.findLast((message) => message.type === 'draw');
    expect(next.pins).toEqual([{ n: 1, rects: [], ranges: [{ n: 0, start: 5, end: 10 }] }]);
  }
  f.controller.reset();
  expect(f.events.findLast(([kind]) => kind === 'pins')).toEqual(['pins', []]);
});

test('a saved thread that replaces its optimistic copy takes the number the copy held', () => {
  const thread = (id: string) =>
    ({
      thread_id: id,
      anchor,
      status: 'open',
      comments: [{ deleted_at: null }],
    }) as ArtifactCommentThread;
  const f = selectionFixture();
  const kept = thread('thread-kept');
  f.controller.update({ ...f.config, threads: [kept, thread('optimistic-thread-1')] });
  expect(f.events.findLast(([kind]) => kind === 'pins')).toEqual([
    'pins',
    [
      ['thread-kept', 1],
      ['optimistic-thread-1', 2],
    ],
  ]);
  f.controller.update({ ...f.config, threads: [thread('thread-saved'), kept] });
  // The kept thread keeps 1 although it moved; the saved thread takes the freed 2.
  expect(f.events.findLast(([kind]) => kind === 'pins')).toEqual([
    'pins',
    [
      ['thread-saved', 2],
      ['thread-kept', 1],
    ],
  ]);
});
