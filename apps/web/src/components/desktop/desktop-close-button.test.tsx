import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DesktopCloseButton } from './desktop-close-button';

describe('DesktopCloseButton', () => {
  const html = renderToStaticMarkup(<DesktopCloseButton onClose={() => {}} />);

  test('is an icon-only button named Close', () => {
    // No visible word, so the accessible name has to come from aria-label.
    expect(html).toContain('<button');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-label="Close"');
  });

  test('carries the class that hides it outside the desktop shell', () => {
    // The web keeps the browser's own Back; only the shell needs this exit.
    expect(html).toContain('kx-desktop-back');
  });

  test('stays clickable inside a macOS drag region', () => {
    expect(html).toContain('[-webkit-app-region:no-drag]');
    expect(html).toContain('[app-region:no-drag]');
  });

  test('is the same height as the Log out control beside it', () => {
    // Button size `sm` is h-8; `icon-base` is size-8.
    expect(html).toContain('size-8');
  });
});
