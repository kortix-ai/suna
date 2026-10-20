import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { cacheMermaidSvg } from './mermaid-render';

const win = new Window();
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'WheelEvent', 'TouchEvent', 'Touch', 'DocumentFragment', 'NodeFilter', 'DOMRect', 'HTMLInputElement', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? win : key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : Reflect.get(win, key) });
}
let failure: string | null = null;
let resolveRender: (value: { svg: string }) => void = () => {};
const initialize = mock(() => {});
const render = mock((id: string, _source: string) => {
  if (failure) {
    for (const nodeId of [id, `d${id}`]) {
      const node = document.createElement('div');
      node.id = nodeId;
      document.body.appendChild(node);
    }
    return Promise.reject(new Error(failure));
  }
  return new Promise<{ svg: string }>((resolve) => { resolveRender = resolve; });
});
mock.module('mermaid', () => ({ default: { initialize, render } }));
const { MermaidRenderer } = await import('./mermaid-renderer');
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  win.document.body.innerHTML = '';
  render.mockClear();
  failure = null;
});
async function mount(chart: string, isStreaming = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<MermaidRenderer chart={chart} isStreaming={isStreaming} />));
}

test('cached SVG bypasses initialization and rendering', async () => {
  cacheMermaidSvg('graph TD\ncached', '<svg data-cached="yes"></svg>');
  await mount('graph TD\ncached');
  expect(host.querySelector('[data-cached="yes"]')).not.toBeNull();
  expect(initialize).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

test('empty source finishes loading without rendering', async () => {
  await mount('');
  expect(host.querySelector('.mermaid-container')).not.toBeNull();
  expect(render).not.toHaveBeenCalled();
});

test('unsupported source preserves the exact validation error', async () => {
  await mount('not-a-diagram');
  expect(host.textContent).toContain('Invalid diagram type. Chart must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.). Found: "not-a-diagram"');
  expect(render).not.toHaveBeenCalled();
});

test('streaming source stays pending until settled', async () => {
  await mount('graph TD\nstreaming', true);
  expect(host.textContent).toContain('Rendering Mermaid diagram...');
  expect(render).not.toHaveBeenCalled();
});

test('initialization stays strict and a stale completion cannot replace the new SVG', async () => {
  await mount('graph TD\nold');
  expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', suppressErrorRendering: true }));
  expect(render).toHaveBeenCalledTimes(1);
  cacheMermaidSvg('graph TD\nnew', '<svg data-new="yes"></svg>');
  await act(async () => root.render(<MermaidRenderer chart={'graph TD\nnew'} />));
  await act(async () => resolveRender({ svg: '<svg data-old="yes"></svg>' }));
  expect(host.querySelector('[data-new="yes"]')).not.toBeNull();
  expect(host.querySelector('[data-old="yes"]')).toBeNull();
});

for (const [message, expected] of [
  ['Parse error detail', 'Diagram syntax error: Parse error detail'],
  ['Syntax error detail', 'Diagram syntax error: Syntax error detail'],
  ['UnknownDiagramError', 'Unsupported diagram type (not available in Mermaid 11.x)'],
  ['No diagram type detected', 'Unsupported diagram type (not available in Mermaid 11.x)'],
  ['other failure', 'Failed to render diagram: other failure'],
]) {
  test(`render failure ${message} stays scoped and preserves classification`, async () => {
    failure = message;
    const sibling = document.createElement('div');
    sibling.id = 'other-diagram';
    document.body.appendChild(sibling);
    await mount(`graph TD\n${message}`);
    expect(host.textContent).toContain(expected);
    expect(document.querySelectorAll('[id^="mermaid-"], [id^="dmermaid-"]')).toHaveLength(0);
    expect(document.getElementById('other-diagram')).toBe(sibling);
  });
}

test('fullscreen rotation and reopening preserve the reset', async () => {
  cacheMermaidSvg('graph TD\nzoom', '<svg></svg>');
  await mount('graph TD\nzoom');
  const open = host.querySelector<HTMLButtonElement>('[aria-label="Open diagram fullscreen"]');
  if (!open) throw new Error('missing fullscreen button');
  await act(async () => open.click());
  const rotate = document.querySelector<HTMLButtonElement>('[aria-label="Rotate diagram"]');
  if (!rotate) throw new Error('missing rotate button');
  await act(async () => rotate.click());
  const image = document.querySelector<HTMLElement>('.mermaid-container[style*="transform"]');
  expect(image?.style.transform).toBe('translate(0px, 0px) scale(0.8) rotate(90deg)');
  const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
  if (!zoomIn) throw new Error('missing zoom button');
  await act(async () => zoomIn.click());
  const canvas = image?.parentElement;
  if (!canvas || !image) throw new Error('missing canvas');
  canvas.getBoundingClientRect = () => new DOMRect(10, 20, 400, 300);
  const wheel = new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true });
  Object.defineProperties(wheel, { clientX: { value: 110 }, clientY: { value: 120 } });
  await act(async () => canvas.dispatchEvent(wheel));
  expect(image.style.transform).toContain('scale(0.864)');
  expect(image.style.transform).toContain('translate(10px, 10px)');
  const reverse = new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true });
  Object.defineProperties(reverse, { clientX: { value: 110 }, clientY: { value: 120 } });
  await act(async () => canvas.dispatchEvent(reverse));
  expect(image.style.transform).toContain('scale(0.9504)');
  const touch = (type: string, distance: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [
      { clientX: 110 - distance / 2, clientY: 120 },
      { clientX: 110 + distance / 2, clientY: 120 },
    ] });
    return event;
  };
  await act(async () => canvas.dispatchEvent(touch('touchstart', 100)));
  await act(async () => canvas.dispatchEvent(touch('touchmove', 200)));
  expect(image.style.transform).toContain('scale(1.9008)');
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close"]');
  if (!close) throw new Error('missing close button');
  await act(async () => close.click());
  await act(async () => open.click());
  const resetImage = document.querySelector<HTMLElement>('.mermaid-container[style*="transform"]');
  expect(resetImage?.style.transform).toBe('translate(0px, 0px) scale(0.8) rotate(0deg)');
});
