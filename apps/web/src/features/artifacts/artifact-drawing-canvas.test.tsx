import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { DrawingStroke } from './artifact-drawing';
import type { DrawingLabels } from './artifact-drawing-canvas';

const page = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: page,
  document: page.document,
  navigator: page.navigator,
  HTMLElement: page.HTMLElement,
  HTMLInputElement: page.HTMLInputElement,
  HTMLButtonElement: page.HTMLButtonElement,
  Element: page.Element,
  Node: page.Node,
  NodeFilter: page.NodeFilter,
  DocumentFragment: page.DocumentFragment,
  MutationObserver: page.MutationObserver,
  CustomEvent: page.CustomEvent,
  KeyboardEvent: page.KeyboardEvent,
  PointerEvent: page.PointerEvent,
  getComputedStyle: page.getComputedStyle.bind(page),
  requestAnimationFrame: page.requestAnimationFrame.bind(page),
  cancelAnimationFrame: page.cancelAnimationFrame.bind(page),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
let Canvas: typeof import('./artifact-drawing-canvas').ArtifactDrawingCanvas;
const host = page.document.createElement('div');
page.document.body.append(host);
const root = createRoot(host as unknown as Element);
const finish = mock((_strokes: DrawingStroke[]) => undefined);
const cancel = mock(() => undefined);
const labels: DrawingLabels = {
  canvas: 'Draw',
  pen: 'Pen',
  arrow: 'Arrow',
  rectangle: 'Rectangle',
  black: 'Black',
  red: 'Red',
  blue: 'Blue',
  undo: 'Undo',
  finish: 'Comment',
  cancel: 'Cancel',
  pageChanged: 'Page changed',
  limit: 'Drawing limit',
};
beforeAll(async () => {
  Canvas = (await import('./artifact-drawing-canvas')).ArtifactDrawingCanvas;
});
afterEach(async () => {
  await act(async () => root.render(null));
  finish.mockClear();
  cancel.mockClear();
});
afterAll(async () => {
  await act(async () => root.unmount());
  await page.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function mount(width = 200, busy = false, stale = false) {
  await act(async () =>
    root.render(
      createElement(Canvas, {
        viewport: { width, height: 120 },
        busy,
        stale,
        labels,
        onFinish: finish,
        onCancel: cancel,
      }),
    ),
  );
  const svg =
    host.querySelector('svg[data-artifact-canvas]') ?? host.querySelector('svg[role="img"]')!;
  Object.defineProperty(svg, 'clientWidth', { configurable: true, value: width });
  svg.getBoundingClientRect = () => new page.DOMRect(0, 0, width, 120);
  return svg;
}
const button = (name: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (item) => item.getAttribute('aria-label') === name || item.textContent === name,
  )!;
async function click(name: string) {
  await act(async () => button(name).click());
}
async function stroke(svg: ReturnType<typeof mount> extends Promise<infer T> ? T : never) {
  for (const [type, x, y] of [
    ['pointerdown', 20, 20],
    ['pointermove', 80, 70],
    ['pointerup', 80, 70],
  ] as const) {
    await act(async () =>
      svg.dispatchEvent(
        new page.PointerEvent(type, {
          pointerId: 1,
          button: 0,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }
}

test('real controls draw, undo, choose tools/colors, and finish with bounded local strokes', async () => {
  const svg = await mount();
  expect(button('Comment').disabled).toBe(true);
  await stroke(svg);
  expect(button('Comment').disabled).toBe(false);
  await click('Comment');
  expect(finish.mock.calls[0]![0]).toMatchObject([{ tool: 'pen', color: 'black' }]);
  await click('Undo');
  expect(button('Comment').disabled).toBe(true);
  await click('Arrow');
  await click('Red');
  await stroke(svg);
  await click('Comment');
  expect(finish.mock.calls.at(-1)![0]).toMatchObject([{ tool: 'arrow', color: 'red' }]);
  await click('Undo');
  await click('Rectangle');
  await click('Blue');
  await stroke(svg);
  await click('Comment');
  expect(finish.mock.calls.at(-1)![0]).toMatchObject([{ tool: 'rectangle', color: 'blue' }]);
});

test('capture keeps cancel usable and Escape consumed while submission is disabled', async () => {
  await mount(200, true);
  expect(button('Pen').disabled).toBe(true);
  expect(button('Comment').disabled).toBe(true);
  await click('Cancel');
  expect(cancel).toHaveBeenCalledTimes(1);
  const event = new page.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => host.querySelector('svg[role="img"]')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(2);
});

test('a smaller viewport preserves strokes and refuses a clipped submission until restored', async () => {
  const svg = await mount();
  await stroke(svg);
  await mount(40);
  expect(button('Comment').disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Page changed');
  await mount();
  expect(button('Comment').disabled).toBe(false);
  await click('Comment');
  expect(finish.mock.calls[0]![0]).toHaveLength(1);
});

test('losing pointer capture discards the unfinished gesture and permits a new stroke', async () => {
  const svg = await mount();
  await act(async () =>
    svg.dispatchEvent(
      new page.PointerEvent('pointerdown', {
        pointerId: 1,
        clientX: 20,
        clientY: 20,
        button: 0,
        bubbles: true,
      }),
    ),
  );
  expect(svg.querySelector('circle')).not.toBeNull();
  await act(async () =>
    svg.dispatchEvent(new page.PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true })),
  );
  expect(svg.querySelector('circle')).toBeNull();
  expect(button('Comment').disabled).toBe(true);
  await stroke(svg);
  await click('Comment');
  expect(finish.mock.calls[0]![0]).toHaveLength(1);
});

test('a changed layout keeps the draft visible but refuses to submit or add misplaced strokes', async () => {
  const svg = await mount();
  await stroke(svg);
  const points = svg.querySelector('polyline')!.getAttribute('points');
  await mount(200, false, true);
  expect(button('Comment').disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Page changed');
  await stroke(svg);
  expect(svg.querySelectorAll('polyline')).toHaveLength(1);
  expect(svg.querySelector('polyline')!.getAttribute('points')).toBe(points);
});

test('a secondary pointer cancellation does not discard the primary pen stroke', async () => {
  const svg = await mount();
  await act(async () =>
    svg.dispatchEvent(
      new page.PointerEvent('pointerdown', {
        pointerId: 1,
        clientX: 20,
        clientY: 20,
        button: 0,
        bubbles: true,
      }),
    ),
  );
  await act(async () =>
    svg.dispatchEvent(new page.PointerEvent('pointercancel', { pointerId: 2, bubbles: true })),
  );
  expect(svg.querySelector('circle')).not.toBeNull();
  await act(async () =>
    svg.dispatchEvent(
      new page.PointerEvent('pointerup', {
        pointerId: 1,
        clientX: 30,
        clientY: 30,
        button: 0,
        bubbles: true,
      }),
    ),
  );
  await click('Comment');
  expect(finish.mock.calls[0]![0]).toHaveLength(1);
});

test('a wide drawing previews the same clamped width that the stored image uses', async () => {
  const svg = await mount(4096);
  for (const [type, x] of [
    ['pointerdown', 20],
    ['pointermove', 3500],
    ['pointerup', 3500],
  ] as const) {
    await act(async () =>
      svg.dispatchEvent(
        new page.PointerEvent(type, {
          pointerId: 1,
          clientX: x,
          clientY: 40,
          button: 0,
          bubbles: true,
        }),
      ),
    );
  }
  expect(Number(svg.querySelector('polyline')!.getAttribute('stroke-width'))).toBeCloseTo(3.528, 6);
});
