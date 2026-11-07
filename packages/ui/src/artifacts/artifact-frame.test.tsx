import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { ArtifactFrame } from './artifact-frame';
import { pruneFrames } from '../apps/app-preview-pool';

const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test('a claimed frame loads the page and sends only the app origin as referrer', async () => {
  const page = new Window({ url: 'https://app.example.test' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    'window',
    'document',
    'navigator',
    'Element',
    'HTMLElement',
    'HTMLIFrameElement',
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (page as any)[key],
    });
  }
  const { createRoot } = await import('react-dom/client');
  const mount = page.document.createElement('div');
  page.document.body.append(mount);
  const root = createRoot(mount as unknown as Element);
  cleanup = async () => {
    await act(async () => root.unmount());
    pruneFrames(new Set());
    await page.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const props = {
    frameKey: 'artifact:referrer-test:immutable',
    src: 'https://content.example.test/page',
    title: 'Page',
  };
  await act(async () => root.render(createElement(ArtifactFrame, props)));
  const frames = mount.querySelectorAll('iframe');
  expect(frames).toHaveLength(1);
  const frame = frames[0] as unknown as HTMLIFrameElement;
  expect(frame.dataset.frameKey).toBe(props.frameKey);
  expect(frame.src).toBe(props.src);
  // The page learns its host's origin, never the path with project ids.
  expect(frame.referrerPolicy).toBe('strict-origin');
});

test('changing an immutable frame key publishes and focuses the new claim before deferred old-frame parking', async () => {
  const page = new Window({ url: 'https://app.example.test' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    'window',
    'document',
    'navigator',
    'Element',
    'HTMLElement',
    'HTMLIFrameElement',
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (page as any)[key],
    });
  }
  const { createRoot } = await import('react-dom/client');
  const mount = page.document.createElement('div');
  page.document.body.append(mount);
  const root = createRoot(mount as unknown as Element);
  cleanup = async () => {
    await act(async () => root.unmount());
    pruneFrames(new Set());
    await page.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const oldKey = 'artifact:version-transition:current';
  const newKey = 'artifact:version-transition:historical';
  const frameOf = (key: string) =>
    page.document.querySelector(`iframe[data-frame-key="${key}"]`) as unknown as HTMLIFrameElement;
  const props = { title: 'Versioned page' };
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, {
        ...props,
        frameKey: oldKey,
        src: 'https://content.example.test/current',
      }),
    ),
  );
  const oldFrame = frameOf(oldKey);
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, {
        ...props,
        frameKey: newKey,
        src: 'https://content.example.test/historical',
      }),
    ),
  );
  const newFrame = frameOf(newKey);
  expect(newFrame.dataset.frameKey).toBe(newKey);
  expect(newFrame !== oldFrame).toBe(true);
  expect(newFrame.src).toBe('https://content.example.test/historical');
  expect(newFrame.parentElement === (mount.firstElementChild as unknown as HTMLElement)).toBe(
    true,
  );
  expect(oldFrame.closest('[data-testid="app-preview-parking"]')).not.toBeNull();
  expect((page.document.activeElement as unknown as Element | null) === newFrame).toBe(true);
});
