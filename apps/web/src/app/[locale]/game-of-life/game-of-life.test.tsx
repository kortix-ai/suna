import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { GameOfLife } from './game-of-life';

const win = new Window({ width: 1000, height: 600 });
const images: DeferredImage[] = [];
class DeferredImage {
  width = 100;
  height = 50;
  src = '';
  onload: (() => void) | null = null;
  constructor() { images.push(this); }
  load() { this.onload?.(); }
}
const drawImage = mock(() => {});
const fillRect = mock(() => {});
let frames = 0;
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  Image: { value: DeferredImage, configurable: true },
  requestAnimationFrame: { value: () => ++frames, configurable: true },
  cancelAnimationFrame: { value: () => {}, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    fillRect,
    drawImage,
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }),
  }),
  configurable: true,
});

// Create the host through the installed document's DOM type, without casting
// happy-dom nodes across React's boundary.
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  await new Promise(resolve => setTimeout(resolve, 300));
  images.length = 0;
  drawImage.mockClear();
  fillRect.mockClear();
  win.innerWidth = 1000;
  frames = 0;
});

test('a cleaned-up desktop load cannot stamp over the current mobile logo', async () => {
  await act(async () => root.render(<GameOfLife />));
  const desktop = images[0];
  expect(desktop?.src).toContain('Logomark');
  await act(async () => {
    win.innerWidth = 500;
    win.dispatchEvent(new win.Event('resize'));
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(images).toHaveLength(2);
  const mobile = images.at(-1);
  expect(mobile?.src).toContain('Brandmark');
  mobile?.load();
  expect(drawImage).toHaveBeenCalledTimes(1);
  drawImage.mockClear();
  fillRect.mockClear();
  desktop?.load();
  expect(drawImage).not.toHaveBeenCalled();
  expect(fillRect).not.toHaveBeenCalled();
});

test('a pending load does no canvas work after unmount', async () => {
  await act(async () => root.render(<GameOfLife />));
  const pending = images[0];
  expect(pending).toBeDefined();
  win.dispatchEvent(new win.Event('resize'));
  await act(async () => root.render(null));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(images).toHaveLength(1);
  drawImage.mockClear();
  fillRect.mockClear();
  pending?.load();
  expect(drawImage).not.toHaveBeenCalled();
  expect(fillRect).not.toHaveBeenCalled();
});

test('a mounted resize reinitializes the canvas and restarts animation', async () => {
  await act(async () => root.render(<GameOfLife />));
  expect(frames).toBe(1);
  const canvas = host.querySelector('canvas');
  expect(canvas).toBeDefined();
  win.innerWidth = 900;
  await act(async () => win.dispatchEvent(new win.Event('resize')));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(canvas?.width).toBe(900);
  expect(frames).toBe(2);
});

test('a resize followed by an unmount inside the debounce window never requests another frame', async () => {
  await act(async () => root.render(<GameOfLife />));
  expect(frames).toBe(1);
  win.dispatchEvent(new win.Event('resize'));
  await act(async () => root.render(null));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(frames).toBe(1);
});
