import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

/**
 * A grid page holds up to 500 cards (KRTX-1723), and a live preview fetches
 * and renders its file. All 500 at once froze the Files page, so a card mounts
 * its preview only once it comes near the viewport.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rendered: string[] = [];
mock.module('@kortix/ui/shared/features/project-files/components/file-content-renderer', () => ({
  FileContentRenderer: ({ filePath }: { filePath: string }) => {
    rendered.push(filePath);
    return <pre>{filePath}</pre>;
  },
  getFileCategory: () => 'code',
}));
const { FileThumbnail, THUMBNAIL_NEAR_MARGIN } = await import('./file-thumbnail');

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: Array<{
  callback: Callback;
  margin?: string;
  observed: number;
  disconnected: boolean;
}>;
const saved = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  rendered.length = 0;
  observers = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    entry: (typeof observers)[number];
    constructor(callback: Callback, options?: { rootMargin?: string }) {
      this.entry = { callback, margin: options?.rootMargin, observed: 0, disconnected: false };
      observers.push(this.entry);
    }
    observe() {
      this.entry.observed += 1;
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  };
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = saved;
});

function mount(props: { deferPreview?: boolean } = {}) {
  act(() => {
    renderer = create(<FileThumbnail filePath="a/f0001.txt" fileName="f0001.txt" {...props} />, {
      createNodeMock: () => ({}),
    });
  });
}

describe('FileThumbnail near the viewport', () => {
  test('an offscreen card shows the placeholder and fetches nothing', () => {
    mount();
    expect(rendered).toEqual([]);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toBe(1);
    expect(observers[0]!.margin).toBe(THUMBNAIL_NEAR_MARGIN);
  });

  test('a card that comes near the viewport mounts its preview once, and stops observing', () => {
    mount();
    act(() => observers[0]!.callback([{ isIntersecting: false }]));
    expect(rendered).toEqual([]);
    act(() => observers[0]!.callback([{ isIntersecting: true }]));
    expect(rendered).toEqual(['a/f0001.txt']);
    expect(observers[0]!.disconnected).toBe(true);
    expect(observers).toHaveLength(1);
  });

  test('deferPreview keeps the placeholder and observes nothing', () => {
    mount({ deferPreview: true });
    expect(rendered).toEqual([]);
    expect(observers).toHaveLength(0);
  });

  test('without IntersectionObserver, the preview mounts at once', () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    mount();
    expect(rendered).toEqual(['a/f0001.txt']);
  });
});
