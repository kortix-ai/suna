import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Window } from 'happy-dom';
import { GameOfLife } from './game-of-life';

const win = new Window();
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
Object.defineProperty(globalThis, 'Image', {
  value: class { src = ''; onload = null; }, configurable: true,
});
let frames = 0;
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: () => ++frames, configurable: true,
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  value: () => undefined, configurable: true,
});
const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {} }) };
let root: ReactTestRenderer | undefined;
async function mount() {
  frames = 0;
  await act(async () => {
    root = create(createElement(GameOfLife), { createNodeMock: () => canvas });
  });
  expect(frames).toBe(1);
}
const settleResize = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

test('mounted resize reinitializes the canvas and restarts animation', async () => {
  await mount();
  win.innerWidth = 900;
  win.dispatchEvent(new win.Event('resize'));
  await settleResize();
  expect(canvas.width).toBe(900);
  expect(frames).toBe(2);
});

test('resize then unmount inside 250 ms never requests another frame', async () => {
  await mount();
  win.dispatchEvent(new win.Event('resize'));
  await act(async () => root?.unmount());
  root = undefined;
  await settleResize();
  expect(frames).toBe(1);
});
