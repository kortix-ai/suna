import { afterAll, afterEach, expect, test } from 'bun:test';
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ArtifactAnnotationScheduler } from './artifact-annotation-controller';
import { useArtifactAnnotations } from './use-artifact-annotations';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const previousWindow = globalThis.window;
let root: ReactTestRenderer | undefined;
let observed: ReturnType<typeof useArtifactAnnotations>;
type Options = Parameters<typeof useArtifactAnnotations>[0];
function Probe({ options, schedule }: { options: Options; schedule: ArtifactAnnotationScheduler }) {
  const value = useArtifactAnnotations(options, schedule);
  useLayoutEffect(() => {
    observed = value;
  });
  return null;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
});
afterAll(() => {
  globalThis.window = previousWindow;
});
function fixture() {
  const host = new EventTarget();
  globalThis.window = host as unknown as Window & typeof globalThis;
  const posts: unknown[] = [];
  const contentWindow = { postMessage: (message: unknown) => posts.push(message) };
  const frame = Object.assign(new EventTarget(), { contentWindow }) as unknown as HTMLIFrameElement;
  const slot = {
    current: { isConnected: true, contains: (node: unknown) => node === frame },
  } as unknown as Options['slot'];
  const timers = new Map<() => void, number>();
  const schedule: ArtifactAnnotationScheduler = (callback, delay) => {
    timers.set(callback, delay);
    return () => {
      timers.delete(callback);
    };
  };
  const options: Options = {
    enabled: false,
    frame,
    slot,
    version: 'vc_one',
    canComment: true,
    mode: 'text',
    threads: [],
    focusedThreadId: null,
    focusRevision: 0,
    onCandidate() {},
    onFocus() {},
  };
  const render = (next = options) =>
    act(() => {
      const element = createElement(Probe, { options: next, schedule });
      if (root) root.update(element);
      else root = create(element);
    });
  const message = (data: unknown) =>
    act(() => {
      host.dispatchEvent(Object.assign(new Event('message'), { data, source: contentWindow }));
    });
  const expire = () =>
    act(() => {
      const callbacks = [...timers.keys()];
      timers.clear();
      for (const callback of callbacks) callback();
    });
  return { host, frame, options, render, timers, posts, message, expire };
}

const layout = {
  kortix: 'annotate',
  v: 1,
  type: 'layout',
  revision: 1,
  chunk: 0,
  final: true,
  complete: true,
  viewport: { width: 800, height: 600, scroll: { x: 0, y: 0 } },
  elements: [],
  texts: [],
};

test('disabled annotation hook exposes unavailable without blocking the original thread data', () => {
  const f = fixture();
  f.render();
  expect(observed.status).toBe('unavailable');
  expect(observed.threads).toBe(f.options.threads!);
  expect(f.timers.size).toBe(0);
});

test('the real hook reports readiness, resets on frame load, and cancels its timeout on unmount', () => {
  const f = fixture();
  f.render({ ...f.options, enabled: true });
  expect(observed.status).toBe('loading');
  expect([...f.timers.values()]).toEqual([15000]);
  f.message({ ...layout, final: false });
  expect(observed.status).toBe('loading');
  f.message({ ...layout, chunk: 1 });
  expect(observed.status).toBe('ready');
  expect(f.timers.size).toBe(0);
  act(() => observed.reset());
  expect(observed.status).toBe('loading');
  expect([...f.timers.values()]).toEqual([15000]);
  f.message(layout);
  expect(observed.status).toBe('ready');
  act(() => {
    f.frame.dispatchEvent(new Event('load'));
  });
  expect(observed.status).toBe('loading');
  expect([...f.timers.values()]).toEqual([15000]);
  f.expire();
  expect(observed.status).toBe('unavailable');
  f.message(layout);
  expect(observed.status).toBe('ready');
  f.render({ ...f.options, enabled: true, version: 'vc_two' });
  expect(observed.status).toBe('loading');
  expect(f.timers.size).toBe(1);
  act(() => {
    root!.unmount();
  });
  root = undefined;
  expect(f.timers.size).toBe(0);
  const posted = f.posts.length;
  f.expire();
  f.message(layout);
  expect(f.posts).toHaveLength(posted);
});

test('private capture geometry follows the owned frame and load cancels pending output', async () => {
  const f = fixture();
  f.render();
  expect(observed.viewport).toBeNull();
  expect(observed.regions).toEqual({});
  f.render({ ...f.options, enabled: true });
  f.message({
    ...layout,
    viewport: { width: 800, height: 600, scroll: { x: 0, y: 3 } },
    elements: [
      { n: 0, selector: 'html', snippet: '', rect: { x: 0, y: 0, width: 800, height: 1000 } },
    ],
  });
  expect(observed.viewport?.scroll.y).toBe(3);
  expect(
    observed.regionForViewportRect({ x: 10, y: 10, width: 20, height: 20 })?.documentRect.y,
  ).toBe(13);
  const pending = observed.capture({ x: 10, y: 13, width: 20, height: 20 });
  act(() => {
    f.frame.dispatchEvent(new Event('load'));
  });
  expect(await pending).toEqual({ ok: false, reason: 'stale' });
  expect(observed.viewport).toBeNull();
  expect(observed.regions).toEqual({});
});

test('permission, version, frame, and enabled scope changes discard pending capture bytes', async () => {
  for (const change of ['permission', 'version', 'frame', 'enabled']) {
    const f = fixture();
    const initial = { ...f.options, enabled: true };
    f.render(initial);
    f.message(layout);
    const pending = observed.capture({ x: 10, y: 10, width: 20, height: 20 });
    const next = { ...initial };
    if (change === 'permission') next.canComment = false;
    if (change === 'version') next.version = 'vc_two';
    if (change === 'enabled') next.enabled = false;
    if (change === 'frame')
      next.frame = Object.assign(new EventTarget(), {
        contentWindow: {},
      }) as unknown as HTMLIFrameElement;
    f.render(next);
    expect((await pending).ok).toBe(false);
    act(() => root!.unmount());
    root = undefined;
    expect(f.timers.size).toBe(0);
  }
});

test('a completed drawing epoch cannot survive a newer single-chunk layout with identical viewport numbers', () => {
  const f = fixture();
  f.render({ ...f.options, enabled: true });
  f.message(layout);
  const first = observed.viewport!;
  expect(observed.isCurrentViewport(first)).toBe(true);
  f.message({ ...layout, revision: 2 });
  expect(observed.status).toBe('ready');
  expect(observed.viewport).toEqual(first);
  expect(observed.isCurrentViewport(first)).toBe(false);
  expect(observed.isCurrentViewport(observed.viewport!)).toBe(true);
  act(() => { f.frame.dispatchEvent(new Event('load')); });
  expect(observed.isCurrentViewport(first)).toBe(false);
});

test('the hook offers text selections, forwards page keys, labels pins and reports their numbers', () => {
  const f = fixture();
  const selections: unknown[] = [];
  const keys: unknown[] = [];
  const thread = {
    thread_id: 'thread-a',
    anchor: { type: 'text', version: 'vc_one', quote: 'Pricing', prefix: '', suffix: '' },
    status: 'open',
    comments: [{ deleted_at: null }],
  } as never;
  const options: Options = {
    ...f.options,
    enabled: true,
    threads: [thread],
    onSelection: (value) => selections.push(value),
    onKey: (value) => keys.push(value),
    pinLabel: (n) => `Comment ${n}`,
  };
  f.render(options);
  f.message({ ...layout, texts: [{ n: 0, offset: 0, text: 'Pricing page' }] });
  expect([...observed.pinNumbers]).toEqual([['thread-a', 1]]);
  const draw = f.posts.findLast((post: any) => post.type === 'draw') as any;
  expect(draw.pins).toEqual([
    { n: 1, rects: [], ranges: [{ n: 0, start: 0, end: 7 }], label: 'Comment 1' },
  ]);
  const anchor = { type: 'text', quote: 'page', prefix: 'Pricing ', suffix: '' };
  // The mount withdraws any earlier offer (a new controller, then its reset).
  expect(selections).toEqual([null, null]);
  selections.length = 0;
  f.message({ kortix: 'annotate', v: 1, type: 'candidate', revision: 1, anchor });
  f.message({ kortix: 'annotate', v: 1, type: 'key', key: 'comment' });
  f.message({ kortix: 'annotate', v: 1, type: 'selection', state: 'none' });
  expect(selections).toEqual([
    { state: 'candidate', anchor: { ...anchor, version: 'vc_one' }, rect: null },
    null,
  ]);
  expect(keys).toEqual(['comment']);
  f.render({ ...options, enabled: false });
  expect(observed.pinNumbers.size).toBe(0);
});

test('a forged page Escape never reaches a drawing, and a layout withdrawal reports moved', () => {
  const f = fixture();
  const selections: unknown[] = [];
  const keys: unknown[] = [];
  const options: Options = {
    ...f.options,
    enabled: true,
    drawing: true,
    onSelection: (value, moved) => selections.push([value, moved]),
    onKey: (value) => keys.push(value),
  };
  f.render(options);
  f.message({ ...layout, texts: [{ n: 0, offset: 0, text: 'Pricing page' }] });
  const anchor = { type: 'text', quote: 'page', prefix: 'Pricing ', suffix: '' };
  f.message({ kortix: 'annotate', v: 1, type: 'candidate', revision: 1, anchor });
  // The page posts Escape in a loop while the person draws: the strokes stay.
  for (let index = 0; index < 3; index++)
    f.message({ kortix: 'annotate', v: 1, type: 'key', key: 'escape' });
  expect(keys).toEqual([]);
  f.render({ ...options, drawing: false });
  f.message({ kortix: 'annotate', v: 1, type: 'key', key: 'escape' });
  expect(keys).toEqual(['escape']);
  selections.length = 0;
  f.message({ kortix: 'annotate', v: 1, type: 'selection', state: 'none', moved: true });
  f.message({ kortix: 'annotate', v: 1, type: 'selection', state: 'none' });
  expect(selections).toEqual([
    [null, true],
    [null, false],
  ]);
});
