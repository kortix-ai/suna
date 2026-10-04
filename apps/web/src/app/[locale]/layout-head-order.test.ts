import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The static head payloads render in one fixed order: the runtime-config boot
// script must precede everything that reads it, the desktop detection script
// must run before first paint, and GTM's dataLayer context must initialize
// before the GTM container loads. Nothing else pinned this order.
//
// The payloads live in `app/[locale]/layout.tsx` today; after the split into
// `components/root-head.tsx` they live there (the layout keeps only the
// `<head>` element around `<RootHead />`). The test reads BOTH files in render
// order (layout first, then the head component) and pins the marker sequence
// across them, so it passes unchanged on both sides of the move.
const WEB_SRC = resolve(import.meta.dir, '../..');

function readIfExists(relative: string): string {
  try {
    return readFileSync(resolve(WEB_SRC, relative), 'utf8');
  } catch {
    return '';
  }
}

const source = readIfExists('app/[locale]/layout.tsx') + readIfExists('components/root-head.tsx');

/** Marker → the head payload it identifies, in render order. */
const ORDER = [
  'window.__KORTIX_RUNTIME_CONFIG=',
  'DESKTOP_INIT_SCRIPT',
  'name="google" content="notranslate"',
  'rel="dns-prefetch" href="https://www.googletagmanager.com"',
  'rel="dns-prefetch" href="https://eu.i.posthog.com"',
  'window.dataLayer = window.dataLayer || []',
  'name="apple-itunes-app"',
  "'@type': 'Organization'",
  "'@type': 'SoftwareApplication'",
];

describe('root head payload order', () => {
  test('every static head payload renders, in the documented order', () => {
    let cursor = 0;
    for (const marker of ORDER) {
      const at = source.indexOf(marker, cursor);
      expect(at).toBeGreaterThan(-1);
      cursor = at + marker.length;
    }
  });

  test('the iOS smart-app banner renders only unless mobile advertising is disabled', () => {
    expect(source).toMatch(
      /!\s*featureFlags\.disableMobileAdvertising\s*\?\s*\(\s*<meta[\s\S]*?name="apple-itunes-app"/,
    );
  });

  test('the head element exists exactly once across the layout and the head component', () => {
    // Match the rendered element (its fixed indentation), not prose that
    // mentions it — the doc comment in root-head.tsx names `<head>` too.
    expect(source.split('      <head>').length - 1).toBe(1);
    expect(source.split('      </head>').length - 1).toBe(1);
  });

  test('the layout wires the head component inside its <head> element', () => {
    // The `<head>` opens and closes in the layout; the payloads themselves live
    // in the head component it renders there.
    const head = source.slice(source.indexOf('      <head>'), source.indexOf('      </head>'));
    expect(head).toContain('<RootHead');
  });
});
