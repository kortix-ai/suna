// A static type-only import, erased at runtime, so it can't disturb the
// registration order below — but it does make this file a MODULE. Without one,
// TS treats it as a script, top-level `await` is an error, and `screen`
// resolves to the DOM's `window.screen` (a `Screen`) instead of Testing
// Library's. Same trick `acp-config-option-pills.test.tsx` uses.
import type { ComponentProps } from 'react';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `acp-config-option-pills.test.tsx` establishes — a static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. The backdrop swatches
// are a click-driven state change, so a real DOM is the only way to assert what
// the canvas actually ends up looking like.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

// `ImageRenderer` calls `useTranslations('hardcodedUi')` unconditionally for
// its zoom labels; echoing the key back is enough for every assertion here.
mock.module('next-intl', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, {
      raw: (key: string) => key,
      rich: (key: string) => key,
      markup: (key: string) => key,
    }),
}));

const { ImageRenderer } = await import('./image-renderer');

afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** The scrollable/pannable surface the backdrop is painted on. */
function canvas(): HTMLElement {
  const img = screen.getByRole('img');
  const el = img.closest('div.relative.h-full.w-full') as HTMLElement | null;
  if (!el) throw new Error('canvas not found');
  return el;
}

function mount(props: Partial<ComponentProps<typeof ImageRenderer>> = {}) {
  return render(
    <TooltipProvider>
      <ImageRenderer url="blob:svg" fileName="logo.svg" {...props} />
    </TooltipProvider>,
  );
}

describe('backdrop swatches', () => {
  test('absent unless asked for — an opaque photo has one meaningful background', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'White background' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Transparent background' })).toBeNull();
  });

  test('all three appear together, transparent selected', () => {
    mount({ backdrop: true });
    expect(
      screen.getByRole('button', { name: 'Transparent background' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'White background' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      screen.getByRole('button', { name: 'Black background' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  test('picking one repaints the canvas and moves the selection', () => {
    mount({ backdrop: true });
    expect(canvas().className).toContain('bg-background');

    fireEvent.click(screen.getByRole('button', { name: 'White background' }));
    expect(canvas().className).toContain('bg-white');
    expect(
      screen.getByRole('button', { name: 'White background' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Transparent background' }).getAttribute('aria-pressed'),
    ).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Black background' }));
    expect(canvas().className).toContain('bg-black');
    expect(canvas().className).not.toContain('bg-white');

    fireEvent.click(screen.getByRole('button', { name: 'Transparent background' }));
    expect(canvas().className).toContain('bg-background');
    // Transparent is the only one that draws the checkerboard.
    expect(canvas().style.backgroundImage).toContain('repeating-conic-gradient');
  });

  test('the checkerboard only ever paints under transparent', () => {
    mount({ backdrop: true });
    fireEvent.click(screen.getByRole('button', { name: 'White background' }));
    expect(canvas().style.backgroundImage).toBe('');
  });
});

describe('control shelf visibility', () => {
  test("hover is the default, so the chrome stays out of the artwork's way", () => {
    mount();
    const shelf = screen.getByRole('button', { name: 'Rotate image' }).closest('[role=group]')
      ?.parentElement as HTMLElement;
    expect(shelf.className).toContain('opacity-0');
    expect(shelf.className).toContain('top-3');
  });

  test('always-on pins it open at the bottom, clear of the host toolbar', () => {
    mount({ controls: 'always' });
    const shelf = screen.getByRole('button', { name: 'Rotate image' }).closest('[role=group]')
      ?.parentElement as HTMLElement;
    // No opacity gate: hover never fires on touch, and the Easy panel is a
    // drawer there.
    expect(shelf.className).not.toContain('opacity-0');
    expect(shelf.className).toContain('bottom-3');
    expect(shelf.className).not.toContain('top-3');
  });
});
