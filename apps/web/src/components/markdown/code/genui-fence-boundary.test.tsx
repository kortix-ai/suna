import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { lazy, Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import * as toMarkdown from '@/features/genui/to-markdown';

import { GenuiFenceBoundary } from './markdown-code';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const CODE = 'root = Stack([a, b])\na = Stat("Revenue", "12k")\nb = Callout("info", "Book by Friday")';

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());
/** The chat with the block still empty: the fallback has not answered yet. */
const EMPTY = JSON.stringify({ type: 'div', props: { 'data-chat': '' }, children: [{ type: 'p', props: {}, children: ['Earlier reply'] }] });

let mounted: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = null;
});

/** Renders `child` inside one block's boundary; React's own error log for the caught throw is muted. */
async function renderBlock(child: React.ReactNode): Promise<ReactTestRenderer> {
  const original = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      mounted = create(
        <div data-chat="">
          <p>Earlier reply</p>
          <GenuiFenceBoundary code={CODE} version={1} streaming={false} trust="agent" variant="message">
            <Suspense fallback={null}>{child}</Suspense>
          </GenuiFenceBoundary>
        </div>,
      );
    });
    // The fallback converts through a dynamic import of the SDK barrel; a cold import takes more than a few ticks.
    for (let i = 0; i < 100 && textOf(mounted!) === EMPTY; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  } finally {
    console.error = original;
  }
  return mounted!;
}

describe('a generative UI block that fails renders as markdown, inside the chat', () => {
  test('a chunk that fails to load', async () => {
    const Missing = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /_next/static/chunks/genui.js')));
    const text = textOf(await renderBlock(<Missing />));
    expect(text).toContain('Earlier reply');
    expect(text).toContain('Revenue');
    expect(text).toContain('Book by Friday');
    expect(text).not.toContain('root = Stack');
  });

  test('a block that throws while rendering', async () => {
    const Broken = () => {
      throw new Error('render failed');
    };
    const text = textOf(await renderBlock(<Broken />));
    expect(text).toContain('Earlier reply');
    expect(text).toContain('Revenue');
    expect(text).not.toContain('root = Stack');
  });

  test('the markdown converter fails to load too: the raw fence source shows as a plain code block', async () => {
    const convert = spyOn(toMarkdown, 'genuiBlockText').mockImplementation(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    try {
      const Missing = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /_next/static/chunks/genui.js')));
      const text = textOf(await renderBlock(<Missing />));
      expect(convert).toHaveBeenCalled();
      expect(text).toContain('Earlier reply');
      expect(text).toContain('root = Stack');
      expect(text).toContain('Book by Friday');
    } finally {
      convert.mockRestore();
    }
  });
});
