/**
 * ThemeScope writes its variables for its own subtree, and an overlay opened
 * inside it portals into a themed host at the end of <body> (so it paints the
 * scope's tokens and no ancestor of the scope can clip it). Rendered on happy-dom (the composer.test.tsx setup).
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
  expect(html).toContain(`[data-kortix-theme~="${id}"]:not(.dark, .dark *) {`);
  expect(html).toContain('--primary: #4f46e5;');
  expect(html).toContain(`[data-kortix-theme~="${id}"].dark, .dark [data-kortix-theme~="${id}"] {`);
  expect(html).toContain('--primary: #818cf8;');
  expect(html).toContain('--radius: 0.25rem;');
  expect(html).toContain('<p>inside</p>');
});

test('the scope element holds only its children: no style or host child to break flex, grid or first:/last:', () => {
  const html = renderToStaticMarkup(
    <ThemeScope theme={{ radius: '0' }} className="flex gap-4">
      <p>a</p>
      <p>b</p>
    </ThemeScope>,
  );
  expect(html).toMatch(/^<style data-kortix-theme-style="">[^<]*<\/style><div data-kortix-theme="[^"]+" class="text-foreground font-sans flex gap-4"><p>a<\/p><p>b<\/p><\/div>$/);
});

test('quoted font stacks reach the stylesheet unescaped', () => {
  const html = renderToStaticMarkup(<ThemeScope theme={{ fonts: { sans: '"Avenir Next", sans-serif' } }} />);
  expect(html).toContain('--font-family-sans: "Avenir Next", sans-serif;');
  expect(html).not.toContain('&quot;');
});

test('overlays portal to a themed host in body; a nested scope host carries both scopes and forced dark', async () => {
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
  const { DialogPortal } = await import('../primitives/dialog');
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
        <ThemeScope theme={{ radius: '0' }} className="dark">
          {dialog('inside')}
          <ThemeScope theme={{ spacing: '0.2rem' }}>{dialog('nested')}</ThemeScope>
        </ThemeScope>
        {dialog('outside')}
      </>,
    );
  });
  const [outer, inner] = [...container.querySelectorAll('div[data-kortix-theme]')];
  const outerId = outer!.getAttribute('data-kortix-theme')!;
  const innerId = inner!.getAttribute('data-kortix-theme')!;
  const host = (testId: string) => win.document.querySelector(`[data-testid="${testId}"]`)?.closest('[data-kortix-portal-host]');
  const insideHost = host('inside');
  expect(insideHost?.parentElement).toBe(win.document.body);
  expect(insideHost?.getAttribute('data-kortix-theme')).toBe(outerId);
  expect(insideHost?.classList.contains('dark')).toBe(true);
  const nestedHost = host('nested');
  expect(nestedHost?.parentElement).toBe(win.document.body);
  expect(nestedHost?.getAttribute('data-kortix-theme')).toBe(`${outerId} ${innerId}`);
  expect(nestedHost?.classList.contains('dark')).toBe(true);
  const outside = win.document.querySelector('[data-testid="outside"]');
  expect(outside?.closest('[data-kortix-theme]')).toBeNull();
  expect(outside?.parentElement).toBe(win.document.body);
  expect(outer!.querySelector('[data-kortix-portal-host]')).toBeNull();
  act(() => root.unmount());
  expect(win.document.querySelector('[data-kortix-portal-host]')).toBeNull();
});
