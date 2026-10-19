/**
 * ThemeScope writes its variables for its own subtree, and an overlay opened
 * inside it portals into the scope (so it inherits the scope's tokens) instead
 * of document.body. Rendered on happy-dom (the composer.test.tsx setup).
 */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeScope } from './theme-scope';

test('SSR renders the scope element with its scoped stylesheet', () => {
  const html = renderToStaticMarkup(
    <ThemeScope theme={{ light: { primary: '#4f46e5' }, dark: { primary: '#818cf8' }, radius: '0.25rem' }}>
      <p>inside</p>
    </ThemeScope>,
  );
  const id = /data-kortix-theme="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain(`[data-kortix-theme="${id}"]:not(.dark, .dark *) {`);
  expect(html).toContain('--primary: #4f46e5;');
  expect(html).toContain(`[data-kortix-theme="${id}"].dark, .dark [data-kortix-theme="${id}"] {`);
  expect(html).toContain('--primary: #818cf8;');
  expect(html).toContain('--radius: 0.25rem;');
  expect(html).toContain('<p>inside</p>');
});

test('a dialog opened inside the scope portals into it, one outside portals to body', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  const win = new Window({ url: 'https://example.test/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.getComputedStyle = win.getComputedStyle.bind(win);
  // Radix picks its layout-effect hook when the module loads, so it loads after the DOM globals.
  const { createRoot } = await import('react-dom/client');
  const DialogPrimitive = await import('@radix-ui/react-dialog');
  const { DialogPortal } = await import('../components/ui/dialog');
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container as never);
  const dialog = (testId: string) => (
    <DialogPrimitive.Root open modal={false}>
      <DialogPortal>
        <div data-testid={testId} />
      </DialogPortal>
    </DialogPrimitive.Root>
  );
  await act(async () => {
    root.render(
      <>
        <ThemeScope theme={{ radius: '0' }}>{dialog('inside')}</ThemeScope>
        {dialog('outside')}
      </>,
    );
  });
  const scope = container.querySelector('[data-kortix-theme]');
  const inside = win.document.querySelector('[data-testid="inside"]');
  const outside = win.document.querySelector('[data-testid="outside"]');
  expect(inside?.closest('[data-kortix-portal-host]')?.parentElement).toBe(scope);
  expect(outside?.closest('[data-kortix-theme]')).toBeNull();
  expect(outside?.parentElement).toBe(win.document.body);
  act(() => root.unmount());
});
