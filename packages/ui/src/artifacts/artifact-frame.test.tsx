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

test('frame claims expose the actual iframe without reclaiming when callback identity changes', async () => {
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
  const first: Array<HTMLIFrameElement | null> = [];
  const second: Array<HTMLIFrameElement | null> = [];
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
    frameKey: 'artifact:callback-test:immutable:annotate',
    src: 'https://content.example.test/page',
    title: 'Page',
  };
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, { ...props, onFrame: (frame) => first.push(frame) }),
    ),
  );
  expect(first).toHaveLength(1);
  expect(first[0]?.tagName).toBe('IFRAME');
  expect(first[0]?.src).toBe(props.src);
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, { ...props, onFrame: (frame) => second.push(frame) }),
    ),
  );
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
  await act(async () => root.render(null));
  expect(second).toEqual([null]);
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
  const oldKey = 'artifact:version-transition:current:annotate';
  const newKey = 'artifact:version-transition:historical:annotate';
  const exposed: Array<HTMLIFrameElement | null> = [];
  const props = {
    title: 'Versioned page',
    onFrame: (frame: HTMLIFrameElement | null) => exposed.push(frame),
  };
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, {
        ...props,
        frameKey: oldKey,
        src: 'https://content.example.test/current',
      }),
    ),
  );
  const oldFrame = exposed.at(-1)!;
  await act(async () =>
    root.render(
      createElement(ArtifactFrame, {
        ...props,
        frameKey: newKey,
        src: 'https://content.example.test/historical',
      }),
    ),
  );
  const newFrame = exposed.at(-1)!;
  expect(newFrame.dataset.frameKey).toBe(newKey);
  expect(newFrame !== oldFrame).toBe(true);
  expect(newFrame.src).toBe('https://content.example.test/historical');
  expect(newFrame.parentElement === (mount.firstElementChild as unknown as HTMLElement)).toBe(
    true,
  );
  expect(oldFrame.closest('[data-testid="app-preview-parking"]')).not.toBeNull();
  expect((page.document.activeElement as unknown as Element | null) === newFrame).toBe(true);
});
